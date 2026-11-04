import { getAddress } from "viem";
import { scanUntrusted } from "../gateway/firewall";
import { assertModel } from "../gateway/meta";
import { DEFAULT_LONG_HORIZON, DEFAULT_ORDINARY } from "../gateway/models";

export type MemoryProposal = {
  id: string;
  fact: string;
};

export type ProfileTurn = {
  role: "human" | "agent";
  text: string;
};

export type AgentProfile = {
  agentId: string;
  owner: string;
  identity: { displayName: string; description: string; expertise: string[] };
  voice: { personality: string; tone: string; style: string };
  conduct: { preferences: string[]; decisionStyle: string; boundaries: string[]; instructions: string[] };
  goals: { objectives: string[] };
  models: { ordinary: string; longHorizon: string };
  proposals: MemoryProposal[];
  turns: ProfileTurn[];
};

export type CharacterInput = {
  displayName: string;
  personality: string;
  style: string;
  objectives: string;
  instructions: string;
};

const ORDINARY = DEFAULT_ORDINARY;
const LONG_HORIZON = DEFAULT_LONG_HORIZON;

export function blankProfile(agentId: string, owner: string): AgentProfile {
  return {
    agentId,
    owner: getAddress(owner),
    identity: { displayName: "", description: "", expertise: [] },
    voice: { personality: "", tone: "", style: "" },
    conduct: { preferences: [], decisionStyle: "", boundaries: [], instructions: [] },
    goals: { objectives: [] },
    models: { ordinary: ORDINARY, longHorizon: LONG_HORIZON },
    proposals: [],
    turns: [],
  };
}

export function assertProfileOwner(profileOwner: string, caller: string): void {
  if (getAddress(profileOwner) !== getAddress(caller)) throw new Error("Only the owner of this agent can teach it.");
}

function checked(value: string, limit: number, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length > limit) throw new Error(`${label} is too long.`);
  if (trimmed) {
    const scan = scanUntrusted(trimmed);
    if (!scan.allow) throw new Error(scan.reason);
  }
  return trimmed;
}

function checkedList(values: unknown, limit: number, itemLimit: number, label: string): string[] {
  const list = Array.isArray(values) ? values : [];
  if (list.length > limit) throw new Error(`${label} is too long.`);
  const lines: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") throw new Error(`${label} must be text.`);
    const line = checked(item, itemLimit, label);
    if (line) lines.push(line);
  }
  return lines;
}

/** The owner chooses one model. Every call for this agent uses it. */
export function preferredModel(models: { ordinary: string; longHorizon: string }, _longHorizon: boolean): string {
  return assertModel(models.ordinary.trim() || ORDINARY, true);
}

export function saveIdentity(profile: AgentProfile, input: { displayName: string; description: string; expertise: unknown }): AgentProfile {
  return {
    ...profile,
    identity: {
      displayName: checked(input.displayName, 80, "The display name"),
      description: checked(input.description, 4000, "The description"),
      expertise: checkedList(input.expertise, 20, 200, "The expertise"),
    },
  };
}

export function saveVoice(profile: AgentProfile, input: { personality: string; tone: string; style: string }): AgentProfile {
  return {
    ...profile,
    voice: {
      personality: checked(input.personality, 4000, "The personality"),
      tone: checked(input.tone, 4000, "The tone"),
      style: checked(input.style, 4000, "The style"),
    },
  };
}

export function saveConduct(profile: AgentProfile, input: {
  preferences: unknown;
  decisionStyle: string;
  boundaries: unknown;
  instructions: unknown;
}): AgentProfile {
  return {
    ...profile,
    conduct: {
      preferences: checkedList(input.preferences, 20, 400, "The preferences"),
      decisionStyle: checked(input.decisionStyle, 4000, "The decision style"),
      boundaries: checkedList(input.boundaries, 20, 400, "The boundaries"),
      instructions: checkedList(input.instructions, 20, 4000, "The instructions"),
    },
  };
}

export function saveGoals(profile: AgentProfile, input: { objectives: unknown }): AgentProfile {
  return { ...profile, goals: { objectives: checkedList(input.objectives, 20, 4000, "The objectives") } };
}

export function saveModels(profile: AgentProfile, input: { ordinary: string; longHorizon: string }): AgentProfile {
  const chosen = assertModel(input.ordinary.trim() || input.longHorizon.trim() || ORDINARY, true);
  const models = { ordinary: chosen, longHorizon: chosen };
  preferredModel(models, false);
  preferredModel(models, true);
  return { ...profile, models };
}

