import { encodeText, decodeText } from "../crypto/aes";
import { scanSkillText } from "../gateway/firewall";
import type { Network } from "../world/network";

export type WorkspaceFile = { path: string; text: string };

export type WorkspaceSnapshot = { files: WorkspaceFile[] };

export const ROOT_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md", "MEMORY.md", "BOOT.md", "BOOTSTRAP.md"] as const;

const TOPS = new Set(["config", "skills", "knowledge", "projects", "files", "memory", "tasks", "workflows"]);
const AGENT_TREE_TOPS = new Set(["knowledge", "projects", "files", "tasks"]);
const OWNER_TREE_TOPS = new Set(["knowledge", "projects", "files", "memory", "tasks", "config", "workflows"]);

export type AgentWriteClass = "proposal" | "tree" | "append" | "denied";

export function todayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function assertWorkspacePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("That path is outside the workspace.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts.length > 8 || path.length > 240) {
    throw new Error("That path is outside the workspace.");
  }
  if ((ROOT_FILES as readonly string[]).includes(path)) return;
  const top = parts[0] ?? "";
  if (!TOPS.has(top) || parts.length < 2) throw new Error("That path is outside the workspace.");
  if (top === "skills") {
    const bucket = parts[1] ?? "";
    if (!["active", "disabled", "proposals"].includes(bucket) || parts.length < 4) {
      throw new Error("That path is outside the workspace.");
    }
  }
}

export function agentWriteClass(path: string, now = new Date()): AgentWriteClass {
  assertWorkspacePath(path);
  if ((ROOT_FILES as readonly string[]).includes(path)) return "denied";
  if (path.startsWith("skills/active/") || path.startsWith("skills/disabled/")) return "denied";
  if (path.startsWith("skills/proposals/")) return "proposal";
  if (path.startsWith("memory/")) return path === `memory/${todayStamp(now)}.md` ? "append" : "denied";
  const top = path.split("/")[0] ?? "";
  if (AGENT_TREE_TOPS.has(top)) return "tree";
  return "denied";
}

export function writableWorkspacePath(path: string, now = new Date()): boolean {
  try {
    const kind = agentWriteClass(path, now);
    return kind === "proposal" || kind === "tree" || kind === "append";
  } catch {
    return false;
  }
}

export function ownerEditorPath(path: string): boolean {
  assertWorkspacePath(path);
  if ((ROOT_FILES as readonly string[]).includes(path)) return true;
  if (path.startsWith("skills/")) return false;
  return OWNER_TREE_TOPS.has(path.split("/")[0] ?? "");
}

/** A chat upload lands under knowledge/documents. The name keeps its text extension. */
export function documentUploadPath(name: string): string {
  const base = name.trim().split(/[/\\]/).pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "").replace(/^\.+/, "").slice(0, 80);
  if (!/\.(md|txt|json|csv)$/i.test(safe)) throw new Error("Upload a .md, .txt, .json, or .csv file.");
  const path = `knowledge/documents/${safe}`;
  if (!ownerEditorPath(path)) throw new Error("That file stays with the skill controls or is outside the workspace.");
  return path;
}

export function normalizeWorkspace(files: WorkspaceFile[]): WorkspaceSnapshot {
  if (files.length > 200) throw new Error("This workspace is too large.");
  const mapped = new Map<string, string>();
  for (const file of files) {
    assertWorkspacePath(file.path);
    if (typeof file.text !== "string" || file.text.length > 64_000) throw new Error("A workspace file is too large.");
    const scan = scanSkillText(file.text);
    if (!scan.allow) throw new Error(scan.reason);
    mapped.set(file.path, file.text);
  }
  return {
    files: [...mapped.entries()]
      .sort((left, right) => (left[0] < right[0] ? -1 : 1))
      .map(([path, text]) => ({ path, text })),
  };
}

export function encodeSnapshot(tree: WorkspaceSnapshot): Uint8Array {
  return encodeText(JSON.stringify({ files: normalizeWorkspace(tree.files).files }));
}

export function decodeSnapshot(bytes: Uint8Array): WorkspaceSnapshot {
  const parsed = JSON.parse(decodeText(bytes)) as { files?: WorkspaceFile[] };
  return normalizeWorkspace(parsed.files ?? []);
}

export async function pinWorkspace(net: Network, tree: WorkspaceSnapshot): Promise<string> {
  return net.pin(encodeSnapshot(tree));
}

export async function readWorkspace(net: Network, cid: string): Promise<WorkspaceSnapshot> {
  return decodeSnapshot(await net.fetchPin(cid));
}

function mergeAppend(previous: string, incoming: string): string {
  const next = incoming.trim();
  if (!next) return previous;
  const prior = previous.trim();
  if (!prior) return `${next}\n`;
  if (prior.includes(next)) return previous.endsWith("\n") ? previous : `${previous}\n`;
  if (next.startsWith(prior)) return `${next}\n`;
  return `${prior}\n${next}\n`;
}

export function acceptWorkspaceWrites(current: WorkspaceSnapshot, returned: WorkspaceFile[], now = new Date()): WorkspaceSnapshot {
  const mapped = new Map(current.files.map((file) => [file.path, file.text]));
  for (const file of returned) {
    assertWorkspacePath(file.path);
    if (file.path.startsWith("skills/active/") || file.path.startsWith("skills/disabled/")) {
      throw new Error("A job cannot change an installed skill.");
    }
    const kind = agentWriteClass(file.path, now);
    if (kind === "denied") throw new Error("That file stays with the owner.");
    if (kind === "append") mapped.set(file.path, mergeAppend(mapped.get(file.path) ?? "", file.text));
    else mapped.set(file.path, file.text);
  }
  return normalizeWorkspace([...mapped.entries()].map(([path, text]) => ({ path, text })));
}

export function placeSkillTree(current: WorkspaceSnapshot, placed: { folder: "active" | "disabled" | "proposals"; name: string; files: { path: string; text: string }[] }[], managedNames: string[] = []): WorkspaceSnapshot {
  const kept = current.files.filter((file) => !file.path.startsWith("skills/"));
  const next = [...kept];
  for (const skill of placed) {
    for (const file of skill.files) {
      next.push({ path: `skills/${skill.folder}/${skill.name}/${file.path}`, text: file.text });
    }
  }
  const seen = new Set(next.map((file) => file.path));
  const managed = new Set(managedNames);
  for (const file of current.files) {
    if (!file.path.startsWith("skills/proposals/") || seen.has(file.path)) continue;
    const name = file.path.split("/")[2] ?? "";
    if (managed.has(name)) continue;
    next.push(file);
    seen.add(file.path);
  }
  return normalizeWorkspace(next);
}

export function pinnedDocumentCid(text: string): string {
  const match = /^Pinned document\.\ncid: (\S+)/.exec(text);
  return match?.[1] ?? "";
}
