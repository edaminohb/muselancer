import { decodeText, encodeText } from "../crypto/aes";
import { readDocument, writeDocument } from "../db";
import { scanSkillText } from "../gateway/firewall";
import { decodeSnapshot, encodeSnapshot, normalizeWorkspace, pinnedDocumentCid, type WorkspaceFile, type WorkspaceSnapshot } from "../workspace/snapshot";
import { withDefaults, type WorkspaceSeed } from "../workspace/templates";
import { desk, saveDesk } from "./desk";

export type WorkspacePointer = { cid: string; history: string[]; bootstrapComplete: boolean };

export type WorkspaceActor = "owner" | "agent";

export type AuditEntry = { at: string; actor: WorkspaceActor; path: string; before: string; after: string };

const AUDIT_CAP = 80;
const UPLOAD_CAP = 500_000;
const INLINE_CAP = 64_000;

function pointerKey(agentId: string): string {
  return `workspace:${agentId}`;
}

function auditKey(agentId: string): string {
  return `workspace-audit:${agentId}`;
}

async function readPointer(agentId: string): Promise<WorkspacePointer> {
  const raw = await readDocument(pointerKey(agentId));
  if (!raw) return { cid: "", history: [], bootstrapComplete: false };
  const parsed = JSON.parse(raw) as Partial<WorkspacePointer>;
  return {
    cid: parsed.cid ?? "",
    history: Array.isArray(parsed.history) ? parsed.history.filter((item): item is string => typeof item === "string") : [],
    bootstrapComplete: parsed.bootstrapComplete === true,
  };
}

async function writePointer(agentId: string, pointer: WorkspacePointer): Promise<void> {
  await writeDocument(pointerKey(agentId), JSON.stringify(pointer));
}

function changedPaths(before: WorkspaceFile[], after: WorkspaceFile[]): string[] {
  const prior = new Map(before.map((file) => [file.path, file.text]));
  const paths = new Set<string>();
  for (const file of after) {
    if (prior.get(file.path) !== file.text) paths.add(file.path);
    prior.delete(file.path);
  }
  for (const path of prior.keys()) paths.add(path);
  return [...paths];
}

async function recordAudit(agentId: string, actor: WorkspaceActor, paths: string[], before: string, after: string): Promise<void> {
  if (paths.length === 0) return;
  const raw = await readDocument(auditKey(agentId));
  const current = raw ? (JSON.parse(raw) as AuditEntry[]) : [];
  const at = new Date().toISOString();
  const entries = paths.map((path) => ({ at, actor, path, before, after }));
  const next = [...(Array.isArray(current) ? current : []), ...entries].slice(-AUDIT_CAP);
  await writeDocument(auditKey(agentId), JSON.stringify(next));
}

export async function readAudit(agentId: string): Promise<AuditEntry[]> {
  const raw = await readDocument(auditKey(agentId));
  if (!raw) return [];
  const parsed = JSON.parse(raw) as AuditEntry[];
  return Array.isArray(parsed) ? parsed.slice(-20) : [];
}

export async function loadWorkspace(agentId: string): Promise<{ pointer: WorkspacePointer; tree: WorkspaceSnapshot }> {
  const pointer = await readPointer(agentId);
  if (!pointer.cid) return { pointer, tree: { files: [] } };
  const net = await desk();
  return { pointer, tree: decodeSnapshot(await net.fetchPin(pointer.cid)) };
}

export async function commitWorkspace(
  agentId: string,
  mutate: (current: WorkspaceSnapshot) => WorkspaceSnapshot,
  actor: WorkspaceActor = "agent",
  expectedCid?: string,
): Promise<WorkspacePointer> {
  const { pointer, tree } = await loadWorkspace(agentId);
  if (expectedCid !== undefined && expectedCid !== pointer.cid) throw new Error("The workspace changed. Reload it.");
  const next = normalizeWorkspace(mutate(tree).files);
  const changed = changedPaths(tree.files, next.files);
  const latest = await readPointer(agentId);
  if (latest.cid !== pointer.cid) throw new Error("The workspace changed. Reload it.");
  if (changed.length === 0) return { ...pointer, bootstrapComplete: latest.bootstrapComplete };
  const net = await desk();
  const cid = await net.pin(encodeSnapshot(next));
  const again = await readPointer(agentId);
  if (again.cid !== pointer.cid) throw new Error("The workspace changed. Reload it.");
  const history = pointer.history.includes(cid) ? pointer.history : [...pointer.history, cid].slice(-20);
  const stored = { cid, history, bootstrapComplete: again.bootstrapComplete };
  await writePointer(agentId, stored);
  await saveDesk(net);
  await recordAudit(agentId, actor, changed, pointer.cid, cid);
  return stored;
}

