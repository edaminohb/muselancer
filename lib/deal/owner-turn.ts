import { parseUsdc } from "../protocol/usdc";

type HireStage = "brief" | "suggest" | "terms" | "negotiate" | "confirm" | "locked" | "stopped";

const DAY_MS = 24 * 60 * 60 * 1000;

export type HireContinuation =
  | { kind: "accept"; agentId: string }
  | { kind: "reject"; agentId: string }
  | { kind: "answer"; answer: string }
  | { kind: "terms"; budget: string; deadline: string; constraints: string }
  | { kind: "draft"; budget: string | null; constraints: string; ask: string }
  | { kind: "counter-accept" }
  | { kind: "counter-reject" }
  | { kind: "resume" }
  | { kind: "replace"; brief: string; cancelOnly: boolean }
  | { kind: "hold"; say: string }
  | { kind: "status" };

/** A delivery time from owner language. A date alone means the end of that UTC day. */
export function ownerDeadlineMs(text: string, now: number): number | null {
  const value = text.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (/\b(as soon as possible|asap|immediately|right away|soonest)\b/.test(lower) || lower === "soon") {
    return now + DAY_MS;
  }
  const inDays = lower.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays) {
    const days = Number(inDays[1]);
    if (Number.isInteger(days) && days > 0 && days < 366) return now + days * DAY_MS;
  }
  const day = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (day) {
    const ms = Date.parse(`${day[1]}-${day[2]}-${day[3]}T23:59:59.000Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** A day named in this message wins over the day already stored. */
export function statedDeadline(message: string, stored: string | null, now: number): string | null {
  const ms = ownerDeadlineMs(message, now);
  if (ms !== null && ms > now) return new Date(ms).toISOString();
  return stored;
}

/** The USDC amount the owner named. A bare year or agent id is not an amount. */
export function ownerBudgetLabel(text: string): string | null {
  const named = text.match(/\bbudget\s*(?:is|of|:)?\s*(\d+(?:\.\d{1,6})?)\b/i);
  if (named?.[1]) return named[1];
  const usdc = text.match(/\b(\d+(?:\.\d{1,6})?)\s*usdc\b/i);
  if (usdc?.[1]) return usdc[1];
  return null;
}

function constraintsFrom(text: string): string {
  const rest = text
    .replace(/\bmy\s+budget\s+is\s+\d+(?:\.\d{1,6})?\s*(?:usdc)?/gi, " ")
    .replace(/\bbudget\s*(?:is|of|:)?\s*\d+(?:\.\d{1,6})?\s*(?:usdc)?/gi, " ")
    .replace(/\b\d+(?:\.\d{1,6})?\s*usdc\b/gi, " ")
    .replace(/\b(as soon as possible|asap|immediately|right away|soonest)\b/gi, " ")
    .replace(/\bin\s+\d+\s+days?\b/gi, " ")
    .replace(/\b20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, " ")
    .replace(/\b(i need it to be delivered|please deliver|deliver(?:ed|y)?|deadline)\b/gi, " ")
    .replace(/[,\s.;:]+/g, " ")
    .trim();
  if (!rest || rest.length < 8) return "";
  if (/^(start|continue|go on|set the terms|do it)( the work)?$/i.test(rest)) return "";
  return rest.slice(0, 4000);
}

/** The owner is talking to this agent, not pressing Confirm on the open hire. */
export function leavesCurrentDeal(text: string): boolean {
  const value = text.toLowerCase();
  if (/\bignore the deal\b|\bforget the deal\b|\bbetween me and you\b|\bnot with (a |the )?(worker|him|her|them)\b/.test(value)) return true;
  return /\byou\b/.test(value) && /\b(create|make|write|build)\b/.test(value);
}

/** The owner is dropping the unlocked hire to search again. A locked hire is not this. */
export function wantsFreshHire(text: string): boolean {
  const value = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!value || /\b(confirm and lock|press confirm)\b/.test(value)) return false;
  const cancel = /\b(from (the )?scratch|start over|start again|cancel (this |the )?(hire|deal)|drop (this |the )?(hire|deal)|new hire|different (hire|agent|worker))\b/.test(value);
  const hireSomeone = /\b(let's|lets) hire\b/.test(value) || /\bhire\b.{0,48}\bagent\b/.test(value);
  if (!cancel && !hireSomeone) return false;
  if (wantsResume(value) && !cancel) return false;
  return true;
}

/** Cancel with no new task in the same sentence. */
export function cancelOnlyHire(text: string): boolean {
  const value = text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  return /^(cancel|drop|forget)( this| the)? (hire|deal)$/.test(value) || /^(start over|start again|from scratch|from the scratch)$/.test(value);
}

/** Continue, retry, and keep going stay on the open hire. */
export function wantsResume(text: string): boolean {
  const value = text.trim();
  return value.length > 0 && value.length <= 200 && /\b(continue|retry|keep going|go on|try again|resume)\b/i.test(value);
}

/** A worker question has to ask about the work. Prompt debris is not a question for the owner. */
export function usableWorkQuestion(question: string): boolean {
  const value = question.trim();
  if (value.length < 12 || value.length > 500) return false;
  if (/cut-off|cutoff|complete the (message|sentence)|starting with|system prompt|\bjson\b|action is/i.test(value)) return false;
  return /\?/.test(value) || /\b(what|which|how|when|where|who|should|do you|is there|are there|any)\b/i.test(value);
}

/** Display amounts such as "5 USDC" become base units. */
export function parseOfferAmount(text: string): string | null {
  const labeled = ownerBudgetLabel(text);
  const bare = (labeled ?? text).trim().replace(/\s*usdc$/i, "");
  try {
    return parseUsdc(bare);
  } catch {
    return null;
  }
}

/** An accept at or under the offer we sent, and inside the owner's budget, closes the deal. */
export function workerAcceptsOffer(input: {
  action: "accept" | "refuse" | "counter";
  price: string;
  offerPrice: string;
  budget: string;
  deadlineMs: number;
  offerDeadlineMs: number;
}): boolean {
  if (input.action !== "accept") return false;
  if (!/^\d+$/.test(input.price) || !/^\d+$/.test(input.offerPrice) || !/^\d+$/.test(input.budget)) return false;
  const price = BigInt(input.price);
  if (price <= BigInt(0) || price > BigInt(input.offerPrice) || price > BigInt(input.budget)) return false;
  return input.deadlineMs <= input.offerDeadlineMs + 1000;
}

function replyKind(text: string): "accept" | "reject" | "proceed" | "other" {
  const value = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (value.length > 80) return "other";
  if (/^(accept|yes|ok|okay|approved|go ahead|hire him|hire her|hire them|hire this agent)\b/.test(value)) return "accept";
  if (/^(reject|no|decline|pass)\b/.test(value)) return "reject";
  if (/^(start|continue|retry|go on|set the terms|do it)$/.test(value) || wantsResume(value)) return "proceed";
  return "other";
}

function newestFirst(message: string, earlierOwnerText: string): string[] {
  const earlier = earlierOwnerText.split(/\n+/).map((line) => line.trim()).filter(Boolean).reverse();
  return [message, ...earlier];
}

function firstDeadline(parts: string[], now: number): number | null {
  for (const part of parts) {
    const ms = ownerDeadlineMs(part, now);
    if (ms !== null) return ms;
  }
  return null;
}

function firstConstraints(parts: string[]): string {
  for (const part of parts) {
    const constraints = constraintsFrom(part);
    if (constraints) return constraints;
  }
  return "";
}

/** What the open hire should do with this owner message. Null leaves the turn to the conversation. */
export function decideHireContinuation(input: {
  stage: HireStage;
  pendingAsk: boolean;
  pendingCounter: boolean;
  currentAgentId: string | null;
  statedBudget: string | null;
  statedConstraints: string;
  message: string;
  earlierOwnerText: string;
  now: number;
}): HireContinuation | null {
  const message = input.message.trim();
  if (!message) return null;
  if (input.stage !== "locked" && wantsFreshHire(message)) {
    return { kind: "replace", brief: message.slice(0, 8000), cancelOnly: cancelOnlyHire(message) };
  }
  if (input.pendingAsk) return { kind: "answer", answer: message.slice(0, 4000) };
  if (input.stage === "stopped" && input.currentAgentId && input.statedBudget && !/^\s*(reject|no|decline|pass)\b/i.test(message)) return { kind: "resume" };
  if (input.stage === "suggest" && wantsResume(message)) {
    return { kind: "hold", say: "Say accept or reject for the suggested agent. No USDC has moved." };
  }
  const kind = replyKind(message);
  if (input.pendingCounter) {
    if (kind === "accept") return { kind: "counter-accept" };
    if (kind === "reject") return { kind: "counter-reject" };
    if (kind === "proceed") return { kind: "status" };
    return null;
  }
  if (input.stage === "suggest") {
    if (!input.currentAgentId) return null;
    if (kind === "accept") return { kind: "accept", agentId: input.currentAgentId };
    if (kind === "reject") return { kind: "reject", agentId: input.currentAgentId };
    return null;
  }
  if (input.stage === "locked") return null;
  if (input.stage === "confirm") {
    if (leavesCurrentDeal(message)) return null;
    return {
      kind: "hold",
      say: "The terms are agreed. Press Confirm and lock USDC. The supervisor is deployed when you confirm. No USDC has moved.",
    };
  }
  if (input.stage !== "terms" && input.stage !== "negotiate") return null;
  const mentionedBudget = Boolean(ownerBudgetLabel(message));
  const mentionedDeadline = ownerDeadlineMs(message, input.now) !== null;
  if (input.stage === "negotiate" && !mentionedBudget && !mentionedDeadline && kind !== "proceed") return { kind: "status" };
  const lines = newestFirst(message, input.earlierOwnerText);
  const budget = ownerBudgetLabel(message) ?? input.statedBudget ?? lines.map(ownerBudgetLabel).find((label): label is string => Boolean(label)) ?? null;
  const deadlineMs = firstDeadline(lines, input.now);
  const constraints = firstConstraints(lines) || input.statedConstraints;
  const hasTime = deadlineMs !== null;
  if (!budget && !hasTime && kind !== "proceed") return null;
  if (!budget) {
    return { kind: "draft", budget: null, constraints, ask: "What budget, in USDC, should I stay inside? No USDC has moved." };
  }
  if (deadlineMs === null || deadlineMs <= input.now) {
    return {
      kind: "draft",
      budget,
      constraints,
      ask: `${budget} USDC is saved. Give me a delivery day in the future, or say as soon as possible. No USDC has moved.`,
    };
  }
  return {
    kind: "terms",
    budget,
    deadline: new Date(deadlineMs).toISOString(),
    constraints,
  };
}
