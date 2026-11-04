import { randomBytes } from "node:crypto";
import { getAddress } from "viem";
import {
  appendConfirmedFact,
  applyConfigAction,
  assertProfileOwner,
  blankProfile,
  normalizeProfile,
  preferredModel,
  withProposal,
  withoutProposal,
  type AgentProfile,
} from "../agent/profile";
import { readDocument, writeDocument } from "../db";
import { scanUntrusted } from "../gateway/firewall";
import { sparkStructured } from "../gateway/meta";
import { writeMemoryHead } from "../memory/head";
import { applyWorkspaceFile } from "../workspace/profile-sync";
import { desk, saveDesk } from "./desk";
import { ownedAgent, publicAgent, recoverMemory } from "./register";
import { appendCuratedMemory } from "./workspace";
import { memoryKey } from "../world/network";

export class ProfileError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const MODEL_KEY_LINE = "The model key is missing. Confirm to remember the words you wrote.";

function profileKey(agentId: string): string {
  return `profile:${agentId}`;
}

function say(profile: AgentProfile, role: "human" | "agent", text: string): void {
  profile.turns.push({ role, text });
  if (profile.turns.length > 40) profile.turns.splice(0, profile.turns.length - 40);
}

async function requireOwned(owner: string, agentId: string): Promise<void> {
  if (!/^\d+$/.test(agentId) || agentId === "0") throw new ProfileError("Agent id must be a positive integer.", 400);
  const agent = await ownedAgent(owner, agentId);
  if (!agent) throw new ProfileError("Agent not found.", 404);
}

async function loadProfile(agentId: string, owner: string): Promise<AgentProfile> {
  const raw = await readDocument(profileKey(agentId));
  if (!raw) return blankProfile(agentId, owner);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return blankProfile(agentId, owner);
  }
  const record = parsed && typeof parsed === "object" ? (parsed as { agentId?: string }) : {};
  if (record.agentId && record.agentId !== agentId) return blankProfile(agentId, owner);
  let profile: AgentProfile;
  try {
    profile = normalizeProfile(agentId, owner, parsed);
    assertProfileOwner(profile.owner, owner);
  } catch (error) {
    if (error instanceof Error && error.message.includes("owner of this agent")) {
      throw new ProfileError(error.message, 403);
    }
    throw new ProfileError(error instanceof Error ? error.message : "Could not read this profile.", 400);
  }
  return profile;
}

export async function agentPreferredModel(agentId: string, longHorizon: boolean): Promise<string> {
  try {
    const agent = await publicAgent(agentId);
    const profile = await loadProfile(agentId, agent.owner);
    return preferredModel(profile.models, longHorizon);
  } catch {
    return preferredModel(blankProfile(agentId, "0x0000000000000000000000000000000000000000").models, longHorizon);
  }
}

async function saveProfile(profile: AgentProfile): Promise<void> {
  await writeDocument(profileKey(profile.agentId), JSON.stringify(profile));
}

export async function syncOwnedProfile(owner: string, agentId: string, path: string, text: string): Promise<void> {
  await requireOwned(owner, agentId);
  const profile = await loadProfile(agentId, owner);
  await saveProfile(applyWorkspaceFile(profile, path, text));
}

export async function addMemoryProposal(owner: string, agentId: string, fact: string): Promise<string> {
  await requireOwned(owner, agentId);
  const profile = await loadProfile(agentId, owner);
  const next = withProposal(profile, fact, randomBytes(8).toString("hex"));
  say(next, "agent", "I can remember that after you confirm it.");
  await saveProfile(next);
  return "That fact is waiting for the owner.";
}

