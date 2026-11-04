import { scanUntrusted, scanSkillText } from "../gateway/firewall";
import type { GatewayBudget } from "../gateway/meta";
import { withWebAccess } from "../gateway/web";
import type { ValidSkill } from "../skills/package";
import { contentHash, validateSkillPackage } from "../skills/package";
import { searchWorkspace } from "../workspace/context";
import { acceptWorkspaceWrites, assertWorkspacePath, ROOT_FILES, writableWorkspacePath, type WorkspaceSnapshot } from "../workspace/snapshot";
import { moneyTool, nativeToolDefinitions, type ToolGrant } from "./catalog";

export const BODY_CAP = 3;
export const TURN_CAP = 4;

export type ToolCall = { callId: string; name: string; namespace?: string; arguments: Record<string, unknown> };

export type ModelStep = { responseId: string; text: string; calls: ToolCall[] };

export type SandboxJob = { files: { path: string; text: string }[]; entry: string };

export type SandboxResult = { ok: boolean; stdout: string; error?: string; files: { path: string; text: string }[] };

export type LoopResult = {
  text: string;
  loadedSkills: string[];
  results: { name: string; output: string }[];
  workspace: WorkspaceSnapshot;
};

export type ExtraTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
};

function namespaceMatches(item: Record<string, unknown>, query: string): boolean {
  if (!query) return true;
  if (String(item.name ?? "").toLowerCase().includes(query)) return true;
  const tools = Array.isArray(item.tools) ? item.tools : [];
  return tools.some((tool) => tool && typeof tool === "object" && String((tool as { name?: unknown }).name ?? "").toLowerCase().includes(query));
}

