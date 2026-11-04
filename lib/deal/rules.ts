export const MAX_OFFERS = 4;
/** Same seven-day authorization window as the escrow lock. */
export const LOCK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SEVEN_DAY_LOCK = "The lock covers seven days.";
export const MODEL_KEY_LINE = "The model key is missing. I cannot search or negotiate.";

export type SkillFact = {
  id: number;
  name: string;
  caption: string;
  description: string;
};

/** The hire search matches published capabilities. A broader skill covers the skills inside it. */
export function capabilitySkillInstruction(brief: string, rosterLines: string[]): string {
  return [
    "These are the confirmed Directory agents. Each following line is a capability that agent can do.",
    "A published skill covers every skill listed under it. The agent can do that covered work.",
    "Choose 1 to 5 skill ids that produce the deliverable.",
    "The subject of the deliverable is not a skill. A page about a product still needs the skill that builds the page.",
    "Do not look for a skill whose name repeats the request. Return only ids from the list.",
    `Confirmed agents:\n${rosterLines.join("\n")}`,
    `Job:\n${brief}`,
  ].join("\n");
}

/** 3 exact, 2 the agent published a broader skill that contains the needed skill, 1 the agent published a skill inside the needed skill. */
export function skillCoverRank(heldId: number, neededId: number, names: ReadonlyMap<number, string>): number {
  if (heldId === neededId) return 3;
  const held = names.get(heldId);
  const needed = names.get(neededId);
  if (!held || !needed) return 0;
  if (needed.startsWith(`${held}/`)) return 2;
  if (held.startsWith(`${needed}/`)) return 1;
  return 0;
}

export function capabilityScore(heldIds: readonly number[], neededIds: readonly number[], names: ReadonlyMap<number, string>): number {
  let score = 0;
  for (const neededId of neededIds) {
    let best = 0;
    for (const heldId of heldIds) best = Math.max(best, skillCoverRank(heldId, neededId, names));
    score += best;
  }
  return score;
}

/** Published skills plus the taxonomy skills inside them. */
export function skillsCoveredBy(heldIds: readonly number[], catalog: readonly SkillFact[]): SkillFact[] {
  const byId = new Map(catalog.map((skill) => [skill.id, skill]));
  const covered: SkillFact[] = [];
  const seen = new Set<number>();
  for (const id of heldIds) {
    const held = byId.get(id);
    if (!held || seen.has(held.id)) continue;
    seen.add(held.id);
    covered.push(held);
    for (const skill of catalog) {
      if (seen.has(skill.id)) continue;
      if (skill.name.startsWith(`${held.name}/`)) {
        seen.add(skill.id);
        covered.push(skill);
      }
    }
  }
  return covered;
}

export function capabilityRosterLines(
  agents: readonly { agentId: string; name: string; description: string; skillIds: readonly number[] }[],
  catalog: readonly SkillFact[],
): string[] {
  return agents.flatMap((agent) => {
    const lines = skillsCoveredBy(agent.skillIds, catalog).map((skill) => {
      const relation = agent.skillIds.includes(skill.id) ? "published" : "covered by a published skill";
      const description = skill.description ? `: ${skill.description}` : "";
      return `${skill.id} ${skill.caption} (${relation})${description}`;
    });
    return [`Agent ${agent.agentId} ${agent.name} — ${agent.description}`, ...lines];
  });
}

export function coverageReasons(
  heldIds: readonly number[],
  heldLabels: readonly string[],
  neededIds: readonly number[],
  catalog: readonly SkillFact[],
): string[] {
  const names = new Map(catalog.map((skill) => [skill.id, skill.name]));
  const captions = new Map(catalog.map((skill) => [skill.id, skill.caption]));
  const reasons: string[] = [];
  for (const neededId of neededIds) {
    for (let index = 0; index < heldIds.length; index += 1) {
      const rank = skillCoverRank(heldIds[index] ?? 0, neededId, names);
      if (rank === 0) continue;
      const label = heldLabels[index] || String(heldIds[index]);
      reasons.push(rank === 2 ? `${label} (covers ${captions.get(neededId) ?? String(neededId)})` : label);
    }
  }
  return [...new Set(reasons)];
}

