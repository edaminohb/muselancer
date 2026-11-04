import { readDocument, writeDocument } from "../db";
import { scanPlaintext } from "../gateway/llama";
import { scanSkillText } from "../gateway/firewall";
import { ownerEditorPath } from "../workspace/snapshot";

export type ChatTurn = { role: "owner" | "agent"; text: string };
export type StagedFile = { path: string; text: string };

const ROOT_DRAFT = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "BOOT.md", "BOOTSTRAP.md"] as const;
const CONFIRMATIONS = new Set([
  "confirm save",
  "save",
  "save it",
  "save them",
  "save these",
  "save these changes",
  "save the changes",
  "save changes",
  "save again",
  "try to save",
  "try to save again",
  "yes save",
  "yes, save",
]);

function transcriptKey(agentId: string): string {
  return `chat-transcript:${agentId}`;
}

function draftKey(agentId: string): string {
  return `chat-drafts:${agentId}`;
}

export function isSaveConfirmation(message: string): boolean {
  const text = message
    .trim()
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!]+$/g, "")
    .replace(/\s+/g, " ");
  return CONFIRMATIONS.has(text);
}

/** Saved turns stay in order. A client-supplied history is still limited by sanitizeHistory. */
export function storedTurns(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ChatTurn[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { role?: unknown; text?: unknown };
    if (record.role !== "owner" && record.role !== "agent") continue;
    if (typeof record.text !== "string" || !record.text.trim()) continue;
    turns.push({ role: record.role, text: record.text.slice(0, 16_000) });
  }
  return turns;
}

export function sanitizeHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ChatTurn[] = [];
  for (const item of value.slice(-16)) {
    if (!item || typeof item !== "object") continue;
    const record = item as { role?: unknown; text?: unknown };
    if (record.role !== "owner" && record.role !== "agent") continue;
    if (typeof record.text !== "string" || !record.text.trim()) continue;
    const scan = scanPlaintext(record.text, "text");
    if (!scan.allow) continue;
    turns.push({ role: record.role, text: record.text.slice(0, 16_000) });
  }
  return turns;
}

export function recentTranscript(turns: ChatTurn[], maxTurns = 16, maxChars = 24_000): ChatTurn[] {
  const sliced = turns.slice(-maxTurns);
  const kept: ChatTurn[] = [];
  let total = 0;
  for (let index = sliced.length - 1; index >= 0; index -= 1) {
    const text = sliced[index].text.slice(0, 16_000);
    if (kept.length > 0 && total + text.length > maxChars) break;
    total += text.length;
    kept.push({ role: sliced[index].role, text });
  }
  return kept.reverse();
}

export function buildChatInput(turns: ChatTurn[], message: string, savedPaths: string[]): string {
  const lines = recentTranscript(turns).map((turn) => `${turn.role === "owner" ? "Owner" : "Agent"}: ${turn.text}`);
  const saved = savedPaths.length > 0 ? `Saved this turn: ${savedPaths.join(", ")}. Those texts are in the workspace.` : "";
  return [...lines, `Owner: ${message}`, saved].filter(Boolean).join("\n\n");
}

/** Pull full-file drafts out of an earlier reply. The newest draft of each path wins. */
export function draftsFromReply(text: string): StagedFile[] {
  const names = ROOT_DRAFT.map((name) => name.replace(".", "\\.")).join("|");
  const pattern = new RegExp(
    `(?:^|\\n)[^\\n]{0,120}?\\b(${names})\\b[^\\n]*\\n+\\s*\`\`\`[a-zA-Z0-9_-]*\\n([\\s\\S]*?)\`\`\``,
    "g",
  );
  const mapped = new Map<string, string>();
  for (const match of text.matchAll(pattern)) {
    const path = match[1] ?? "";
    const body = (match[2] ?? "").replace(/\s+$/, "");
    if (!path || !body) continue;
    mapped.set(path, body.endsWith("\n") ? body : `${body}\n`);
  }
  return [...mapped.entries()].map(([path, fileText]) => ({ path, text: fileText }));
}

export function draftsFromTranscript(turns: ChatTurn[]): StagedFile[] {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role !== "agent") continue;
    const found = draftsFromReply(turns[index].text);
    if (found.length > 0) return found;
  }
  return [];
}

export function stageOwnerDraft(path: string, text: string): StagedFile {
  const clean = path.trim();
  try {
    if (!ownerEditorPath(clean)) throw new Error("That file stays with the skill controls or is outside the workspace.");
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "That path is outside the workspace.");
  }
  if (text.length > 64_000) throw new Error("That file is too large.");
  const scan = scanSkillText(text);
  if (!scan.allow) throw new Error(scan.reason);
  return { path: clean, text };
}

export async function readChatTranscript(agentId: string): Promise<ChatTurn[]> {
  const raw = await readDocument(transcriptKey(agentId));
  if (!raw) return [];
  try {
    return storedTurns(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export async function writeChatTranscript(agentId: string, turns: ChatTurn[]): Promise<void> {
  await writeDocument(transcriptKey(agentId), JSON.stringify(recentTranscript(turns, 400, 500_000)));
}

export async function readChatDrafts(agentId: string): Promise<StagedFile[]> {
  const raw = await readDocument(draftKey(agentId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const files: StagedFile[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as { path?: unknown; text?: unknown };
      if (typeof record.path !== "string" || typeof record.text !== "string") continue;
      try {
        files.push(stageOwnerDraft(record.path, record.text));
      } catch {
        continue;
      }
    }
    return files;
  } catch {
    return [];
  }
}

export async function writeChatDrafts(agentId: string, files: StagedFile[]): Promise<void> {
  await writeDocument(draftKey(agentId), JSON.stringify(files));
}