function arg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}\n[truncated]` : text;
}

function extraDefinitions(extra: ExtraTool[] | undefined): Record<string, unknown>[] {
  return (extra ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    defer_loading: false,
    parameters: tool.parameters,
  }));
}

/** One short label for the sparkles line while a tool is running. */
export function activityLabel(name: string, namespace?: string): string {
  if (namespace) return "Using a plugin";
  if (name === "run_hire") return "Hiring";
  if (name === "web_search" || name === "browser.search") return "Searching";
  if (name === "stage_owner_file" || name === "write_workspace") return "Writing a file";
  if (name === "read_workspace" || name === "list_workspace" || name === "search_workspace" || name === "read_skill" || name === "read_skill_file") return "Reading";
  if (name === "add_skill") return "Adding a skill";
  if (name === "ask_owner") return "Asking you";
  if (name === "make_image") return "Making an image";
  if (name === "transcribe_voice") return "Transcribing";
  if (name === "segment_image") return "Segmenting";
  return "Working";
}

export async function executeOwnerLoop(input: {
  message: string;
  prefix: string;
  skills: ValidSkill[];
  grants: ToolGrant[];
  approvedTools: string[];
  scriptGrants?: string[];
  workspace: WorkspaceSnapshot;
  budget: GatewayBudget;
  opening?: unknown;
  extraTools?: ExtraTool[];
  mcpNamespaces?: Record<string, unknown>[];
  web?: boolean;
  callMcp?: (namespace: string, name: string, args: Record<string, unknown>) => Promise<string>;
  callModel: (step: { previousResponseId?: string; instructions: string; input: unknown; tools: Record<string, unknown>[] }) => Promise<ModelStep>;
  runEntry: (job: SandboxJob) => Promise<SandboxResult>;
  proposeMemory?: (fact: string) => Promise<string>;
  stageOwnerFile?: (path: string, text: string) => Promise<string>;
  stopWhen?: () => boolean;
  onActivity?: (label: string) => void;
}): Promise<LoopResult> {
  const catalog = input.skills.map((skill) => `${skill.name}: ${skill.description}`).join("\n");
  const namespaces = input.mcpNamespaces ?? [];
  const pluginNote = namespaces.length > 0
    ? `\n\nConnected plugins: ${namespaces.map((item) => String(item.name)).join(", ")}. Use tool_search, then call the tool in that plugin.`
    : "";
  const webNote = input.web ? "\n\nWeb search is on. Use it when the owner asks for something current." : "";
  const instructions = `Owner configuration:\n${input.prefix}\n\nActive skills, name and description only:\n${catalog}${pluginNote}${webNote}`;
  const granted = new Set(input.grants.map((grant) => grant.name));
  const tools = withWebAccess([
    ...nativeToolDefinitions([...granted]),
    ...extraDefinitions(input.extraTools),
    ...namespaces,
  ], input.web === true);
  const loaded = new Set<string>();
  const results: { name: string; output: string }[] = [];
  let workspace = input.workspace;
  let previousResponseId: string | undefined;
  let modelInput: unknown = input.opening ?? input.message;
  let text = "";
  let usedTool = false;
  let needsWords = false;
  let unsentOutputs = false;
  for (let round = 0; round < TURN_CAP; round += 1) {
    if (input.budget.remainingCalls <= 0 || input.budget.remainingTokens <= 0) throw new Error("Agent budget is exhausted.");
    input.onActivity?.(usedTool ? "Replying" : "Thinking");
    const step = await input.callModel({ previousResponseId, instructions, input: modelInput, tools });
    input.budget.remainingCalls -= 1;
    previousResponseId = step.responseId;
    if (step.text.trim()) text = step.text;
    if (step.calls.length === 0) {
      needsWords = usedTool && !step.text.trim();
      unsentOutputs = false;
      break;
    }
    const outputs: { type: string; call_id: string; output?: string; tools?: Record<string, unknown>[] }[] = [];
    for (const call of step.calls) {
      input.onActivity?.(activityLabel(call.name, call.namespace));
      usedTool = true;
      const output = await runCall(call, input, granted, loaded, workspace, (next) => {
        workspace = next;
      });
      results.push({ name: call.name, output });
      if (call.name === "tool_search") {
        const query = arg(call.arguments.query).toLowerCase();
        outputs.push({
          type: "tool_search_output",
          call_id: call.callId,
          tools: [
            ...nativeToolDefinitions([...granted].filter((name) => name !== "tool_search")),
            ...extraDefinitions(input.extraTools),
            ...namespaces.filter((item) => namespaceMatches(item, query)),
          ],
        });
      } else {
        outputs.push({ type: "function_call_output", call_id: call.callId, output });
      }
    }
    if (input.stopWhen?.()) {
      needsWords = false;
      break;
    }
    modelInput = outputs;
    needsWords = true;
    unsentOutputs = true;
  }
  if (needsWords && input.budget.remainingCalls > 0 && input.budget.remainingTokens > 0) {
    input.onActivity?.("Replying");
    const step = await input.callModel({
      previousResponseId,
      instructions,
      input: unsentOutputs ? modelInput : "Answer the owner in words, using what the tools returned.",
      tools: [],
    });
    input.budget.remainingCalls -= 1;
    if (step.text.trim()) text = step.text;
  }
  if (!text.trim()) {
    const last = results[results.length - 1]?.output.trim() ?? "";
    if (last) text = clip(last);
  }
  return { text, loadedSkills: [...loaded], results, workspace };
}

function sandboxFiles(files: { path: string; text: string }[]): { path: string; text: string }[] {
  const blocked = new Set<string>(ROOT_FILES);
  return files.filter((file) => !blocked.has(file.path) && !file.path.split("/").includes(".."));
}

function proposalFiles(workspace: WorkspaceSnapshot, name: string): { path: string; text: string }[] {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return [];
  const prefix = `skills/proposals/${name}/`;
  return workspace.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ path: file.path.slice(prefix.length), text: file.text }));
}

async function applyJobResult(workspace: WorkspaceSnapshot, result: SandboxResult, setWorkspace: (next: WorkspaceSnapshot) => void): Promise<string> {
  if (!result.ok) return result.error || "The script did not run.";
  const scan = scanSkillText(result.stdout);
  if (!scan.allow) return scan.reason;
  if (result.files.length > 0) {
    try {
      setWorkspace(acceptWorkspaceWrites(workspace, result.files));
    } catch (error) {
      return error instanceof Error ? error.message : "That path is outside the workspace.";
    }
  }
  return clip(result.stdout);
}

async function runCall(
  call: ToolCall,
  input: {
    skills: ValidSkill[];
    grants: ToolGrant[];
    approvedTools: string[];
    scriptGrants?: string[];
    runEntry: (job: SandboxJob) => Promise<SandboxResult>;
    proposeMemory?: (fact: string) => Promise<string>;
    stageOwnerFile?: (path: string, text: string) => Promise<string>;
    extraTools?: ExtraTool[];
    mcpNamespaces?: Record<string, unknown>[];
    callMcp?: (namespace: string, name: string, args: Record<string, unknown>) => Promise<string>;
  },
  granted: Set<string>,
  loaded: Set<string>,
  workspace: WorkspaceSnapshot,
  setWorkspace: (next: WorkspaceSnapshot) => void,
): Promise<string> {
  if (call.namespace) {
    const known = (input.mcpNamespaces ?? []).some((item) => item.name === call.namespace);
    if (!known || !input.callMcp) return "That server is not connected.";
    if (moneyTool(call.name)) return "Money movement stays with the owner.";
    const text = await input.callMcp(call.namespace, call.name, call.arguments);
    const scan = scanUntrusted(text);
    if (!scan.allow) return scan.reason;
    return clip(text);
  }
  if (moneyTool(call.name)) return "Money movement stays with the owner.";
  const extra = input.extraTools?.find((tool) => tool.name === call.name);
  if (extra) return extra.run(call.arguments);
  if (call.name === "tool_search") {
    const query = arg(call.arguments.query).toLowerCase();
    const names = [...granted, ...(input.extraTools ?? []).map((tool) => tool.name)].filter((name) => !query || name.includes(query));
    return names.join("\n");
  }
  const grant = input.grants.find((item) => item.name === call.name);
  if (!grant || !granted.has(call.name)) return "That tool is not granted.";
  if (grant.approval === "required" && !input.approvedTools.includes(call.name)) return "The owner has not approved this tool.";
  if (call.name === "read_skill") {
    const skill = input.skills.find((item) => item.name === arg(call.arguments.name));
    if (!skill) return "That skill is not active.";
    if (!loaded.has(skill.name) && loaded.size >= BODY_CAP) return "The skill body cap is reached.";
    loaded.add(skill.name);
    const scan = scanSkillText(skill.body);
    if (!scan.allow) return scan.reason;
    return clip(skill.body);
  }
  if (call.name === "read_skill_file") {
    const skill = input.skills.find((item) => item.name === arg(call.arguments.name));
    const file = skill?.files.find((item) => item.path === arg(call.arguments.path));
    if (!skill || !file) return "That file is not in the active revision.";
    return clip(file.text);
  }
  if (call.name === "list_workspace") return workspace.files.map((file) => file.path).join("\n");
  if (call.name === "read_workspace") {
    const path = arg(call.arguments.path);
    try {
      assertWorkspacePath(path);
    } catch (error) {
      return error instanceof Error ? error.message : "That path is outside the workspace.";
    }
    const file = workspace.files.find((item) => item.path === path);
    if (!file) return "That file is not in the workspace.";
    return clip(file.text);
  }
  if (call.name === "search_workspace") {
    const hits = searchWorkspace(workspace.files, arg(call.arguments.query));
    if (hits.length === 0) return "No matching workspace file.";
    return clip(hits.map((hit) => `${hit.path}\n${hit.excerpt}`).join("\n\n"));
  }
  if (call.name === "stage_owner_file") {
    if (!input.stageOwnerFile) return "That tool is not granted.";
    return input.stageOwnerFile(arg(call.arguments.path), arg(call.arguments.text));
  }
  if (call.name === "propose_memory") {
    if (!input.proposeMemory) return "Memory changes wait for the owner.";
    return input.proposeMemory(arg(call.arguments.fact));
  }
  if (call.name === "write_workspace") {
    const path = arg(call.arguments.path);
    const text = arg(call.arguments.text);
    if (!writableWorkspacePath(path)) {
      try {
        assertWorkspacePath(path);
        return "That file stays with the owner.";
      } catch (error) {
        return error instanceof Error ? error.message : "That path is outside the workspace.";
      }
    }
    try {
      setWorkspace(acceptWorkspaceWrites(workspace, [{ path, text }]));
    } catch (error) {
      return error instanceof Error ? error.message : "That path is outside the workspace.";
    }
    return path.startsWith("memory/") ? "Appended the daily log." : "Wrote the file.";
  }
  if (call.name === "run_entry") {
    const skillName = arg(call.arguments.skill);
    const path = arg(call.arguments.path);
    const skill = input.skills.find((item) => item.name === skillName);
    if (skill) {
      const file = skill.files.find((item) => item.path === path);
      if (!file || !skill.manifest.entry.includes(path) || contentHash(file.text) !== file.hash) {
        return "That script is not an approved entry.";
      }
      if (skill.manifest.workflow.length > 0 && !skill.manifest.workflow.some((step) => step.tool === "run_entry" && step.script === path)) {
        return "That tool is outside this skill's workflow.";
      }
      if (input.scriptGrants && !input.scriptGrants.includes("run_entry")) return "That tool is not granted.";
      if (!skill.manifest.requests.tools.includes("run_entry")) return "That tool is not granted.";
      const result = await input.runEntry({ files: sandboxFiles(skill.files.map(({ path: filePath, text }) => ({ path: filePath, text }))), entry: path });
      return applyJobResult(workspace, result, setWorkspace);
    }
    const proposed = proposalFiles(workspace, skillName);
    if (proposed.length === 0) return "That skill is not active.";
    let packed: ValidSkill;
    try {
      packed = validateSkillPackage(proposed);
    } catch (error) {
      return error instanceof Error ? error.message : "That proposal is not a skill package.";
    }
    if (packed.name !== skillName) return "That skill is not active.";
    const file = packed.files.find((item) => item.path === path);
    if (!file || !packed.manifest.entry.includes(path) || contentHash(file.text) !== file.hash) {
      return "That script is not an approved entry.";
    }
    if (packed.manifest.workflow.length > 0 && !packed.manifest.workflow.some((step) => step.tool === "run_entry" && step.script === path)) {
      return "That tool is outside this skill's workflow.";
    }
    if (!packed.manifest.requests.tools.includes("run_entry")) return "That tool is not granted.";
    const result = await input.runEntry({ files: sandboxFiles(packed.files.map(({ path: filePath, text }) => ({ path: filePath, text }))), entry: path });
    return applyJobResult(workspace, result, setWorkspace);
  }
  return "That tool is not granted.";
}