async function draftFact(lesson: string, model: string): Promise<{ fact: string; note: string }> {
  try {
    const parsed = (await sparkStructured({
      model,
      name: "memory",
      instruction: `The owner is teaching their agent. Return one durable fact stated in the lesson. Do not add a fact they did not state.\nLesson:\n${lesson}`,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { fact: { type: "string" } },
        required: ["fact"],
      },
    })) as { fact?: unknown };
    const fact = typeof parsed.fact === "string" ? parsed.fact.trim() : "";
    if (!fact) return { fact: "", note: "I could not draft a fact from that. Say the fact you want remembered." };
    if (fact.length > 1000) return { fact: "", note: "That fact is too long." };
    return { fact, note: `Confirm to remember: ${fact}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : MODEL_KEY_LINE;
    if (message.startsWith("The model key is missing")) {
      if (lesson.length > 1000) return { fact: "", note: "Say a shorter fact to remember." };
      return { fact: lesson, note: MODEL_KEY_LINE };
    }
    return { fact: "", note: message };
  }
}

export async function readOwnedProfile(owner: string, agentId: string): Promise<AgentProfile> {
  await requireOwned(owner, agentId);
  return loadProfile(agentId, owner);
}

export async function handleTeach(
  owner: string,
  agentId: string,
  body: unknown,
): Promise<{ profile: AgentProfile; memory: string | null }> {
  await requireOwned(owner, agentId);
  const command = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const action = typeof command.action === "string" ? command.action : "";
  const profile = await loadProfile(agentId, owner);
  profile.owner = getAddress(owner);
  let memory: string | null = null;
  if (action === "models") throw new ProfileError("The model is chosen at registration.", 400);
  if (action === "character" || action === "identity" || action === "voice" || action === "conduct" || action === "goals") {
    const next = applyConfigAction(profile, action, command);
    next.proposals = profile.proposals;
    next.turns = profile.turns;
    say(next, "agent", "I saved your character. The identity name on the registry is unchanged.");
    await saveProfile(next);
    return { profile: next, memory };
  }
  if (action === "teach") {
    const lesson = typeof command.lesson === "string" ? command.lesson.trim() : "";
    if (!lesson) throw new ProfileError("Describe what to teach.", 400);
    if (lesson.length > 4000) throw new ProfileError("That lesson is too long.", 400);
    const scan = scanUntrusted(lesson);
    if (!scan.allow) throw new ProfileError(scan.reason, 400);
    say(profile, "human", lesson);
    const drafted = await draftFact(lesson, preferredModel(profile.models, true));
    say(profile, "agent", drafted.note);
    if (drafted.fact) {
      const next = withProposal(profile, drafted.fact, randomBytes(8).toString("hex"));
      next.turns = profile.turns;
      await saveProfile(next);
      return { profile: next, memory };
    }
    await saveProfile(profile);
    return { profile, memory };
  }
  if (action === "reject") {
    const proposalId = typeof command.proposalId === "string" ? command.proposalId : "";
    const next = withoutProposal(profile, proposalId);
    next.turns = profile.turns;
    say(next, "agent", "I left that out of memory.");
    await saveProfile(next);
    return { profile: next, memory };
  }
  if (action === "confirm") {
    const proposalId = typeof command.proposalId === "string" ? command.proposalId : "";
    const password = typeof command.password === "string" ? command.password : "";
    const proposal = profile.proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new ProfileError("That proposal is not waiting.", 400);
    if (password.length < 8) throw new ProfileError("Choose a memory password of at least 8 characters.", 400);
    const existing = await recoverMemory(owner, agentId, password);
    const plaintext = appendConfirmedFact(existing, proposal.fact);
    const net = await desk();
    await writeMemoryHead(net, {
      agentId,
      owner: getAddress(owner),
      memoryKey: memoryKey(),
      plaintext,
      password,
    });
    await saveDesk(net);
    await appendCuratedMemory(agentId, proposal.fact);
    const next = withoutProposal(profile, proposalId);
    next.turns = profile.turns;
    say(next, "agent", "That fact is in memory.");
    await saveProfile(next);
    return { profile: next, memory: plaintext };
  }
  throw new ProfileError("Describe what to teach.", 400);
}

export function profileFailure(error: unknown): { message: string; status: number } {
  if (error instanceof ProfileError) return { message: error.message, status: error.status };
  const message = error instanceof Error ? error.message : "Could not teach this agent.";
  return { message, status: 400 };
}
