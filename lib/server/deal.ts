import { randomBytes } from "node:crypto";
import { getAddress } from "viem";
import { readDocument, writeDocument } from "../db";
import { decideHireContinuation, ownerBudgetLabel, ownerDeadlineMs, parseOfferAmount, statedDeadline, usableWorkQuestion, workerAcceptsOffer } from "../deal/owner-turn";
import { briefJudgmentInstruction, clarifyGate, dealWorkText, negotiationInstruction, relayDecision, scopeGate, scopeInstruction } from "../deal/thread";
import {
  LOCK_WINDOW_MS,
  MAX_OFFERS,
  MODEL_KEY_LINE,
  SEVEN_DAY_LOCK,
  agreedLockAmount,
  assertListedSuggestion,
  assessPrice,
  nextSuggestion,
  offerInsideLimits,
  reviewDeadline,
  roomForRound,
  capabilityRosterLines,
  capabilitySkillInstruction,
  bestWorkerInstruction,
  chosenWorkerId,
  coverageReasons,
  promoteChosenWorker,
  rankBySkillAndDescription,
  skillsCoveredBy,
  workerReason,
  skillIdsFromModel,
} from "../deal/rules";
import { scanUntrusted } from "../gateway/firewall";
import { conversationModel } from "../gateway/models";
import { sparkStructured } from "../gateway/meta";
import { loadSkillCatalog } from "../protocol/skills";
import { formatUsdc, parseUsdc } from "../protocol/usdc";
import { desk } from "./desk";
import { isSaveConfirmation } from "./chat-thread";
import { HireError, quoteHire, requireDealSupervisor } from "./hire";
import { directorySearch, ownedAgent, publicAgent } from "./register";
import { agentPreferredModel } from "./teach";

export class DealError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type Suggestion = {
  agentId: string;
  name: string;
  description: string;
  skillIds: number[];
  skillLabels: string[];
  postedPrice: string | null;
  matchNote?: string;
};

export type DealOffer = {
  side: "buyer" | "worker";
  action: "offer" | "accept" | "refuse" | "counter";
  priceUsdc: string;
  priceLabel: string;
  deadline: string;
  reason: string;
};

export type DealStage = "brief" | "suggest" | "terms" | "negotiate" | "confirm" | "locked" | "stopped";

export type Deal = {
  id: string;
  askingAgentId: string;
  payer: string;
  stage: DealStage;
  brief: string;
  turns: { role: "human" | "agent"; text: string }[];
  suggestions: Suggestion[];
  rejected: string[];
  directoryNote: string;
  selectedAgentId: string | null;
  selectedName: string;
  supervisorAgentId: string;
  supervisorName: string;
  budgetUsdc: string | null;
  budgetLabel: string | null;
  statedBudget: string | null;
  statedConstraints: string;
  deadline: string | null;
  constraints: string;
  clarifications: string[];
  pendingAsk: { from: "hirer" | "worker"; question: string } | null;
  scopeReady: boolean;
  ownerQuestions: number;
  workerQuestions: number;
  longHorizon: boolean;
  needsWindow: boolean;
  offers: DealOffer[];
  pendingCounter: { priceUsdc: string; priceLabel: string; deadline: string; reason: string } | null;
  agreedPriceUsdc: string | null;
  agreedPriceLabel: string | null;
  agreedDeadline: string | null;
  hireId: string | null;
  taskId: string | null;
};

export type DealView = Deal & { current: Suggestion | null };

type SearchHit = {
  agentId: string;
  displayName: string;
  description: string;
  skillIds: number[];
  hirePrice: string | null;
};

function dealKey(agentId: string): string {
  return `deal:${agentId}`;
}

function say(deal: Deal, role: "human" | "agent", text: string): void {
  deal.turns.push({ role, text });
  if (deal.turns.length > 40) deal.turns.splice(0, deal.turns.length - 40);
}

function blank(askingAgentId: string, payer: string): Deal {
  return {
    id: randomBytes(16).toString("hex"),
    askingAgentId,
    payer,
    stage: "brief",
    brief: "",
    turns: [],
    suggestions: [],
    rejected: [],
    directoryNote: "",
    selectedAgentId: null,
    selectedName: "",
    supervisorAgentId: "",
    supervisorName: "",
    budgetUsdc: null,
    budgetLabel: null,
    statedBudget: null,
    statedConstraints: "",
    deadline: null,
    constraints: "",
    clarifications: [],
    pendingAsk: null,
    scopeReady: false,
    ownerQuestions: 0,
    workerQuestions: 0,
    longHorizon: false,
    needsWindow: false,
    offers: [],
    pendingCounter: null,
    agreedPriceUsdc: null,
    agreedPriceLabel: null,
    agreedDeadline: null,
    hireId: null,
    taskId: null,
  };
}

function presentDeal(deal: Deal): DealView {
  return {
    ...deal,
    current: deal.stage === "suggest" ? nextSuggestion(deal.suggestions, deal.rejected, deal.askingAgentId) : null,
  };
}

