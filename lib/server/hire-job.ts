import { WORKER_PLATFORM } from "../agent/platform";
import { jobLogLine } from "../deal/progress";
import { getAddress, type Address } from "viem";
import { aesDecrypt, decodeText, unwrapKey, wrapKey } from "../crypto/aes";
import { assertModel, responseText } from "../gateway/meta";
import { scanHireText, scannerBlocksSeal } from "../gateway/llama";
import { taskRefusal } from "../gateway/models";
import { appSecret } from "./app-secret";
import { markJobFinished, markJobRunning, withDesk } from "./desk";
import { openTaskBudget } from "./budget";
import { runModalJob } from "./modal-job";
import { publishHireStatus } from "./hire-status";
import { publicAgent } from "./register";
import { agentPreferredModel } from "./teach";
import { activeSkills } from "./skills";
import { readDocument } from "../db";
import { chatImageKey, MAX_IMAGE_DATA_URL } from "../deal/forward";
import type { Network, TaskRecord } from "../world/network";

export const JOB_TURN_CAP = 6;

export type JobFile = { path: string; text: string };

export type JobDecision = { files: JobFile[]; command: string[]; done: boolean };

export type SandboxJob = { files: JobFile[]; writes: JobFile[]; command: string[] };

export type SandboxResult = { ok: boolean; stdout: string; error?: string; files: JobFile[] };

type ModelResponse = { output_text?: string; output?: unknown[] };

const PRIVATE_FILE = /(^|\/)(USER|MEMORY)\.md$/;

const inflight = new Set<string>();

export function jobPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts.length > 8 || path.length > 240) return false;
  return true;
}

export function referenceSkillFiles(skills: { files: { path: string; text: string }[] }[]): JobFile[] {
  return skills
    .flatMap((skill) => skill.files.filter((file) => !PRIVATE_FILE.test(file.path)))
    .slice(0, 8)
    .map((file) => ({ path: file.path, text: file.text }));
}