export function rankByCapabilityCoverage<T extends { agentId: string; name: string; skillIds: number[] }>(
  hits: readonly T[],
  needed: readonly number[],
  catalog: readonly SkillFact[],
): T[] {
  const names = new Map(catalog.map((skill) => [skill.id, skill.name]));
  return hits
    .map((hit) => ({ hit, score: capabilityScore(hit.skillIds, needed, names) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const name = left.hit.name.localeCompare(right.hit.name);
      if (name !== 0) return name;
      return left.hit.agentId < right.hit.agentId ? -1 : left.hit.agentId > right.hit.agentId ? 1 : 0;
    })
    .map((item) => item.hit);
}

const DESCRIPTION_SKIP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "into", "about", "agent", "work", "task",
  "make", "build", "create", "write", "using", "use", "can", "will", "should", "have", "has", "are", "was",
  "not", "but", "its", "our", "their", "them", "then", "than", "when", "what", "which", "who", "how", "all",
  "any", "each", "also", "just", "more", "some", "such", "only", "other", "over", "after", "before", "where",
]);

/** Shared words between the job and the agent's own description. */
export function descriptionFit(brief: string, description: string): number {
  const words = (value: string) => new Set((value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((token) => !DESCRIPTION_SKIP.has(token)));
  const wanted = words(brief);
  const offered = words(description);
  let score = 0;
  for (const token of wanted) if (offered.has(token)) score += 1;
  return score;
}

/** Skill coverage decides who can do the work. The description orders agents who cover it equally. */
export function rankBySkillAndDescription<T extends { agentId: string; name: string; description: string; skillIds: number[] }>(
  hits: readonly T[],
  needed: readonly number[],
  catalog: readonly SkillFact[],
  brief: string,
): T[] {
  const names = new Map(catalog.map((skill) => [skill.id, skill.name]));
  return hits
    .map((hit) => ({
      hit,
      skill: capabilityScore(hit.skillIds, needed, names),
      words: descriptionFit(brief, `${hit.name}\n${hit.description}`),
    }))
    .filter((item) => item.skill > 0)
    .sort((left, right) => {
      if (right.skill !== left.skill) return right.skill - left.skill;
      if (right.words !== left.words) return right.words - left.words;
      const name = left.hit.name.localeCompare(right.hit.name);
      if (name !== 0) return name;
      return left.hit.agentId < right.hit.agentId ? -1 : left.hit.agentId > right.hit.agentId ? 1 : 0;
    })
    .map((item) => item.hit);
}

/** The hiring agent reads skills and descriptions, then names one agent from the list. */
export function bestWorkerInstruction(brief: string, candidates: readonly string[]): string {
  return [
    "Choose the one confirmed agent best suited to this job.",
    "Use both the published skills and the agent's description.",
    "A published skill covers the skills inside it. The description says what this agent is for.",
    "When the skills are equally suitable, prefer the description that matches the work.",
    "Do not choose an agent whose skills do not cover the work.",
    "Return an agentId from the list. The reason is a short noun phrase the owner can read after \"They match\".",
    "Name the skill and what in the description fits. Do not invent an agent.",
    `Candidates:\n${candidates.join("\n\n")}`,
    `Job:\n${brief}`,
  ].join("\n");
}

export function chosenWorkerId(text: string, allowed: ReadonlySet<string>): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { agentId?: unknown };
    const id = typeof parsed.agentId === "string"
      ? parsed.agentId.trim()
      : typeof parsed.agentId === "number" && Number.isInteger(parsed.agentId)
        ? String(parsed.agentId)
        : "";
    return id && allowed.has(id) ? id : null;
  } catch {
    return null;
  }
}

export function workerReason(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return "";
  try {
    const parsed = JSON.parse(match[0]) as { reason?: unknown };
    const reason = typeof parsed.reason === "string" ? parsed.reason.replace(/\s+/g, " ").trim() : "";
    return reason.slice(0, 240);
  } catch {
    return "";
  }
}

