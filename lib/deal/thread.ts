import { WORKER_DEAL } from "../agent/platform";

export type NegotiationTurn = { role: "human" | "agent"; text: string };

export type NegotiationOffer = {
  side: "buyer" | "worker";
  action: string;
  priceLabel: string;
  deadline: string;
  reason: string;
};

export type NegotiationBrief = {
  brief: string;
  constraints: string;
  budgetLabel: string;
  deadline: string;
  postedPrice: string;
  perTaskCap?: string;
  clarifications?: string[];
  turns: NegotiationTurn[];
  offers: NegotiationOffer[];
};

/** Safety stop. The agent proceeds earlier, when it judges the work clear. */
export const MAX_DEAL_QUESTIONS = 8;

export function dealWorkText(input: { brief: string; clarifications?: string[]; constraints: string; deadline: string }): string {
  const notes = (input.clarifications ?? []).map((line) => line.trim()).filter(Boolean);
  return [input.brief, notes.length ? `Clarified:\n${notes.join("\n")}` : "", input.constraints, input.deadline ? `Deliver by ${input.deadline}.` : ""]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

/** Ask the owner only while a real question is left and the question cap is open. */
export function clarifyGate(input: { action: string; question: string; asked: number }): "ask" | "search" {
  if (input.asked >= MAX_DEAL_QUESTIONS) return "search";
  if (input.action === "ask" && input.question.trim()) return "ask";
  return "search";
}

/** The worker may ask before naming a price, up to the same cap. */
export function scopeGate(input: { action: string; question: string; asked: number }): "ask" | "ready" {
  if (input.asked >= MAX_DEAL_QUESTIONS) return "ready";
  if (input.action === "ask" && input.question.trim()) return "ask";
  return "ready";
}

/** An empty or uncertain reply stays with the owner. */
export function relayDecision(input: { action?: string; answer?: string } | null): { kind: "answer"; text: string } | { kind: "ask_owner" } {
  if (!input || input.action !== "answer") return { kind: "ask_owner" };
  const text = input.answer?.trim() ?? "";
  if (!text || text.length > 2000) return { kind: "ask_owner" };
  return { kind: "answer", text };
}

function clip(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n[truncated]`;
}

/** Spoken lines and offers from this deal only. A new deal passes its own empty history. */
export function negotiationThread(turns: NegotiationTurn[], offers: NegotiationOffer[]): string {
  const lines = [
    ...turns.map((turn) => `${turn.role === "human" ? "Owner" : "Asking agent"}: ${clip(turn.text, 2000)}`),
    ...offers.map((offer) => {
      const who = offer.side === "buyer" ? "Asking agent" : "Worker";
      return `${who} ${offer.action}: ${offer.priceLabel} USDC by ${offer.deadline}. ${clip(offer.reason, 500)}`;
    }),
  ];
  const kept: string[] = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (kept.length > 0 && total + line.length > 8000) break;
    total += line.length;
    kept.push(line);
  }
  return kept.reverse().join("\n");
}

export function negotiationInstruction(input: NegotiationBrief): string {
  const thread = negotiationThread(input.turns, input.offers);
  return [
    WORKER_DEAL,
    "The buyer's budget is the amount for this hire.",
    "This is the same negotiation thread. Use the earlier lines and offers below. Another deal is not included.",
    `Task: ${input.brief}`,
    input.clarifications?.length ? `Clarified:\n${input.clarifications.join("\n")}` : "",
    input.constraints ? `Limits: ${input.constraints}` : "",
    `Buyer budget: ${input.budgetLabel} USDC`,
    `Buyer deadline: ${input.deadline}`,
    `Your posted price: ${input.postedPrice} USDC`,
    thread ? `Thread:\n${thread}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type DealMessage = { speaker: string; kind: "hiring" | "worker"; text: string };

const CANNED_OFFER = "Offer inside the owner's budget.";

function termsOf(offer: { priceLabel?: string; deadline?: string }): string {
  const price = offer.priceLabel?.trim() ? `${offer.priceLabel.trim()} USDC` : "";
  const when = offer.deadline?.trim() ? `deliver by ${offer.deadline.trim()}` : "";
  return [price, when].filter(Boolean).join(", ");
}

/** What the hiring agent handed the worker, then each reply the worker gave. Owner chat is not included. */
export function dealMessages(input: {
  hiringName: string;
  workerName: string;
  brief?: string;
  work?: string;
  offers: { side?: string; action?: string; priceLabel?: string; deadline?: string; reason?: string }[];
}): DealMessage[] {
  const hiringName = input.hiringName.trim() || "Hiring agent";
  const workerName = input.workerName.trim() || "Hired agent";
  const handed = input.work?.trim() || input.brief?.trim() || "";
  const messages: DealMessage[] = [];
  let toldWork = false;
  for (const offer of input.offers) {
    if (offer.side !== "buyer" && offer.side !== "worker") continue;
    const reason = offer.reason?.trim() ?? "";
    const terms = termsOf(offer);
    if (offer.side === "buyer") {
      const spoken = reason && reason !== CANNED_OFFER ? reason : "";
      const ask = terms ? `I can pay ${terms}.` : "";
      const text = [toldWork ? "" : handed, ask, spoken].filter(Boolean).join("\n\n");
      if (!text) continue;
      toldWork = toldWork || Boolean(handed);
      messages.push({ speaker: hiringName, kind: "hiring", text });
      continue;
    }
    const ownWords = reason && reason !== CANNED_OFFER ? reason : "";
    const fallback = offer.action === "counter" ? `I need ${terms}.` : offer.action === "refuse" ? "I can't take this." : terms ? `I'll take ${terms}.` : "I'll take it.";
    messages.push({ speaker: workerName, kind: "worker", text: ownWords || fallback });
  }
  if (!toldWork && handed) messages.unshift({ speaker: hiringName, kind: "hiring", text: handed });
  return messages;
}

const CODE_EXT = new Set(["html", "htm", "css", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "json", "md", "rs", "go", "sol", "sh", "yml", "yaml", "xml", "vue", "svelte", "txt", "csv", "log", "svg"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** How a released delivery file can be opened. */
export function deliveryFileKind(path: string): "code" | "image" | "file" {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (CODE_EXT.has(ext)) return "code";
  return "file";
}

/** The hiring agent decides whether this task, of any kind, is clear enough to look for a worker. */
export function briefJudgmentInstruction(input: { brief: string; clarifications: string[]; turns: NegotiationTurn[] }): string {
  const thread = negotiationThread(input.turns, []);
  return [
    "You are the owner's agent. You are about to look for a worker for this task. The task can be any kind of work.",
    "Read the brief, the clarifications, and the thread. Decide whether anything that would change the work is still missing.",
    "If you judge that a missing fact would change the work, action is ask and question is that one fact, in your own words. There is no prepared question.",
    "After an answer, you look again. When nothing that would change the work is still missing, action is search and question is empty.",
    "Do not ask for a budget, a deadline, a worker, or a confirmation. Do not ask something already answered. Do not list several questions. Do not treat one kind of task differently from another.",
    `Brief:\n${input.brief}`,
    input.clarifications.length ? `Clarified:\n${input.clarifications.join("\n")}` : "",
    thread ? `Thread:\n${thread}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function scopeInstruction(input: { brief: string; constraints: string; clarifications: string[]; turns: NegotiationTurn[] }): string {
  const thread = negotiationThread(input.turns, []);
  return [
    "You speak for the worker who would do this job. The job can be any kind of work. Do not name a price yet. Decide in this reply.",
    "Read the task and the clarifications. If you judge that a missing fact would change the work, action is ask and question is that one fact, in your own words. There is no prepared question.",
    "After an answer, you look again. When nothing that would change the work is still missing, action is ready and question is empty. Do not wait for another message.",
    "Do not ask for a price, a budget, or a deadline. Do not ask something already answered. Do not list several questions. Do not treat one kind of task differently from another.",
    `Task: ${input.brief}`,
    input.constraints ? `Limits: ${input.constraints}` : "",
    input.clarifications.length ? `Clarified:\n${input.clarifications.join("\n")}` : "",
    thread ? `Thread:\n${thread}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
