import { stageOwnerDraft, type StagedFile } from "./chat-thread";
import { ownerEditorPath, type WorkspaceSnapshot } from "../workspace/snapshot";
import { syncOwnedProfile } from "./teach";
import {
  commitWorkspace,
  ensureWorkspace,
  finishBootstrap,
  loadWorkspace,
  materializeForOwner,
  pinLargeDocument,
  readAudit,
  restoreWorkspace,
  type WorkspacePointer,
} from "./workspace";

const PROFILE_FILES = new Set(["IDENTITY.md", "SOUL.md", "USER.md"]);

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function readOwnerWorkspace(agentId: string, seed: { name: string; description: string }) {
  const loaded = await ensureWorkspace(agentId, seed);
  return {
    cid: loaded.pointer.cid,
    history: loaded.pointer.history,
    bootstrapComplete: loaded.pointer.bootstrapComplete,
    files: await materializeForOwner(loaded.tree),
    audit: await readAudit(agentId),
  };
}

export async function ownerWorkspaceAction(
  owner: string,
  agentId: string,
  seed: { name: string; description: string },
  body: Record<string, unknown>,
): Promise<WorkspacePointer> {
  await ensureWorkspace(agentId, seed);
  const action = textOf(body.action) || "restore";
  const expected = typeof body.cid === "string" ? body.cid : undefined;
  if (action === "restore") return restoreWorkspace(agentId, textOf(body.cid));
  if (action === "finish-bootstrap") return finishBootstrap(agentId);
  if (action !== "save" && action !== "create" && action !== "upload") {
    throw new Error("That workspace action is not available.");
  }
  let path = textOf(body.path).trim();
  let text = textOf(body.text);
  if (body.folder === true) {
    path = `${path.replace(/\/+$/, "")}/.keep`;
    text = "Folder.\n";
  }
  if (!ownerEditorPath(path)) throw new Error("That file stays with the skill controls or is outside the workspace.");
  const current = await loadWorkspace(agentId);
  const exists = current.tree.files.some((file) => file.path === path);
  if (action === "create" && exists) throw new Error("That file already exists.");
  if (text.length > 500_000) throw new Error("That upload is too large.");
  if (action === "upload" || text.length > 64_000) {
    if (!path.startsWith("knowledge/") && !path.startsWith("files/")) {
      throw new Error("A large file belongs under knowledge or files.");
    }
    text = await pinLargeDocument(text);
  }
  const saved = text;
  const pointer = await commitWorkspace(agentId, (tree: WorkspaceSnapshot) => {
    const files = tree.files.filter((file) => file.path !== path);
    files.push({ path, text: saved });
    return { files };
  }, "owner", expected);
  if (PROFILE_FILES.has(path)) await syncOwnedProfile(owner, agentId, path, textOf(body.text) || saved);
  return pointer;
}

/** One owner commit for texts the owner confirmed. Root files stay closed to write_workspace. */
export async function saveOwnerFiles(owner: string, agentId: string, files: StagedFile[]): Promise<string[]> {
  if (files.length === 0) return [];
  const staged = files.map((file) => stageOwnerDraft(file.path, file.text));
  const byPath = new Map(staged.map((file) => [file.path, file.text]));
  await commitWorkspace(agentId, (tree: WorkspaceSnapshot) => {
    const mapped = new Map(tree.files.map((file) => [file.path, file.text]));
    for (const [path, text] of byPath) mapped.set(path, text);
    return { files: [...mapped.entries()].map(([path, text]) => ({ path, text })) };
  }, "owner");
  for (const [path, text] of byPath) {
    if (PROFILE_FILES.has(path)) await syncOwnedProfile(owner, agentId, path, text);
  }
  const after = await loadWorkspace(agentId);
  const saved: string[] = [];
  for (const [path, text] of byPath) {
    const current = after.tree.files.find((file) => file.path === path);
    if (current?.text !== text) throw new Error(`The workspace did not keep ${path}.`);
    saved.push(path);
  }
  return saved;
}