async function loadDeal(agentId: string): Promise<Deal | null> {
  const raw = await readDocument(dealKey(agentId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Deal;
  if (!parsed || parsed.askingAgentId !== agentId || !parsed.stage) return null;
  parsed.turns ??= [];
  parsed.suggestions ??= [];
  parsed.rejected ??= [];
  parsed.offers ??= [];
  parsed.clarifications ??= [];
  parsed.pendingAsk ??= null;
  parsed.statedBudget ??= null;
  parsed.statedConstraints ??= "";
  parsed.scopeReady ??= false;
  parsed.ownerQuestions ??= 0;
  parsed.workerQuestions ??= 0;
  parsed.supervisorAgentId ??= "";
  parsed.supervisorName ??= "";
  return parsed;
}

async function saveDeal(deal: Deal): Promise<void> {
  await writeDocument(dealKey(deal.askingAgentId), JSON.stringify(deal));
}

const HIRE_PAID = "That hire is finished. The files were released and the USDC was paid.";
const HIRE_RETURNED = "That hire was rejected. The USDC was returned.";

function closeFinishedDeal(deal: Deal, line: string): void {
  deal.stage = "stopped";
  deal.selectedAgentId = null;
  deal.pendingAsk = null;
  deal.pendingCounter = null;
  deal.needsWindow = false;
  say(deal, "agent", line);
}

/** After capture or void, the hiring agent's deal stops repeating Confirm. */
export async function recordTaskOutcome(taskId: string, outcome: "paid" | "returned"): Promise<void> {
  const task = (await desk()).tasks.get(taskId);
  const hiring = task?.hiringAgentId?.trim() ?? "";
  if (!hiring) return;
  const deal = await loadDeal(hiring);
  if (!deal || deal.taskId !== taskId) return;
  if (deal.stage === "stopped" && !deal.selectedAgentId) return;
  closeFinishedDeal(deal, outcome === "paid" ? HIRE_PAID : HIRE_RETURNED);
  await saveDeal(deal);
}

/** Facts for this chat. A captured or voided lock is closed before the model speaks. */
export async function ownerDealFacts(owner: string, agentId: string): Promise<string> {
  const deal = await loadDeal(agentId);
  if (!deal || getAddress(deal.payer) !== getAddress(owner)) return "No hire is open.";
  if (deal.stage === "locked" && deal.taskId) {
    const net = await desk();
    const task = net.tasks.get(deal.taskId);
    const payment = task?.paymentId ? net.getPayment(task.paymentId) : undefined;
    if (payment?.status === "captured") {
      closeFinishedDeal(deal, HIRE_PAID);
      await saveDeal(deal);
      return `${HIRE_PAID} This message is a new conversation. Do not ask the owner to press Confirm and lock USDC. Do not say the worker is still writing.`;
    }
    if (payment?.status === "voided" || payment?.status === "reclaimed") {
      closeFinishedDeal(deal, HIRE_RETURNED);
      await saveDeal(deal);
      return `${HIRE_RETURNED} This message is a new conversation. Do not ask the owner to press Confirm and lock USDC.`;
    }
    const name = deal.selectedName?.trim() || `Agent ${deal.selectedAgentId ?? ""}`.trim();
    return `The hire with ${name} is already locked. USDC is locked for that hire. Do not ask the owner to press Confirm and lock USDC again. The task page shows the worker. This chat does not see the file text. A new request in this chat is not that hire.`;
  }
  if (deal.stage === "confirm") {
    return "An open hire has agreed terms. The owner presses Confirm and lock USDC for that hire. If the owner asks this agent to do different work, answer that request. Do not repeat the confirm line.";
  }
  const last = [...deal.turns].reverse().find((turn) => turn.role === "agent")?.text ?? "";
  if (last.startsWith("That hire is finished") || last.startsWith("That hire was rejected")) return `${last} This message is a new conversation.`;
  return "";
}

function card(hit: Suggestion): string {
  const price = hit.postedPrice ? `${hit.postedPrice} USDC` : "not posted";
  const skills = hit.skillLabels.length > 0 ? hit.skillLabels.join(", ") : "none listed";
  return `${hit.name}\nSkills ${skills}\n${hit.description}\nPosted price ${price}`;
}

function taskText(deal: Deal): string {
  const when = deal.agreedDeadline ?? deal.deadline ?? "";
  return dealWorkText({ brief: deal.brief, clarifications: deal.clarifications, constraints: deal.constraints, deadline: when });
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function askStructured(agentId: string, input: { name: string; instruction: string; schema: Record<string, unknown> }): Promise<unknown> {
  const registered = await agentPreferredModel(agentId, false);
  return sparkStructured({ ...input, model: conversationModel(registered) });
}

function modelLine(error: unknown): string {
  const message = error instanceof Error ? error.message : MODEL_KEY_LINE;
  return message.startsWith("The model key is missing") ? MODEL_KEY_LINE : message;
}

function workSoFar(deal: Deal): string {
  return [deal.brief, ...deal.clarifications].map((line) => line.trim()).filter(Boolean).join("\n");
}

/** Understand the work, then look for a worker. A missing substance becomes one question. */
async function clarifyThenSearch(deal: Deal): Promise<void> {
  if (clarifyGate({ action: "ask", question: "continue", asked: deal.ownerQuestions }) === "search") {
    await searchForBrief(deal, workSoFar(deal));
    return;
  }
  let parsed: unknown;
  try {
    parsed = await askStructured(deal.askingAgentId, {
      name: "brief",
      instruction: briefJudgmentInstruction({
        brief: deal.brief,
        clarifications: deal.clarifications,
        turns: deal.turns,
      }),
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["ask", "search"] },
          question: { type: "string" },
        },
        required: ["action", "question"],
      },
    });
  } catch (error) {
    say(deal, "agent", modelLine(error));
    deal.stage = "brief";
    return;
  }
  const record = parsed && typeof parsed === "object" ? (parsed as { action?: unknown; question?: unknown }) : {};
  const question = textField(record.question);
  if (!usableWorkQuestion(question) || clarifyGate({ action: textField(record.action), question, asked: deal.ownerQuestions }) === "search") {
    await searchForBrief(deal, workSoFar(deal));
    return;
  }
  deal.ownerQuestions += 1;
  deal.pendingAsk = { from: "hirer", question };
  deal.stage = "brief";
  say(deal, "agent", question);
}

async function relayQuestion(deal: Deal, question: string): Promise<{ kind: "answer"; text: string } | { kind: "ask_owner" }> {
  const parsed = await askStructured(deal.askingAgentId, {
    name: "relay",
    instruction: [
      "You are the hiring agent. Answer the worker only from this deal.",
      "If the brief, clarifications, or thread already contain the fact, action is answer and answer is that fact.",
      "If you are not sure, action is ask_owner and answer is empty. Do not invent the fact. Do not set a price.",
      `Question: ${question}`,
      `Brief: ${deal.brief}`,
      deal.constraints ? `Limits: ${deal.constraints}` : "",
      deal.clarifications.length ? `Clarified:\n${deal.clarifications.join("\n")}` : "",
      deal.turns.length ? `Thread:\n${deal.turns.map((turn) => `${turn.role === "human" ? "Owner" : "Asking agent"}: ${turn.text}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["answer", "ask_owner"] },
        answer: { type: "string" },
      },
      required: ["action", "answer"],
    },
  });
  const record = parsed && typeof parsed === "object" ? (parsed as { action?: string; answer?: string }) : null;
  return relayDecision(record);
}

async function poseWorkerQuestion(deal: Deal, question: string): Promise<void> {
  if (!usableWorkQuestion(question)) {
    deal.scopeReady = true;
    await negotiate(deal);
    return;
  }
  if (scopeGate({ action: "ask", question, asked: deal.workerQuestions }) === "ready") {
    deal.scopeReady = true;
    say(deal, "agent", "I have the limits you set. Set the terms again if you want another offer. No USDC moves.");
    return;
  }
  let relay: { kind: "answer"; text: string } | { kind: "ask_owner" };
  try {
    relay = await relayQuestion(deal, question);
  } catch (error) {
    say(deal, "agent", modelLine(error));
    deal.stage = "terms";
    return;
  }
  if (relay.kind === "answer") {
    deal.workerQuestions += 1;
    deal.clarifications.push(relay.text);
    return;
  }
  deal.workerQuestions += 1;
  deal.pendingAsk = { from: "worker", question };
  deal.stage = "terms";
  say(deal, "agent", `The other agent asks: ${question} I don't have that in this deal, so I need your answer.`);
}

