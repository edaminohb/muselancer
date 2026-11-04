import { spawnSync } from "node:child_process";
import { compileOwnerPrefix, preferredModel } from "../agent/profile";
import { OWNER_PLATFORM } from "../agent/platform";
import { conversationModel, performsTasks } from "../gateway/models";
import { specialtyOf } from "./chat-reply";
import { ownerHireTool } from "./deal";
import { ownerModelStep, type GatewayBudget } from "../gateway/meta";
import { namespaceTools } from "../mcp/bridge";
import { grantsForActiveSkills, type ToolGrant } from "../tools/catalog";
import { executeOwnerLoop, type SandboxResult } from "../tools/loop";
import { loadOwnerContext } from "../workspace/context";
import { callConnectedTool, connectionsForSkills, readConnections } from "./connections";
import { webEnabled } from "./web-access";
import { activeSkills, readOwnedSkills } from "./skills";
import { addMemoryProposal, readOwnedProfile } from "./teach";
import { commitWorkspace, ensureWorkspace } from "./workspace";

export class TurnError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function runModalSandbox(job: { files: { path: string; text: string }[]; entry: string }): SandboxResult {
  if (!process.env.MODAL_TOKEN_ID?.trim() || !process.env.MODAL_TOKEN_SECRET?.trim()) {
    throw new TurnError("Set MODAL_TOKEN_ID to run a skill script.", 503);
  }
  const python = process.env.PYTHON ?? "python";
  const result = spawnSync(python, ["runtime/modal_remote.py"], {
    input: JSON.stringify(job),
    encoding: "utf8",
    cwd: process.cwd(),
    timeout: 300_000,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "Modal did not run the script.").trim();
    throw new TurnError(detail.split("\n").slice(-4).join(" ") || "Modal did not run the script.", 502);
  }
  const parsed = JSON.parse(result.stdout || "{}") as SandboxResult;
  return { ok: parsed.ok === true, stdout: parsed.stdout ?? "", error: parsed.error, files: parsed.files ?? [] };
}

export async function handleOwnerTurn(owner: string, agentId: string, body: unknown, budget: GatewayBudget): Promise<{
  text: string;
  loadedSkills: string[];
  results: { name: string; output: string }[];
  workspaceCid: string;
}> {
  const command = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = typeof command.message === "string" ? command.message.trim() : "";
  if (!message) throw new TurnError("Say what this agent should do.", 400);
  if (message.length > 4000) throw new TurnError("That request is too long.", 400);
  const longHorizon = command.longHorizon === true;
  const startup = command.startup === true;
  const approvedTools = Array.isArray(command.approvedTools) ? command.approvedTools.filter((item): item is string => typeof item === "string") : [];
  const profile = await readOwnedProfile(owner, agentId);
  const { installs } = await readOwnedSkills(owner, agentId);
  const skills = await activeSkills(agentId);
  const seeded = await ensureWorkspace(agentId, {
    name: profile.identity.displayName || "Agent",
    description: profile.identity.description,
  });
  const context = loadOwnerContext(seeded.tree.files, {
    startup,
    bootstrapComplete: seeded.pointer.bootstrapComplete,
    query: message,
  });
  const registered = preferredModel(profile.models, longHorizon);
  const doesTasks = performsTasks(registered);
  const specialty = specialtyOf(registered);
  const skillGrants = doesTasks ? grantsForActiveSkills(installs) : [];
  const hasProposal = seeded.tree.files.some((file) => /^skills\/proposals\/[^/]+\/SKILL\.md$/.test(file.path));
  const baseGrants: ToolGrant[] = [
    { name: "read_workspace", approval: "preapproved" },
    { name: "search_workspace", approval: "preapproved" },
    { name: "list_workspace", approval: "preapproved" },
    { name: "propose_memory", approval: "preapproved" },
  ];
  if (doesTasks) baseGrants.push({ name: "write_workspace", approval: "required" });
  if (doesTasks && hasProposal) baseGrants.push({ name: "run_entry", approval: "required" });
  const grantedNames = new Set(baseGrants.map((grant) => grant.name));
  const chatModel = doesTasks ? registered : conversationModel(registered);
  const limit = specialty
    ? "Muse Spark writes this conversation and does not do the task. Do not write HTML or code. If the owner asks you to do the work yourself, say this agent does not do that task. Call run_hire only when the owner asks to hire another agent."
    : "run_hire is granted. Call it when the owner asks to hire. Do not say it is missing.";
  const loop = await executeOwnerLoop({
    message,
    prefix: `${context}\n\n${compileOwnerPrefix(profile)}\n\n${OWNER_PLATFORM}\n${limit}\nGranted this turn: ${baseGrants.map((grant) => grant.name).join(", ")}, run_hire.`,
    extraTools: [ownerHireTool(owner, agentId)],
    mcpNamespaces: namespaceTools(connectionsForSkills(await readConnections(agentId), doesTasks ? skills : [])),
    web: await webEnabled(agentId),
    callMcp: (namespace, name, args) => callConnectedTool(agentId, namespace, name, args),
    skills: doesTasks ? skills : [],
    grants: [...baseGrants, ...skillGrants.filter((grant) => !grantedNames.has(grant.name))],
    scriptGrants: skillGrants.map((grant) => grant.name),
    approvedTools,
    workspace: seeded.tree,
    budget,
    callModel: (step) => ownerModelStep({ model: chatModel, longHorizon, budget, ...step }),
    runEntry: async (job) => {
      if (!doesTasks) throw new TurnError("This agent does not do that task. The text model does not do the work.", 400);
      return runModalSandbox(job);
    },
    proposeMemory: (fact) => addMemoryProposal(owner, agentId, fact),
  });
  const pointer = await commitWorkspace(agentId, () => loop.workspace, "agent", seeded.pointer.cid);
  return { text: loop.text, loadedSkills: loop.loadedSkills, results: loop.results, workspaceCid: pointer.cid };
}

export function turnFailure(error: unknown): { message: string; status: number } {
  if (error instanceof TurnError) return { message: error.message, status: error.status };
  const message = error instanceof Error ? error.message : "Could not run this turn.";
  const status = message.startsWith("The model key is missing") ? 409 : 400;
  return { message, status };
}