export function saveCharacter(profile: AgentProfile, input: CharacterInput): AgentProfile {
  return saveGoals(
    saveConduct(
      saveVoice(saveIdentity(profile, { displayName: input.displayName, description: profile.identity.description, expertise: profile.identity.expertise }), {
        personality: input.personality,
        tone: profile.voice.tone,
        style: input.style,
      }),
      {
        preferences: profile.conduct.preferences,
        decisionStyle: profile.conduct.decisionStyle,
        boundaries: profile.conduct.boundaries,
        instructions: input.instructions.trim() ? [input.instructions] : [],
      },
    ),
    { objectives: input.objectives.trim() ? [input.objectives] : [] },
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function section(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function applyConfigAction(profile: AgentProfile, action: string, command: Record<string, unknown>): AgentProfile {
  if (action === "character" && !command.identity && typeof command.displayName === "string") {
    return saveCharacter(profile, {
      displayName: text(command.displayName),
      personality: text(command.personality),
      style: text(command.style),
      objectives: text(command.objectives),
      instructions: text(command.instructions),
    });
  }
  let next = profile;
  if (action === "identity" || action === "character") {
    const identity = section(command.identity);
    next = saveIdentity(next, {
      displayName: text(identity.displayName),
      description: text(identity.description),
      expertise: identity.expertise,
    });
  }
  if (action === "voice" || action === "character") {
    const voice = section(command.voice);
    next = saveVoice(next, { personality: text(voice.personality), tone: text(voice.tone), style: text(voice.style) });
  }
  if (action === "conduct" || action === "character") {
    const conduct = section(command.conduct);
    next = saveConduct(next, {
      preferences: conduct.preferences,
      decisionStyle: text(conduct.decisionStyle),
      boundaries: conduct.boundaries,
      instructions: conduct.instructions,
    });
  }
  if (action === "goals" || action === "character") {
    next = saveGoals(next, { objectives: section(command.goals).objectives });
  }
  return next;
}

export function normalizeProfile(agentId: string, owner: string, parsed: unknown): AgentProfile {
  if (!parsed || typeof parsed !== "object") return blankProfile(agentId, owner);
  const record = parsed as Record<string, unknown>;
  const storedOwner = typeof record.owner === "string" && record.owner ? record.owner : owner;
  const blank = blankProfile(agentId, storedOwner);
  const proposals = Array.isArray(record.proposals)
    ? record.proposals.filter((item): item is MemoryProposal => Boolean(item && typeof item === "object" && typeof (item as MemoryProposal).id === "string" && typeof (item as MemoryProposal).fact === "string"))
    : [];
  const turns = Array.isArray(record.turns)
    ? record.turns.filter((item): item is ProfileTurn => Boolean(item && typeof item === "object" && ((item as ProfileTurn).role === "human" || (item as ProfileTurn).role === "agent") && typeof (item as ProfileTurn).text === "string"))
    : [];
  const base = { ...blank, proposals, turns };
  const shaped = !record.voice || typeof record.voice !== "object"
    ? saveCharacter(base, {
      displayName: text(record.displayName),
      personality: text(record.personality),
      style: text(record.style),
      objectives: text(record.objectives),
      instructions: text(record.instructions),
    })
    : applyConfigAction(base, "character", record);
  const models = section(record.models);
  const ordinary = text(models.ordinary);
  const longHorizon = text(models.longHorizon);
  if (!ordinary && !longHorizon) return shaped;
  return saveModels(shaped, { ordinary, longHorizon });
}

export function compileOwnerPrefix(profile: AgentProfile): string {
  const lines = [
    profile.identity.displayName ? `Display name: ${profile.identity.displayName}` : "",
    profile.identity.description ? `Description: ${profile.identity.description}` : "",
    profile.identity.expertise.length ? `Expertise: ${profile.identity.expertise.join(", ")}` : "",
    profile.voice.personality ? `Personality: ${profile.voice.personality}` : "",
    profile.voice.tone ? `Tone: ${profile.voice.tone}` : "",
    profile.voice.style ? `Style: ${profile.voice.style}` : "",
    profile.conduct.preferences.length ? `Preferences: ${profile.conduct.preferences.join(", ")}` : "",
    profile.conduct.decisionStyle ? `Decision making: ${profile.conduct.decisionStyle}` : "",
    profile.conduct.boundaries.length ? `Boundaries: ${profile.conduct.boundaries.join(", ")}` : "",
    profile.conduct.instructions.length ? `Standing instructions: ${profile.conduct.instructions.join(", ")}` : "",
    profile.goals.objectives.length ? `Objectives: ${profile.goals.objectives.join(", ")}` : "",
    `Ordinary model: ${profile.models.ordinary}`,
    `Long-horizon model: ${profile.models.longHorizon}`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function withProposal(profile: AgentProfile, fact: string, id: string): AgentProfile {
  const line = checked(fact, 1000, "That fact");
  if (!line) throw new Error("There is no fact to remember.");
  return { ...profile, proposals: [...profile.proposals, { id, fact: line }] };
}

export function withoutProposal(profile: AgentProfile, proposalId: string): AgentProfile {
  if (!profile.proposals.some((proposal) => proposal.id === proposalId)) throw new Error("That proposal is not waiting.");
  return { ...profile, proposals: profile.proposals.filter((proposal) => proposal.id !== proposalId) };
}

/** Pending proposals stay out of memory until this is called with the confirmed fact. */
export function appendConfirmedFact(memory: string, fact: string): string {
  const line = fact.trim();
  if (!line) throw new Error("There is no fact to remember.");
  const current = memory.trim();
  if (!current) return line;
  if (current.split("\n").includes(line)) return current;
  return `${current}\n${line}`;
}

/** The hire and the worker see the task text. The private profile is not an argument. */
export function workerTaskText(criteria: string): string {
  return criteria.trim();
}