async function clarifyWithWorker(deal: Deal): Promise<void> {
  while (scopeGate({ action: "ask", question: "continue", asked: deal.workerQuestions }) === "ask") {
    let parsed: unknown;
    try {
      parsed = await askStructured(deal.askingAgentId, {
        name: "scope",
        instruction: scopeInstruction({
          brief: deal.brief,
          constraints: deal.constraints,
          clarifications: deal.clarifications,
          turns: deal.turns,
        }),
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["ask", "ready"] },
            question: { type: "string" },
          },
          required: ["action", "question"],
        },
      });
    } catch (error) {
      say(deal, "agent", modelLine(error));
      deal.stage = "terms";
      return;
    }
    const record = parsed && typeof parsed === "object" ? (parsed as { action?: unknown; question?: unknown }) : {};
    const question = textField(record.question);
    if (!usableWorkQuestion(question) || scopeGate({ action: textField(record.action), question, asked: deal.workerQuestions }) === "ready") break;
    const before = deal.workerQuestions;
    await poseWorkerQuestion(deal, question);
    if (deal.pendingAsk || deal.workerQuestions === before) return;
  }
  deal.scopeReady = true;
  await negotiate(deal);
}

function listed(agentId: string, hits: { agentId: string }[]): void {
  try {
    assertListedSuggestion(agentId, hits);
  } catch (error) {
    throw new DealError(error instanceof Error ? error.message : "That agent was not in the search.", 400);
  }
}

function requireOwnerDeal(deal: Deal | null, owner: string): Deal {
  if (!deal) throw new DealError("Describe the work first.", 400);
  if (getAddress(deal.payer) !== getAddress(owner)) throw new DealError("Only the owner of this agent can move the deal.", 403);
  return deal;
}

async function requireAskingAgent(owner: string, agentId: string): Promise<void> {
  if (!/^\d+$/.test(agentId) || agentId === "0") throw new DealError("Agent id must be a positive integer.", 400);
  const owned = await ownedAgent(owner, agentId);
  if (!owned) throw new DealError("Agent not found.", 404);
}

async function workerAccount(agentId: string): Promise<{ paused: boolean; hirePrice: string }> {
  try {
    const worker = await publicAgent(agentId);
    return {
      paused: worker.paused,
      hirePrice: worker.hirePrice,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "This agent is not available.";
    if (message.includes("no OASF record") || message.includes("not on the identity registry") || message.includes("not on the registry yet")) {
      throw new DealError("This agent is not available.", 400);
    }
    throw new DealError(message, 400);
  }
}

async function searchForBrief(deal: Deal, brief: string): Promise<void> {
  const scan = scanUntrusted(brief);
  if (!scan.allow) throw new DealError(scan.reason, 400);
  let catalog;
  try {
    catalog = await loadSkillCatalog();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the OASF skill taxonomy.";
    say(deal, "agent", message);
    deal.stage = "brief";
    deal.suggestions = [];
    return;
  }
  const facts = catalog.map((skill) => ({
    id: skill.id,
    name: skill.name,
    caption: skill.caption || skill.name,
    description: skill.description,
  }));
  const captions = new Map(facts.map((skill) => [skill.id, skill.caption]));
  let found;
  try {
    found = await directorySearch();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The directory node is unreachable.";
    say(deal, "agent", message);
    deal.stage = "brief";
    deal.suggestions = [];
    return;
  }
  deal.directoryNote = found.note;
  const roster = (found.hits as SearchHit[]).filter((hit) => hit.agentId !== deal.askingAgentId);
  if (roster.length === 0) {
    const note = found.note;
    say(deal, "agent", note.startsWith("Directory ") || note.startsWith("Set DIRECTORY_CLIENT_SERVER_ADDRESS") ? note : "No confirmed agent is published.");
    deal.stage = "brief";
    deal.suggestions = [];
    return;
  }
  const covered = new Set(roster.flatMap((hit) => skillsCoveredBy(hit.skillIds, facts).map((skill) => skill.id)));
  const lines = capabilityRosterLines(
    roster.map((hit) => ({
      agentId: hit.agentId,
      name: hit.displayName || `Agent ${hit.agentId}`,
      description: hit.description,
      skillIds: hit.skillIds,
    })),
    facts,
  );
  let parsed: unknown;
  try {
    parsed = await askStructured(deal.askingAgentId, {
      name: "skills",
      instruction: capabilitySkillInstruction(brief, lines),
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { skillIds: { type: "array", items: { type: "integer" } } },
        required: ["skillIds"],
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : MODEL_KEY_LINE;
    say(deal, "agent", message.startsWith("The model key is missing") ? MODEL_KEY_LINE : message);
    deal.stage = "brief";
    deal.suggestions = [];
    return;
  }
  const skillIds = skillIdsFromModel(JSON.stringify(parsed), covered).slice(0, 5);
  if (skillIds.length === 0) {
    say(deal, "agent", "I could not match that request to a skill the published agents cover. Say more about the work.");
    deal.stage = "brief";
    deal.suggestions = [];
    return;
  }
  const suggestions: Suggestion[] = roster.map((hit) => ({
    agentId: hit.agentId,
    name: hit.displayName || `Agent ${hit.agentId}`,
    description: hit.description,
    skillIds: hit.skillIds,
    skillLabels: hit.skillIds.map((id) => captions.get(id) ?? String(id)),
    postedPrice: hit.hirePrice,
  }));
  let ordered = rankBySkillAndDescription(suggestions, skillIds, facts, brief);
  let reason = "";
  if (ordered.length > 1) {
    try {
      const picked = await askStructured(deal.askingAgentId, {
        name: "worker",
        instruction: bestWorkerInstruction(brief, ordered.map((hit) => card(hit))),
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { agentId: { type: "string" }, reason: { type: "string" } },
          required: ["agentId", "reason"],
        },
      });
      const raw = JSON.stringify(picked);
      const id = chosenWorkerId(raw, new Set(ordered.map((hit) => hit.agentId)));
      reason = id ? workerReason(raw) : "";
      ordered = promoteChosenWorker(ordered, id);
    } catch {
      reason = "";
    }
  }
  deal.suggestions = ordered;
  for (const item of deal.suggestions) {
    const coverage = coverageReasons(item.skillIds, item.skillLabels, skillIds, facts).join(", ");
    item.matchNote = item === deal.suggestions[0] && reason ? reason : coverage;
  }
  deal.rejected = [];
  const current = nextSuggestion(deal.suggestions, [], deal.askingAgentId);
  if (!current) {
    say(deal, "agent", "No confirmed agent has a skill that covers that work. Say more about the work.");
    deal.stage = "brief";
    deal.suggestions = [];
    return;
  }
  const because = current.matchNote ? ` They match ${current.matchNote}.` : "";
  say(deal, "agent", `I can suggest this agent.${because}\n${card(current)}\nAccept or reject this agent. I will ask for your USDC budget after you accept. No USDC has moved.`);
  deal.stage = "suggest";
}

async function negotiate(deal: Deal): Promise<void> {
  if (!deal.selectedAgentId || !deal.budgetUsdc || !deal.budgetLabel || !deal.deadline) {
    throw new DealError("Set the budget and deadline first.", 400);
  }
  if (deal.selectedAgentId === deal.askingAgentId) {
    deal.stage = "stopped";
    say(deal, "agent", "That agent was not in the search. No USDC moves.");
    return;
  }
  if (!roomForRound(deal.offers.length) || deal.offers.length >= MAX_OFFERS) {
    const standing = lastOffer(deal);
    if (standing && deal.budgetUsdc && BigInt(standing.priceUsdc) <= BigInt(deal.budgetUsdc)) {
      await agreeAt(deal, standing.priceUsdc, standing.deadline, standing.reason || "The worker's posted price stands.");
      return;
    }
    deal.stage = "stopped";
    deal.pendingCounter = null;
    say(deal, "agent", "We did not reach a deal. Say continue if you want another offer. No USDC moves.");
    return;
  }
  const worker = await workerAccount(deal.selectedAgentId);
  if (worker.paused) {
    deal.stage = "stopped";
    say(deal, "agent", "Agent is paused. No USDC moves.");
    return;
  }
  let posted = "0";
  try {
    posted = parseUsdc(worker.hirePrice);
  } catch {
    posted = "0";
  }
  const offerCheck = offerInsideLimits({
    budget: deal.budgetUsdc,
    posted,
  });
  if (!offerCheck.ok) {
    deal.stage = "terms";
    say(deal, "agent", `${offerCheck.reason} Set a budget the worker can accept. No USDC moves.`);
    return;
  }
  const offerLabel = formatUsdc(offerCheck.price);
  const limitNote = offerCheck.limitedBy === "budget"
    ? ` The offer is ${offerLabel} USDC, inside your budget and under the worker's posted price.`
    : ` The offer is ${offerLabel} USDC, the worker's posted price, inside your ${deal.budgetLabel} USDC budget.`;
  const offer: DealOffer = {
    side: "buyer",
    action: "offer",
    priceUsdc: offerCheck.price,
    priceLabel: offerLabel,
    deadline: deal.deadline,
    reason: "Offer inside the owner's budget.",
  };
  deal.offers.push(offer);
  deal.stage = "negotiate";
  deal.pendingCounter = null;
  say(deal, "agent", `I offered ${offerLabel} USDC, deliver by ${deal.deadline}.${limitNote}`);
  let parsed: unknown;
  try {
    parsed = await askStructured(deal.askingAgentId, {
      name: "negotiation",
      instruction: negotiationInstruction({
        brief: deal.brief,
        constraints: deal.constraints,
        budgetLabel: deal.budgetLabel,
        deadline: deal.deadline,
        postedPrice: worker.hirePrice,
        clarifications: deal.clarifications,
        turns: deal.turns,
        offers: deal.offers,
      }),
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["accept", "refuse", "counter", "ask"] },
          price: { type: "string" },
          deadline: { type: "string" },
          reason: { type: "string" },
          question: { type: "string" },
        },
        required: ["action", "price", "deadline", "reason", "question"],
      },
    });
  } catch (error) {
    deal.offers.pop();
    const message = error instanceof Error ? error.message : MODEL_KEY_LINE;
    say(deal, "agent", message.startsWith("The model key is missing") ? MODEL_KEY_LINE : message);
    if (deal.offers.length === 0) deal.stage = "terms";
    return;
  }
  const asked = parsed && typeof parsed === "object" ? textField((parsed as { question?: unknown }).question) : "";
  const askedAction = parsed && typeof parsed === "object" ? textField((parsed as { action?: unknown }).action) : "";
  if (askedAction === "ask") {
    deal.offers.pop();
    if (!asked || !usableWorkQuestion(asked)) {
      await standOnOffer(deal);
      return;
    }
    if (deal.offers.length === 0) deal.stage = "terms";
    await poseWorkerQuestion(deal, asked);
    return;
  }
  await applyWorkerReply(deal, parsed);
}

