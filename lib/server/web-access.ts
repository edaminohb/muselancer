import { readDocument, writeDocument } from "../db";
import { ownedAgent } from "./register";

function key(agentId: string): string {
  return `web:${agentId}`;
}

export async function webEnabled(agentId: string): Promise<boolean> {
  const raw = await readDocument(key(agentId));
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

export async function readOwnedWeb(owner: string, agentId: string): Promise<boolean> {
  if (!/^\d+$/.test(agentId) || agentId === "0") throw new Error("Agent id must be a positive integer.");
  const agent = await ownedAgent(owner, agentId);
  if (!agent) throw new Error("Agent not found.");
  return webEnabled(agentId);
}

export async function setWebEnabled(owner: string, agentId: string, enabled: boolean): Promise<boolean> {
  if (!/^\d+$/.test(agentId) || agentId === "0") throw new Error("Agent id must be a positive integer.");
  const agent = await ownedAgent(owner, agentId);
  if (!agent) throw new Error("Agent not found.");
  await writeDocument(key(agentId), JSON.stringify({ enabled }));
  return enabled;
}