export async function ensureWorkspace(agentId: string, seed: WorkspaceSeed): Promise<{ pointer: WorkspacePointer; tree: WorkspaceSnapshot }> {
  const loaded = await loadWorkspace(agentId);
  if (loaded.tree.files.some((file) => file.path === "AGENTS.md")) return loaded;
  try {
    await commitWorkspace(agentId, (current) => withDefaults(current, seed), "owner");
  } catch (error) {
    const again = await loadWorkspace(agentId);
    if (again.tree.files.some((file) => file.path === "AGENTS.md")) return again;
    throw error;
  }
  return loadWorkspace(agentId);
}

export async function restoreWorkspace(agentId: string, cid: string): Promise<WorkspacePointer> {
  const pointer = await readPointer(agentId);
  if (!pointer.history.includes(cid)) throw new Error("That snapshot is not in this workspace history.");
  const net = await desk();
  decodeSnapshot(await net.fetchPin(cid));
  const latest = await readPointer(agentId);
  if (latest.cid !== pointer.cid) throw new Error("The workspace changed. Reload it.");
  const stored = { cid, history: pointer.history, bootstrapComplete: latest.bootstrapComplete };
  await writePointer(agentId, stored);
  await recordAudit(agentId, "owner", ["snapshot"], pointer.cid, cid);
  return stored;
}

export async function finishBootstrap(agentId: string): Promise<WorkspacePointer> {
  const pointer = await readPointer(agentId);
  if (!pointer.cid) throw new Error("Open the workspace before finishing onboarding.");
  const stored = { cid: pointer.cid, history: pointer.history, bootstrapComplete: true };
  await writePointer(agentId, stored);
  await recordAudit(agentId, "owner", ["bootstrap"], pointer.cid, pointer.cid);
  return stored;
}

export async function appendCuratedMemory(agentId: string, fact: string): Promise<void> {
  const line = fact.trim();
  if (!line) return;
  await commitWorkspace(agentId, (current) => {
    const existing = current.files.find((file) => file.path === "MEMORY.md")?.text ?? "# Memory\n";
    if (existing.includes(line)) return current;
    const text = `${existing.trimEnd()}\n- ${line}\n`;
    const files = current.files.filter((file) => file.path !== "MEMORY.md");
    files.push({ path: "MEMORY.md", text });
    return { files };
  }, "owner");
}

export async function pinLargeDocument(text: string): Promise<string> {
  if (text.length > UPLOAD_CAP) throw new Error("That upload is too large.");
  const scan = scanSkillText(text);
  if (!scan.allow) throw new Error(scan.reason);
  if (text.length <= INLINE_CAP) return text;
  const net = await desk();
  const cid = await net.pin(encodeText(text));
  await saveDesk(net);
  const excerpt = text.slice(0, 500);
  return `Pinned document.\ncid: ${cid}\nbytes: ${text.length}\n\n${excerpt}`;
}

export async function materializeForOwner(tree: WorkspaceSnapshot): Promise<WorkspaceFile[]> {
  const net = await desk();
  const files: WorkspaceFile[] = [];
  for (const file of tree.files) {
    const cid = pinnedDocumentCid(file.text);
    if (!cid) {
      files.push(file);
      continue;
    }
    try {
      const text = decodeText(await net.fetchPin(cid));
      files.push({ path: file.path, text: text.length > UPLOAD_CAP ? file.text : text });
    } catch {
      files.push(file);
    }
  }
  return files;
}