export function promoteChosenWorker<T extends { agentId: string }>(hits: readonly T[], agentId: string | null): T[] {
  if (!agentId) return [...hits];
  const index = hits.findIndex((hit) => hit.agentId === agentId);
  if (index <= 0) return [...hits];
  const next = [...hits];
  const [choice] = next.splice(index, 1);
  return choice ? [choice, ...next] : [...hits];
}

export function rankByCapabilities<T extends { agentId: string; name: string; skillIds: number[] }>(hits: T[], needed: number[]): T[] {
  const score = (item: T) => needed.filter((id) => item.skillIds.includes(id)).length;
  return [...hits].sort((left, right) => {
    const diff = score(right) - score(left);
    if (diff !== 0) return diff;
    const name = left.name.localeCompare(right.name);
    if (name !== 0) return name;
    return left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0;
  });
}

export function skillIdsFromModel(text: string, allowed: ReadonlySet<number>): number[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { skillIds?: unknown };
    if (!Array.isArray(parsed.skillIds)) return [];
    const ids = parsed.skillIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && allowed.has(id));
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

export function nextSuggestion<T extends { agentId: string }>(hits: T[], rejected: string[], selfId: string): T | null {
  const hidden = new Set(rejected);
  return hits.find((hit) => hit.agentId !== selfId && !hidden.has(hit.agentId)) ?? null;
}

export function assertListedSuggestion(agentId: string, hits: { agentId: string }[]): void {
  if (!hits.some((hit) => hit.agentId === agentId)) throw new Error("That agent was not in the search.");
}

export function reviewDeadline(deadlineMs: number, now: number): "ok" | "past" | "beyond-lock" {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now) return "past";
  if (deadlineMs > now + LOCK_WINDOW_MS) return "beyond-lock";
  return "ok";
}

/** The offer is the worker's posted price when that price fits the budget the owner just gave. */
export function offerInsideLimits(input: { budget: string; posted: string }): { ok: true; price: string; limitedBy: "posted" | "budget" } | { ok: false; reason: string } {
  if (!/^\d+$/.test(input.budget) || !/^\d+$/.test(input.posted)) return { ok: false, reason: "Amount or budget is not a USDC base-unit integer." };
  const budget = BigInt(input.budget);
  const posted = BigInt(input.posted);
  if (budget <= BigInt(0)) return { ok: false, reason: "Amount must be greater than zero." };
  if (posted > BigInt(0) && posted <= budget) return { ok: true, price: posted.toString(), limitedBy: "posted" };
  return { ok: true, price: budget.toString(), limitedBy: "budget" };
}

export function assessPrice(input: { price: string; budget: string }): { ok: boolean; reason: string } {
  if (!/^\d+$/.test(input.price) || !/^\d+$/.test(input.budget)) return { ok: false, reason: "Amount or budget is not a USDC base-unit integer." };
  const price = BigInt(input.price);
  if (price <= BigInt(0)) return { ok: false, reason: "Amount must be greater than zero." };
  if (price > BigInt(input.budget)) return { ok: false, reason: "The price is above your budget." };
  return { ok: true, reason: "The price is inside the owner's budget." };
}

export function roomForRound(existingOffers: number): boolean {
  return existingOffers + 2 <= MAX_OFFERS;
}

/** A higher price or a later deadline is a looser limit. The buyer agent cannot accept it alone. */
export function counterLoosens(input: { price: string; budget: string; deadlineMs: number; humanDeadlineMs: number }): boolean {
  if (!/^\d+$/.test(input.price) || !/^\d+$/.test(input.budget)) return true;
  return BigInt(input.price) > BigInt(input.budget) || input.deadlineMs > input.humanDeadlineMs;
}

/** The lock uses the agreed price only after the human has confirmed the deal. */
export function agreedLockAmount(input: { stage: string; agreedPriceUsdc: string | null; postedPriceUsdc: string }): string {
  if ((input.stage !== "confirm" && input.stage !== "locked") || !input.agreedPriceUsdc || !/^\d+$/.test(input.agreedPriceUsdc)) {
    throw new Error("Confirm the deal before the hire quote.");
  }
  if (BigInt(input.agreedPriceUsdc) <= BigInt(0)) throw new Error("Confirm the deal before the hire quote.");
  return input.agreedPriceUsdc;
}