/** The hired job sees the deal, the skill text, and the sandbox. Owner notes are not an argument. */
export function jobPrompt(input: { criteria: string; skills: JobFile[]; files: JobFile[]; lastOutput: string; revision: boolean }): string {
  const skills = input.skills.map((file) => `${file.path}\n${file.text.slice(0, 2000)}`).join("\n\n");
  const listing = input.files.map((file) => file.path).join("\n");
  return [
    WORKER_PLATFORM,
    "Write the delivery files here. Run one command when the work needs to be tested.",
    "Owner notes stay out of this job.",
    input.revision ? "The hirer sent this delivery back. Revise the work." : "",
    `Deal:\n${input.criteria}`,
    skills ? `Reference skills, read only:\n${skills}` : "",
    listing ? `Sandbox files:\n${listing}` : "Sandbox files:\nnone",
    input.files.some((file) => file.path.startsWith("inputs/")) ? "Files under inputs/ were attached by the hirer. Use those paths in the delivery." : "",
    input.lastOutput ? `Last command output:\n${input.lastOutput.slice(0, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function acceptJobDecision(value: unknown): JobDecision | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.done !== "boolean" || !Array.isArray(record.files) || !Array.isArray(record.command)) return null;
  const files: JobFile[] = [];
  for (const item of record.files) {
    if (!item || typeof item !== "object") return null;
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.text !== "string") return null;
    files.push({ path: file.path, text: file.text });
  }
  const command: string[] = [];
  for (const part of record.command) {
    if (typeof part !== "string") return null;
    command.push(part);
  }
  return { files, command, done: record.done };
}

export async function loadHireInputFiles(inputs: { path: string; imageId: string; sourceAgentId: string }[] | undefined): Promise<JobFile[]> {
  const files: JobFile[] = [];
  for (const item of inputs ?? []) {
    if (!item.path.startsWith("inputs/") || !/^[a-f0-9]+$/.test(item.imageId)) continue;
    const raw = await readDocument(chatImageKey(item.sourceAgentId, item.imageId));
    if (!raw?.startsWith("data:image/") || raw.length > MAX_IMAGE_DATA_URL) throw new Error("The attached image is missing.");
    files.push({ path: item.path, text: raw });
  }
  return files;
}

export function parseBundle(plaintext: string): JobFile[] {
  const parsed = JSON.parse(plaintext) as { files?: JobFile[] };
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) throw new Error("The hire did not produce a delivery.");
  return parsed.files.filter((file) => file && typeof file.path === "string" && typeof file.text === "string");
}

export async function readSealedPlaintext(net: Network, task: TaskRecord): Promise<string> {
  if (!task.artifactCid || !task.artifactKeyWrap) throw new Error("The delivery stays sealed until you confirm.");
  const key = await unwrapKey(task.artifactKeyWrap, appSecret());
  const sealed = JSON.parse(decodeText(await net.fetchPin(task.artifactCid))) as { iv: string; ciphertext: string };
  return decodeText(await aesDecrypt(key, sealed.iv, sealed.ciphertext));
}

export async function ensureArtifactKey(net: Network, cid: string): Promise<void> {
  if (net.artifactReaders(cid)) return;
  const task = [...net.tasks.values()].find((item) => item.artifactCid === cid);
  if (!task?.artifactKeyWrap || !task.artifactReaders?.length) return;
  const key = await unwrapKey(task.artifactKeyWrap, appSecret());
  net.restoreArtifactKey(cid, key, task.artifactReaders);
}

export async function runJobTurns(input: {
  criteria: string;
  longHorizon: boolean;
  skills: JobFile[];
  initial: JobFile[];
  revision: boolean;
  callModel: (instruction: string, longHorizon: boolean) => Promise<JobDecision>;
  runSandbox: (job: SandboxJob) => Promise<SandboxResult>;
  onStep?: (step: { turn: number; paths: string[]; command: string[]; output: string; done: boolean; skipped?: string }) => Promise<void> | void;
}): Promise<JobFile[]> {
  let files = input.initial;
  let lastOutput = "";
  for (let turn = 0; turn < JOB_TURN_CAP; turn += 1) {
    const decision = await input.callModel(
      jobPrompt({ criteria: input.criteria, skills: input.skills, files, lastOutput, revision: input.revision }),
      input.longHorizon,
    );
    const writes = usableWrites(decision.files);
    const checked = usableCommand(decision.command);
    const command = checked.command;
    if (writes.length > 0 || command.length > 0) {
      const result = await input.runSandbox({ files, writes, command });
      if (!result.ok && result.files.length === 0) throw new Error(result.error || "The sandbox did not run.");
      if (result.files.length > 0) files = result.files;
      lastOutput = [result.stdout, result.error].filter(Boolean).join("\n").slice(0, 4000);
    }
    await input.onStep?.({
      turn: turn + 1,
      paths: writes.map((file) => file.path),
      command,
      output: lastOutput,
      done: decision.done,
      skipped: checked.skipped,
    });
    if (decision.done) break;
  }
  if (files.length === 0) throw new Error("The hire did not produce a delivery.");
  return files;
}

export async function sealHireDelivery(net: Network, task: TaskRecord, files: JobFile[], supervisorWallet: Address): Promise<void> {
  if (!task.lock) throw new Error("This task has no escrow lock.");
  const supervisor = getAddress(supervisorWallet);
  if (supervisor === getAddress(task.lock.payer) || supervisor === getAddress(task.lock.receiver)) {
    throw new Error("The supervisor must be a different agent from the hiring agent and the hired agent.");
  }
  const artifact = await net.putArtifact({
    plaintext: JSON.stringify({ files }),
    readers: [supervisor],
    taskId: task.id,
  });
  const key = net.artifactKeyBytes(artifact.cid);
  if (!key) throw new Error("The delivery could not be sealed.");
  task.artifactCid = artifact.cid;
  task.artifactKeyWrap = await wrapKey(key, appSecret());
  task.artifactReaders = artifact.manifest.readers;
  task.deliveryReleased = false;
  task.jobError = null;
  task.supervisorReport = null;
  task.supervisorSuggestion = null;
  task.status = "delivered";
}

export function startHireJob(taskId: string): Promise<void> {
  if (inflight.has(taskId)) return Promise.resolve();
  inflight.add(taskId);
  markJobRunning(taskId);
  return runHireJob(taskId).finally(() => {
    inflight.delete(taskId);
    markJobFinished(taskId);
  });
}

export async function runHireJob(
  taskId: string,
  hooks?: {
    callModel?: (instruction: string, longHorizon: boolean) => Promise<JobDecision>;
    runSandbox?: (job: SandboxJob) => Promise<SandboxResult>;
    supervisorWallet?: Address;
    scanText?: (text: string, kind: "text" | "code") => Promise<{ allow: boolean; reason: string; llama?: string }>;
  },
): Promise<void> {
  const scan = hooks?.scanText ?? scanHireText;
  const opened = await withDesk(async (net) => {
    const task = net.tasks.get(taskId);
    if (!task?.lock) return null;
    const revision = task.status === "revision" && Boolean(task.artifactCid);
    if (!revision && (task.status !== "authorized" || task.artifactCid)) return null;
    const previous = {
      cid: task.artifactCid,
      wrap: task.artifactKeyWrap,
      readers: task.artifactReaders,
      report: task.supervisorReport,
      suggestion: task.supervisorSuggestion,
    };
    let initial: JobFile[] = [];
    if (revision) {
      try {
        initial = parseBundle(await readSealedPlaintext(net, task));
      } catch (error) {
        task.jobError = jobMessage(error);
        return null;
      }
    }
    task.status = "running";
    task.jobError = null;
    noteJob(task, revision ? "The hirer sent the delivery back. The worker is revising it." : "The worker started. The delivery stays sealed until you confirm.");
    return {
      revision,
      previous,
      initial,
      criteria: task.criteria,
      inputs: task.inputs ?? [],
      longHorizon: task.longHorizon === true,
      workerAgentId: task.workerAgentId,
      supervisorAgentId: task.supervisorAgentId ?? "",
    };
  });
  if (!opened) return;
  await openTaskBudget(taskId);
  await publishHireStatus(taskId);
  try {
    const criteriaScan = await scan(opened.criteria, "text");
    if (scannerBlocksSeal(criteriaScan)) throw new Error(criteriaScan.reason);
    const skills = await activeSkills(opened.workerAgentId);
    const attached = opened.revision ? [] : await loadHireInputFiles(opened.inputs);
    const files = await runJobTurns({
      criteria: opened.criteria,
      longHorizon: opened.longHorizon,
      skills: referenceSkillFiles(skills),
      initial: [...attached, ...opened.initial],
      revision: opened.revision,
      callModel: hooks?.callModel ?? ((instruction, flagged) => jobModel(instruction, flagged, opened.workerAgentId)),
      runSandbox: hooks?.runSandbox ?? (async (job) => runModalJob(job)),
      onStep: async (step) => {
        if (step.output.trim()) {
          const outputScan = await scan(step.output, "text");
          if (scannerBlocksSeal(outputScan)) throw new Error(outputScan.reason);
        }
        await withDesk(async (net) => {
          const current = net.tasks.get(taskId);
          if (!current) return;
          noteJob(current, jobLogLine(step));
        });
      },
    });
    const wallet = hooks?.supervisorWallet ?? getAddress((await publicAgent(opened.supervisorAgentId)).agentWallet);
    await withDesk(async (net) => {
      const sealed = net.tasks.get(taskId);
      if (!sealed) return;
      await sealHireDelivery(net, sealed, files, wallet);
      noteJob(sealed, "The delivery is sealed.");
    });
    await publishHireStatus(taskId);
  } catch (error) {
    await withDesk(async (net) => {
      const current = net.tasks.get(taskId);
      if (!current) return;
      current.jobError = jobMessage(error);
      noteJob(current, current.jobError);
      if (opened.revision && opened.previous.cid) {
        current.status = "revision";
        current.artifactCid = opened.previous.cid;
        current.artifactKeyWrap = opened.previous.wrap;
        current.artifactReaders = opened.previous.readers;
        current.supervisorReport = opened.previous.report ?? null;
        current.supervisorSuggestion = opened.previous.suggestion ?? null;
      } else {
        current.status = "authorized";
        current.artifactCid = null;
        current.artifactKeyWrap = undefined;
        current.artifactReaders = undefined;
      }
    });
    await publishHireStatus(taskId);
  }
}

async function jobModel(instruction: string, longHorizon: boolean, workerAgentId: string): Promise<JobDecision> {
  const model = await agentPreferredModel(workerAgentId, longHorizon);
  const refusal = taskRefusal(model);
  if (refusal) throw new Error(refusal);
  assertModel(model, longHorizon);
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key) throw new Error("The model key is missing. USDC stays locked.");
  const response = await fetch("https://api.meta.ai/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: instruction,
      text: {
        format: {
          type: "json_schema",
          name: "job_turn",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              files: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: { path: { type: "string" }, text: { type: "string" } },
                  required: ["path", "text"],
                },
              },
              command: { type: "array", items: { type: "string" } },
              done: { type: "boolean" },
            },
            required: ["files", "command", "done"],
          },
        },
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Meta gateway failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as ModelResponse;
  const decision = acceptJobDecision(JSON.parse(responseText(json) || "{}"));
  if (!decision) throw new Error("The hire did not return a usable step.");
  return decision;
}

function usableWrites(files: JobFile[]): JobFile[] {
  if (files.length > 200) throw new Error("This sandbox is too large.");
  return files.map((file) => {
    if (!jobPath(file.path) || file.text.length > 64_000) throw new Error("That path is outside the sandbox.");
    return file;
  });
}

function usableCommand(command: string[]): { command: string[]; skipped: string } {
  if (command.length === 0) return { command: [], skipped: "" };
  const invalid = command.length > 8 || command.some((part) => !part || part.length > 200 || /[\n\r\0]/.test(part));
  if (invalid) return { command: [], skipped: "The worker proposed a command that was not a program and arguments. It was not run." };
  return { command, skipped: "" };
}

function noteJob(task: TaskRecord, text: string): void {
  task.jobLog ??= [];
  task.jobLog.push({ at: new Date().toISOString(), text: text.slice(0, 400) });
  if (task.jobLog.length > 24) task.jobLog.splice(0, task.jobLog.length - 24);
}

function jobMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "The sandbox did not run.";
  return text.slice(0, 240);
}