function lastOffer(deal: Deal): DealOffer | null {
  return [...deal.offers].reverse().find((item) => item.side === "buyer" && item.action === "offer") ?? null;
}

async function agreeAt(deal: Deal, price: string, deadline: string, reason: string): Promise<void> {
  deal.offers.push({ side: "worker", action: "accept", priceUsdc: price, priceLabel: formatUsdc(price), deadline, reason });
  deal.agreedPriceUsdc = price;
  deal.agreedPriceLabel = formatUsdc(price);
  deal.agreedDeadline = deadline;
  deal.pendingCounter = null;
  deal.needsWindow = false;
  deal.stage = "confirm";
  say(deal, "agent", `Agreed at ${deal.agreedPriceLabel} USDC, deliver by ${deadline}. Press Confirm and lock USDC. The supervisor is deployed when you confirm. Your hiring agent does not see the work.`);
}

/** The posted offer already fits the budget and the cap. A missing model reply does not cancel it. */
async function standOnOffer(deal: Deal): Promise<void> {
  const offer = lastOffer(deal);
  if (!offer || !deal.budgetUsdc || BigInt(offer.priceUsdc) > BigInt(deal.budgetUsdc)) {
    deal.stage = "terms";
    deal.pendingCounter = null;
    say(deal, "agent", "The worker did not answer. Say continue and I will ask again. No USDC moves.");
    return;
  }
  await agreeAt(deal, offer.priceUsdc, offer.deadline, "The worker's posted price stands.");
}

async function applyWorkerReply(deal: Deal, parsed: unknown): Promise<void> {
  const reply = readReply(parsed);
  const offer = lastOffer(deal);
  if (!reply || !deal.budgetUsdc || !deal.deadline || !offer) {
    await standOnOffer(deal);
    return;
  }
  const scanned = scanUntrusted(reply.reason.slice(0, 2000));
  const reason = scanned.allow ? reply.reason.slice(0, 400) : "The reply was refused by the scanner.";
  if (reply.action === "refuse") {
    deal.offers.push({
      side: "worker",
      action: "refuse",
      priceUsdc: offer.priceUsdc,
      priceLabel: offer.priceLabel,
      deadline: offer.deadline,
      reason,
    });
    deal.stage = "stopped";
    deal.pendingCounter = null;
    say(deal, "agent", `${reason} Say continue to ask again. No USDC moves.`);
    return;
  }
  const parsedPrice = reply.priceText ? parseOfferAmount(reply.priceText) : null;
  if (reply.priceText && !parsedPrice) {
    await standOnOffer(deal);
    return;
  }
  if (!parsedPrice && reply.action === "counter") {
    await standOnOffer(deal);
    return;
  }
  const price = parsedPrice ?? offer.priceUsdc;
  let deadlineMs = Date.parse(offer.deadline);
  if (reply.deadlineText) {
    deadlineMs = ownerDeadlineMs(reply.deadlineText, Date.now()) ?? Date.parse(reply.deadlineText);
    if (Number.isNaN(deadlineMs)) {
      await standOnOffer(deal);
      return;
    }
  } else if (reply.action === "counter") {
    await standOnOffer(deal);
    return;
  }
  const timing = reviewDeadline(deadlineMs, Date.now());
  if (timing === "past") {
    deal.stage = "stopped";
    deal.pendingCounter = null;
    say(deal, "agent", "The other agent returned a deadline that has passed. No USDC moves.");
    return;
  }
  const deadline = new Date(deadlineMs).toISOString();
  if (workerAcceptsOffer({
    action: reply.action,
    price,
    offerPrice: offer.priceUsdc,
    budget: deal.budgetUsdc,
    deadlineMs,
    offerDeadlineMs: Date.parse(offer.deadline),
  }) && timing === "ok") {
    await agreeAt(deal, price, deadline, reason || "Accepted the offer.");
    return;
  }
  deal.offers.push({ side: "worker", action: "counter", priceUsdc: price, priceLabel: formatUsdc(price), deadline, reason });
  deal.pendingCounter = { priceUsdc: price, priceLabel: formatUsdc(price), deadline, reason };
  deal.needsWindow = timing === "beyond-lock";
  deal.stage = "negotiate";
  const window = timing === "beyond-lock" ? ` ${SEVEN_DAY_LOCK}` : "";
  say(deal, "agent", `The other agent asks for ${formatUsdc(price)} USDC by ${deadline}. ${reason}${window} That change comes back to you.`);
}

