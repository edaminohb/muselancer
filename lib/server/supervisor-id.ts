import { readDocument } from "../db";

export const SUPERVISOR_RECORD_KEY = "platform-supervisor";
export const SUPERVISOR_DISPLAY_NAME = "Muselancer supervisor";

/** The one supervisor for this app. Every hire, agent, and account uses this id. */
export async function platformSupervisorId(): Promise<string | null> {
  const fromEnv = process.env.SUPERVISOR_AGENT_ID?.trim() ?? "";
  if (/^\d+$/.test(fromEnv) && fromEnv !== "0") return fromEnv;
  const raw = await readDocument(SUPERVISOR_RECORD_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { agentId?: unknown };
    const id = typeof parsed.agentId === "string" ? parsed.agentId.trim() : "";
    return /^\d+$/.test(id) && id !== "0" ? id : null;
  } catch {
    return null;
  }
}

export function isPlatformSupervisor(agent: { agentId: string; displayName?: string | null }, supervisorId: string | null): boolean {
  if (supervisorId && agent.agentId === supervisorId) return true;
  return (agent.displayName ?? "").trim() === SUPERVISOR_DISPLAY_NAME;
}