function readReply(value: unknown): { action: "accept" | "refuse" | "counter"; priceText: string; deadlineText: string; reason: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action.trim().toLowerCase() : "";
  if (action !== "accept" && action !== "refuse" && action !== "counter") return null;
  return {
    action,
    priceText: typeof record.price === "string" ? record.price.trim() : "",
    deadlineText: typeof record.deadline === "string" ? record.deadline.trim() : "",
    reason: typeof record.reason === "string" ? record.reason : "",
  };
}

async function acceptCounter(deal: Deal): Promise<void> {
  const counter = deal.pendingCounter;
  if (!counter || !deal.selectedAgentId || !deal.budgetUsdc || !deal.deadline) {
    throw new DealError("There is no counter to accept.", 400);
  }
  const worker = await workerAccount(deal.selectedAgentId);
  if (worker.paused) {
    deal.stage = "stopped";
    say(deal, "agent", "Agent is paused. No USDC moves.");
    return;
  }
  const deadlineMs = Date.parse(counter.deadline);
  const timing = reviewDeadline(deadlineMs, Date.now());
  if (timing === "past") {
    deal.stage = "stopped";
    deal.pendingCounter = null;
    say(deal, "agent", "That deadline has passed. No USDC moves.");
    return;
  }
  if (timing === "beyond-lock") {
    if (BigInt(counter.priceUsdc) > BigInt(deal.budgetUsdc)) {
      deal.budgetUsdc = counter.priceUsdc;
      deal.budgetLabel = counter.priceLabel;
    }
    deal.deadline = new Date(Date.now() + LOCK_WINDOW_MS).toISOString();
    deal.pendingCounter = null;
    deal.needsWindow = false;
    say(deal, "agent", `${SEVEN_DAY_LOCK} I will offer that window at ${deal.budgetLabel} USDC.`);
    await negotiate(deal);
    return;
  }
  if (BigInt(counter.priceUsdc) > BigInt(deal.budgetUsdc)) {
    deal.budgetUsdc = counter.priceUsdc;
    deal.budgetLabel = counter.priceLabel;
  }
  if (deadlineMs > Date.parse(deal.deadline)) deal.deadline = counter.deadline;
  deal.agreedPriceUsdc = counter.priceUsdc;
  deal.agreedPriceLabel = counter.priceLabel;
  deal.agreedDeadline = counter.deadline;
  deal.pendingCounter = null;
  deal.needsWindow = false;
  deal.stage = "confirm";
  say(deal, "agent", `You accepted ${counter.priceLabel} USDC, deliver by ${counter.deadline}. Press Confirm and lock USDC. The supervisor is deployed when you confirm. Your hiring agent does not see the work.`);
}

async function seatSupervisor(deal: Deal): Promise<void> {
  if (!deal.selectedAgentId) throw new DealError("Accept an agent before setting the budget.", 400);
  try {
    const supervisor = await requireDealSupervisor({
      hiringAgentId: deal.askingAgentId,
      workerAgentId: deal.selectedAgentId,
      hirer: deal.payer,
    });
    deal.supervisorAgentId = supervisor.id;
    deal.supervisorName = supervisor.name || `Agent ${supervisor.id}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "This deal needs a deployed supervisor agent.";
    throw new DealError(message, error instanceof HireError ? error.status : 409);
  }
}

async function confirmDeal(deal: Deal): Promise<Awaited<ReturnType<typeof quoteHire>>> {
  if (deal.stage !== "confirm" || !deal.selectedAgentId || !deal.budgetUsdc) {
    throw new DealError("Confirm the deal before the hire quote.", 400);
  }
  const amount = agreedLockAmount({
    stage: deal.stage,
    agreedPriceUsdc: deal.agreedPriceUsdc,
    postedPriceUsdc: deal.budgetUsdc,
  });
  const agreedTiming = reviewDeadline(Date.parse(deal.agreedDeadline ?? ""), Date.now());
  if (agreedTiming !== "ok") throw new DealError(agreedTiming === "beyond-lock" ? SEVEN_DAY_LOCK : "Enter a delivery deadline in the future.", 400);
  const worker = await workerAccount(deal.selectedAgentId);
  if (worker.paused) throw new DealError("Agent is paused.", 403);
  const check = assessPrice({ price: amount, budget: deal.budgetUsdc });
  if (!check.ok) throw new DealError(check.reason, 403);
  await seatSupervisor(deal);
  const quote = await quoteHire({
    payer: deal.payer,
    agentId: deal.selectedAgentId,
    hiringAgentId: deal.askingAgentId,
    criteria: taskText(deal),
    longHorizon: deal.longHorizon === true,
    agreedAmountUsdc: amount,
    deadline: deal.agreedDeadline ?? undefined,
  });
  deal.hireId = quote.hireId;
  return quote;
}

async function markLocked(deal: Deal, taskId: string): Promise<void> {
  if (deal.stage !== "confirm" || !deal.agreedPriceUsdc || !deal.selectedAgentId) {
    throw new DealError("Confirm the deal before the hire quote.", 400);
  }
  const task = (await desk()).tasks.get(taskId);
  const payer = task?.lock?.payer;
  if (!task || task.workerAgentId !== deal.selectedAgentId || task.amount.toString() !== deal.agreedPriceUsdc || !payer) {
    throw new DealError("That hire is not this deal.", 400);
  }
  if (getAddress(payer) !== getAddress(deal.payer)) throw new DealError("That hire is not this deal.", 400);
  deal.stage = "locked";
  deal.taskId = task.id;
  deal.hireId = task.id;
  say(deal, "agent", "Your wallet locked the USDC. The hired agent's owner can see the task.");
}

export function summarizeHire(deal: DealView): string {
  if (deal.pendingAsk?.question) return `The hire is open. Ask the owner: ${deal.pendingAsk.question} When they answer, call run_hire with action answer. No USDC has moved.`;
  if (deal.current) {
    const price = deal.current.postedPrice ? `${deal.current.postedPrice} USDC` : "not posted";
    const match = deal.current.matchNote ? ` They match ${deal.current.matchNote}.` : "";
    return `The hire is open. Suggested agent ${deal.current.name}, id ${deal.current.agentId}.${match} ${deal.current.description} Posted price ${price}. Ask the owner to accept or reject this agent. Do not ask for a USDC budget before they accept. Call run_hire with action accept or reject and this agentId. No USDC has moved.`;
  }
  if (deal.stage === "terms") return "The owner chose an agent. If they have not given a USDC budget and a delivery deadline, ask for those and any other limit. Then call run_hire with action terms, the budget, and the deadline. That starts the conversation with the worker. No USDC has moved.";
  if (deal.stage === "negotiate" && deal.pendingCounter) return `The other agent asks for ${deal.pendingCounter.priceLabel} USDC by ${deal.pendingCounter.deadline}. ${deal.pendingCounter.reason} Call run_hire with action accept-counter or reject-counter. No USDC has moved.`;
  if (deal.stage === "confirm") return "The terms are agreed. Tell the owner to press Confirm and lock USDC. The supervisor is deployed when they confirm. The lock covers seven days. You cannot lock USDC from this turn. No USDC has moved.";
  if (deal.stage === "stopped" && deal.selectedAgentId) return "The hire with the selected agent is still open. Say continue. A price that already fits the budget closes the terms. Then the owner presses Confirm and lock USDC. The supervisor is deployed when they confirm. No USDC has moved.";
  const last = [...deal.turns].reverse().find((turn) => turn.role === "agent")?.text ?? "";
  return last ? `${last}\nNo USDC has moved.` : "The hire brief is saved. No USDC has moved.";
}

function ownerFacing(deal: Deal): string {
  const last = [...deal.turns].reverse().find((turn) => turn.role === "agent")?.text.trim() ?? "";
  if (!last) return "No USDC has moved.";
  return /No USDC has moved\.?$/.test(last) ? last : `${last}\nNo USDC has moved.`;
}

/** Applies the owner's latest line to the open hire. The conversation does not have to call the tool. */
export async function continueOpenHire(owner: string, agentId: string, message: string, earlierOwnerText: string): Promise<string | null> {
  if (isSaveConfirmation(message)) return null;
  const view = await readOwnedDeal(owner, agentId);
  if (!view) return null;
  const decision = decideHireContinuation({
    stage: view.stage,
    pendingAsk: Boolean(view.pendingAsk),
    pendingCounter: Boolean(view.pendingCounter),
    currentAgentId: view.current?.agentId ?? view.selectedAgentId,
    statedBudget: view.statedBudget ?? view.budgetLabel,
    statedConstraints: view.statedConstraints || view.constraints,
    message,
    earlierOwnerText,
    now: Date.now(),
  });
  if (!decision) return null;
  if (decision.kind === "replace") {
    if (view.stage === "locked") return "USDC is already locked for that hire. The task page settles it. This chat cannot cancel the lock.";
    if (decision.cancelOnly) return advanceHire(owner, agentId, { action: "cancel" });
    const hadOpenHire = (view.stage !== "brief" && view.stage !== "stopped") || Boolean(view.selectedAgentId);
    await startHireBrief(owner, agentId, decision.brief);
    const open = await loadDeal(agentId);
    if (!open || getAddress(open.payer) !== getAddress(owner)) return hadOpenHire ? "That hire is cancelled. No USDC has moved." : "No USDC has moved.";
    const spoken = ownerFacing(open);
    if (!hadOpenHire || spoken.startsWith("That hire is cancelled")) return spoken;
    return `That hire is cancelled. No USDC has moved.\n${spoken}`;
  }
  const revising = Boolean(ownerBudgetLabel(message)) || ownerDeadlineMs(message, Date.now()) !== null;
  const declining = /^\s*(reject|no|decline|pass)\b/i.test(message);
  if (view.stage === "negotiate" && !view.pendingAsk && !view.pendingCounter && !revising && !declining && decision.kind !== "answer") {
    const open = await loadDeal(agentId);
    const offer = open ? lastOffer(open) : null;
    if (open && getAddress(open.payer) === getAddress(owner) && offer && open.budgetUsdc && open.selectedAgentId && BigInt(offer.priceUsdc) <= BigInt(open.budgetUsdc)) {
      await agreeAt(open, offer.priceUsdc, offer.deadline, offer.reason || "The worker's posted price stands.");
      await saveDeal(open);
      return ownerFacing(open);
    }
  }
  if (decision.kind === "hold") {
    const open = await loadDeal(agentId);
    const namedDay = statedDeadline(message, null, Date.now());
    if (open && getAddress(open.payer) === getAddress(owner) && open.stage === "confirm" && namedDay && open.agreedPriceUsdc) {
      const timing = reviewDeadline(Date.parse(namedDay), Date.now());
      if (timing !== "ok") return timing === "beyond-lock" ? `${SEVEN_DAY_LOCK} No USDC has moved.` : "Give me a delivery day in the future. No USDC has moved.";
      open.deadline = namedDay;
      open.agreedDeadline = namedDay;
      const offer = lastOffer(open);
      if (offer) offer.deadline = namedDay;
      say(open, "agent", `Agreed at ${open.agreedPriceLabel} USDC, deliver by ${namedDay}. Press Confirm and lock USDC. The supervisor is deployed when you confirm. Your hiring agent does not see the work.`);
      await saveDeal(open);
      return ownerFacing(open);
    }
    return decision.say;
  }
  if (decision.kind === "status") return ownerFacing(view);
  if (decision.kind === "resume") {
    const open = await loadDeal(agentId);
    if (!open || getAddress(open.payer) !== getAddress(owner) || !open.selectedAgentId || !open.budgetLabel || !open.deadline) {
      return "Say accept for the suggested agent, then give a USDC budget and a delivery day. No USDC has moved.";
    }
    const standing = lastOffer(open);
    const budgetText = ownerBudgetLabel(message) ?? open.budgetLabel;
    let budgetUnits = open.budgetUsdc;
    try {
      budgetUnits = parseUsdc(budgetText);
    } catch {
      budgetUnits = open.budgetUsdc;
    }
    const deadline = statedDeadline(message, open.deadline, Date.now()) ?? open.deadline;
    if (standing && budgetUnits && deadline && BigInt(standing.priceUsdc) <= BigInt(budgetUnits)) {
      open.budgetUsdc = budgetUnits;
      open.budgetLabel = formatUsdc(budgetUnits);
      open.deadline = deadline;
      await agreeAt(open, standing.priceUsdc, deadline, standing.reason || "The worker's posted price stands.");
      await saveDeal(open);
      return ownerFacing(open);
    }
    if (open.stage === "stopped") {
      open.stage = "terms";
      open.pendingCounter = null;
      await saveDeal(open);
    }
    try {
      const { deal } = await handleDeal(owner, agentId, {
        action: "terms",
        budget: budgetText,
        deadline,
        constraints: open.constraints || open.statedConstraints,
      });
      return ownerFacing(deal);
    } catch (error) {
      if (error instanceof DealError || error instanceof HireError) return error.message;
      throw error;
    }
  }
  if (decision.kind === "draft") {
    const deal = await loadDeal(agentId);
    if (!deal || getAddress(deal.payer) !== getAddress(owner)) return null;
    if (decision.budget) deal.statedBudget = decision.budget;
    if (decision.constraints) deal.statedConstraints = decision.constraints;
    say(deal, "agent", decision.ask);
    await saveDeal(deal);
    return ownerFacing(deal);
  }
  const args: Record<string, unknown> =
    decision.kind === "accept" ? { action: "accept", agentId: decision.agentId }
    : decision.kind === "reject" ? { action: "reject", agentId: decision.agentId }
    : decision.kind === "answer" ? { action: "answer", answer: decision.answer }
    : decision.kind === "counter-accept" ? { action: "accept-counter" }
    : decision.kind === "counter-reject" ? { action: "reject-counter" }
    : { action: "terms", budget: decision.budget, deadline: decision.deadline, constraints: decision.constraints };
  try {
    const { deal } = await handleDeal(owner, agentId, args);
    if (decision.kind === "accept") {
      const follow = decideHireContinuation({
        stage: "terms",
        pendingAsk: false,
        pendingCounter: false,
        currentAgentId: deal.selectedAgentId,
        statedBudget: deal.statedBudget ?? deal.budgetLabel,
        statedConstraints: deal.statedConstraints || deal.constraints,
        message: earlierOwnerText,
        earlierOwnerText: "",
        now: Date.now(),
      });
      if (follow?.kind === "terms") {
        const next = await handleDeal(owner, agentId, {
          action: "terms",
          budget: follow.budget,
          deadline: follow.deadline,
          constraints: follow.constraints,
        });
        return ownerFacing(next.deal);
      }
    }
    return ownerFacing(deal);
  } catch (error) {
    if (error instanceof DealError || error instanceof HireError) return error.message;
    throw error;
  }
}

/** Moves the owner's hire from chat. Confirm and the wallet lock stay with the owner. */
export async function advanceHire(owner: string, agentId: string, args: Record<string, unknown>): Promise<string> {
  const action = typeof args.action === "string" ? args.action.trim() : "status";
  if (!action || action === "status") {
    const deal = await readOwnedDeal(owner, agentId);
    return deal ? summarizeHire(deal) : "No hire is open. Call run_hire with action brief and the work.";
  }
  if (action === "confirm" || action === "locked") return "The owner presses Confirm and lock USDC. Their wallet locks the USDC. You cannot lock it from this turn.";
  if (action === "cancel") {
    const current = await readOwnedDeal(owner, agentId);
    if (!current) return "No hire is open. No USDC has moved.";
    if (current.stage === "locked") return "USDC is already locked for that hire. The task page settles it. This chat cannot cancel the lock.";
    const deal = await loadDeal(agentId);
    if (!deal || getAddress(deal.payer) !== getAddress(owner)) return "No hire is open. No USDC has moved.";
    const cleared = blank(agentId, deal.payer);
    cleared.stage = "stopped";
    cleared.turns = [{ role: "agent", text: "That hire is cancelled. No USDC has moved." }];
    await saveDeal(cleared);
    return "That hire is cancelled. No USDC has moved. Say what the next hire should do.";
  }
  if (action === "brief") {
    const brief = typeof args.brief === "string" ? args.brief.trim() : "";
    if (!brief) return "Say what the hired agent should do.";
    if (brief.length > 8000) return "That hire request is too long.";
    const scan = scanUntrusted(brief);
    if (!scan.allow) return scan.reason;
    return startHireBrief(owner, agentId, brief);
  }
  const { deal } = await handleDeal(owner, agentId, args);
  return summarizeHire(deal);
}

export function ownerHireTool(owner: string, agentId: string): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
} {
  return {
    name: "run_hire",
    description: "Granted on this turn. Search confirmed Directory agents by the OASF skills they published and by each agent's description. A published skill covers the skills inside it. Read the description to choose the agent best suited to the work. action brief starts the search from the work the owner described. Before USDC is locked, a new brief cancels the open hire. action cancel drops that unlocked hire. A locked hire stays locked. action status reads the hire. action answer sends the owner's answer. action accept or reject takes the suggested agentId. action terms takes budget and deadline. action accept-counter or reject-counter answers a counter. This does not lock USDC.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string" },
        brief: { type: "string" },
        answer: { type: "string" },
        agentId: { type: "string" },
        budget: { type: "string" },
        deadline: { type: "string" },
        constraints: { type: "string" },
      },
      required: ["action"],
    },
    run: async (args) => {
      try {
        return await advanceHire(owner, agentId, args);
      } catch (error) {
        if (error instanceof DealError || error instanceof HireError) return error.message;
        throw error;
      }
    },
  };
}

/** Starts the owner's hire. An unlocked hire is cancelled first. A locked hire stays. */
export async function startHireBrief(owner: string, agentId: string, brief: string): Promise<string> {
  const current = await readOwnedDeal(owner, agentId);
  if (current?.stage === "locked") {
    const name = current.selectedName || "the selected agent";
    return `The hire with ${name} is already locked. USDC is locked for that hire. The task page settles it. This message does not start a new search.`;
  }
  const replacing = Boolean(
    current && current.stage !== "brief" && (current.selectedAgentId || current.stage === "suggest" || current.stage === "confirm" || current.stage === "terms" || current.stage === "negotiate"),
  );
  const { deal } = await handleDeal(owner, agentId, { action: "brief", brief });
  const lead = replacing ? "That hire is cancelled. No USDC has moved. " : "";
  return `${lead}${summarizeHire(deal)}`;
}

export async function readOwnedDeal(owner: string, agentId: string): Promise<DealView | null> {
  await requireAskingAgent(owner, agentId);
  const deal = await loadDeal(agentId);
  if (!deal || getAddress(deal.payer) !== getAddress(owner)) return null;
  return presentDeal(deal);
}

export async function handleDeal(owner: string, agentId: string, body: unknown): Promise<{ deal: DealView; payment?: Awaited<ReturnType<typeof quoteHire>> }> {
  await requireAskingAgent(owner, agentId);
  const command = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const action = typeof command.action === "string" ? command.action : "";
  const payer = getAddress(owner);
  let deal = action === "brief" ? blank(agentId, payer) : requireOwnerDeal(await loadDeal(agentId), payer);
  if (action !== "brief" && action !== "answer" && deal.pendingAsk) throw new DealError("Answer the question first.", 400);
  let payment: Awaited<ReturnType<typeof quoteHire>> | undefined;
  if (action === "brief") {
    const brief = typeof command.brief === "string" ? command.brief.trim() : "";
    if (!brief) throw new DealError("Describe the work.", 400);
    if (brief.length > 8000) throw new DealError("Task text is too long.", 400);
    deal.brief = brief;
    say(deal, "human", brief);
    await clarifyThenSearch(deal);
  } else if (action === "reject") {
    if (deal.stage !== "suggest") throw new DealError("There is no suggestion to reject.", 400);
    const selected = typeof command.agentId === "string" ? command.agentId : "";
    listed(selected, deal.suggestions);
    if (!deal.rejected.includes(selected)) deal.rejected.push(selected);
    const current = nextSuggestion(deal.suggestions, deal.rejected, deal.askingAgentId);
    if (!current) {
      deal.stage = "brief";
      say(deal, "agent", "No other confirmed agent is left. Say more about the work.");
    } else {
      const because = current.matchNote ? ` They match ${current.matchNote}.` : "";
      say(deal, "agent", `I can suggest this agent.${because}\n${card(current)}`);
    }
  } else if (action === "accept") {
    if (deal.stage !== "suggest") throw new DealError("There is no suggestion to accept.", 400);
    const selected = typeof command.agentId === "string" ? command.agentId : "";
    listed(selected, deal.suggestions);
    if (selected === deal.askingAgentId || deal.rejected.includes(selected)) throw new DealError("That agent was not in the search.", 400);
    const hit = deal.suggestions.find((item) => item.agentId === selected);
    if (!hit) throw new DealError("That agent was not in the search.", 400);
    deal.selectedAgentId = hit.agentId;
    deal.selectedName = hit.name;
    deal.stage = "terms";
    deal.needsWindow = false;
    say(deal, "human", `Accept ${hit.name}.`);
    say(deal, "agent", "What budget, in USDC, should I stay inside? When must the work be delivered? Tell me any other limit. After that I will talk to the worker about the task and the deal. The escrow lock covers seven days. No USDC has moved.");
  } else if (action === "terms") {
    if (deal.stage !== "terms" && deal.stage !== "negotiate") throw new DealError("Accept an agent before setting the budget.", 400);
    const budgetText = typeof command.budget === "string" ? command.budget : "";
    const deadlineText = typeof command.deadline === "string" ? command.deadline : "";
    const constraints = typeof command.constraints === "string" ? command.constraints.trim() : "";
    if (constraints.length > 4000) throw new DealError("Those limits are too long.", 400);
    if (constraints) {
      const scan = scanUntrusted(constraints);
      if (!scan.allow) throw new DealError(scan.reason, 400);
    }
    const now = Date.now();
    const budgetLabel = ownerBudgetLabel(budgetText) ?? budgetText.trim().replace(/\s*usdc$/i, "");
    let budget: string;
    try {
      budget = parseUsdc(budgetLabel);
    } catch (error) {
      throw new DealError(error instanceof Error ? error.message : "Enter a USDC amount with up to 6 decimals.", 400);
    }
    const deadlineMs = ownerDeadlineMs(deadlineText, now) ?? Date.parse(deadlineText);
    const timing = reviewDeadline(deadlineMs, now);
    if (timing === "past") {
      deal.statedBudget = formatUsdc(budget);
      deal.statedConstraints = constraints || deal.statedConstraints;
      await saveDeal(deal);
      throw new DealError(`${deal.statedBudget} USDC is saved. Give me a delivery day in the future, or say as soon as possible.`, 400);
    }
    deal.budgetUsdc = budget;
    deal.budgetLabel = formatUsdc(budget);
    deal.constraints = constraints;
    deal.longHorizon = command.longHorizon === true;
    deal.pendingCounter = null;
    deal.agreedPriceUsdc = null;
    deal.agreedPriceLabel = null;
    deal.agreedDeadline = null;
    say(deal, "human", `Budget ${deal.budgetLabel} USDC. Deliver by ${new Date(deadlineMs).toISOString()}. ${constraints}`.trim());
    if (timing === "beyond-lock") {
      deal.deadline = new Date(deadlineMs).toISOString();
      deal.needsWindow = true;
      deal.stage = "terms";
      say(deal, "agent", SEVEN_DAY_LOCK);
    } else {
      deal.deadline = new Date(deadlineMs).toISOString();
      deal.needsWindow = false;
      if (deal.scopeReady) await negotiate(deal);
      else await clarifyWithWorker(deal);
    }
  } else if (action === "answer") {
    if (!deal.pendingAsk) throw new DealError("There is no question waiting.", 400);
    const answer = textField(command.answer);
    if (!answer) throw new DealError("Answer the question.", 400);
    if (answer.length > 4000) throw new DealError("That answer is too long.", 400);
    const scan = scanUntrusted(answer);
    if (!scan.allow) throw new DealError(scan.reason, 400);
    const from = deal.pendingAsk.from;
    deal.pendingAsk = null;
    deal.clarifications.push(answer);
    say(deal, "human", answer);
    if (from === "worker") {
      if (deal.scopeReady) await negotiate(deal);
      else await clarifyWithWorker(deal);
    } else await clarifyThenSearch(deal);
  } else if (action === "window") {
    if (!deal.needsWindow || !deal.budgetUsdc) throw new DealError("The deadline already fits the seven-day lock.", 400);
    deal.deadline = new Date(Date.now() + LOCK_WINDOW_MS).toISOString();
    deal.needsWindow = false;
    deal.pendingCounter = null;
    say(deal, "human", SEVEN_DAY_LOCK);
    if (deal.scopeReady) await negotiate(deal);
    else await clarifyWithWorker(deal);
  } else if (action === "accept-counter") {
    if (deal.stage !== "negotiate") throw new DealError("There is no counter to accept.", 400);
    await acceptCounter(deal);
  } else if (action === "reject-counter") {
    if (deal.stage !== "negotiate" || !deal.pendingCounter) throw new DealError("There is no counter to reject.", 400);
    deal.pendingCounter = null;
    deal.needsWindow = false;
    deal.stage = "stopped";
    say(deal, "human", "Reject the counter.");
    say(deal, "agent", "You rejected the counter. No USDC moves.");
  } else if (action === "confirm") {
    payment = await confirmDeal(deal);
  } else if (action === "locked") {
    const taskId = typeof command.taskId === "string" ? command.taskId : "";
    await markLocked(deal, taskId);
  } else {
    throw new DealError("Describe the work.", 400);
  }
  await saveDeal(deal);
  return { deal: presentDeal(deal), payment };
}

export function dealFailure(error: unknown): { message: string; status: number } {
  if (error instanceof DealError || error instanceof HireError) return { message: error.message, status: error.status };
  const message = error instanceof Error ? error.message : "Could not move the deal.";
  return { message, status: 400 };
}
