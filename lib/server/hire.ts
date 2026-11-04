import { randomBytes } from "node:crypto";
import { getAddress, isHex, recoverTypedDataAddress, type Address, type Hash, type Hex } from "viem";
import { AUTH_CAPTURE_ESCROW, IDENTITY_CHAIN_ID, USDC_BASE_SEPOLIA } from "../chain/constants";
import {
  assertEscrowTransaction,
  authorizeCall,
  buildHireLock,
  captureCall,
  hireRequirement,
  readUsdcDomain,
  receiveMessage,
  receiveWithAuthorizationTypes,
  voidCall,
  type HireLock,
  type ReceiveMessage,
  type UsdcDomain,
} from "../chain/commerce";
import { deleteDocument, readDocument, writeDocument } from "../db";
import { scanUntrusted } from "../gateway/firewall";
import { describeDelivery } from "../gateway/meta";
import { conversationModel } from "../gateway/models";
import { workerTaskText } from "../agent/profile";
import type { HireImageRef } from "../deal/forward";
import { formatUsdc, usdcLockRefusal } from "../protocol/usdc";
import { baseClient } from "../identity/chain";
import { desk, saveDesk } from "./desk";
import { ensurePlatformSupervisor, SupervisorDeployError } from "./supervisor-deploy";
import { acceptSupervisorReport, acceptSupervisorSuggestion, reviewInstruction, supervisorGuidance, supervisorSuggestionNote } from "./supervisor-report";
import { ensureArtifactKey, parseBundle, readSealedPlaintext } from "./hire-job";
import { hireProgress } from "../deal/progress";
import { dealMessages, dealWorkText, type DealMessage } from "../deal/thread";
import type { Network } from "../world/network";
import { ensureWorkspace } from "./workspace";
import { sealedToSupervisor, supervisorSeat } from "./supervisor-seat";
import { publicAgent } from "./register";
import { modelKeyMissing } from "./readiness";
import { publishHireStatus } from "./hire-status";
import { agentPreferredModel } from "./teach";
import { closeTaskBudget } from "./budget";
import { sandboxConfigured } from "./modal-job";

export class HireError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type PendingHire = {
  hireId: string;
  agentId: string;
  payer: Address;
  criteria: string;
  longHorizon: boolean;
  domain: UsdcDomain;
  lock: HireLock;
  /** Set only by a confirmed deal. A direct hire leaves this empty and locks the posted price. */
  agreedAmountUsdc?: string;
  deadline?: string;
  hiringAgentId?: string;
  supervisorAgentId?: string;
  files?: HireImageRef[];
};

function pendingKey(hireId: string): string {
  return `hire:${hireId}`;
}

function sameAddress(left: string, right: string): boolean {
  return getAddress(left) === getAddress(right);
}

export async function assertHireSignature(domain: UsdcDomain, message: ReceiveMessage, signature: Hex, payer: Address): Promise<void> {
  if (!isHex(signature, { strict: true }) || !sameAddress(message.from, payer)) {
    throw new HireError("Signature is not from the hirer.", 400);
  }
  if (signature.length !== 132) return;
  const signer = await recoverTypedDataAddress({
    domain,
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: getAddress(message.from),
      to: getAddress(message.to),
      value: BigInt(message.value),
      validAfter: BigInt(message.validAfter),
      validBefore: BigInt(message.validBefore),
      nonce: message.nonce,
    },
    signature,
  });
  if (!sameAddress(signer, payer)) throw new HireError("Signature is not from the hirer.", 400);
}

async function requirePayable(agentId: string, payer: Address, expectedAmount?: string, agreedAmount?: string) {
  const agent = await publicAgent(agentId);
  if (sameAddress(payer, agent.agentWallet)) {
    throw new HireError("The payer and the agent wallet must be different addresses.", 400);
  }
  const amount = agreedAmount ?? agent.hirePriceUsdc;
  if (!/^\d+$/.test(amount) || BigInt(amount) <= BigInt(0)) throw new HireError("Set a hire price above zero.", 400);
  if (expectedAmount && expectedAmount !== amount) throw new HireError("The hire price changed. Start again.", 409);
  if (agent.paused) throw new HireError("Agent is paused.", 403);
  return agent;
}

export async function requireDealSupervisor(input: { hiringAgentId: string; workerAgentId: string; hirer: string }) {
  const id = process.env.SUPERVISOR_AGENT_ID?.trim() ?? "";
  let supervisor;
  try {
    supervisor = id ? await publicAgent(id) : await ensurePlatformSupervisor();
  } catch (error) {
    if (error instanceof HireError) throw error;
    const message = error instanceof Error && error.message ? error.message.slice(0, 240) : "This deal needs a deployed supervisor agent.";
    throw new HireError(message, 409);
  }
  try {
    supervisorSeat({
      supervisorAgentId: supervisor.id,
      hiringAgentId: input.hiringAgentId,
      workerAgentId: input.workerAgentId,
      supervisorOwner: supervisor.owner,
      hirer: input.hirer,
    });
  } catch (error) {
    throw new HireError(error instanceof Error ? error.message : "This deal needs a deployed supervisor agent.", 409);
  }
  return supervisor;
}

const usdcBalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

async function assertPayerUsdc(payer: Address, amount: string) {
  let balance: bigint;
  try {
    balance = await baseClient().readContract({
      address: getAddress(USDC_BASE_SEPOLIA),
      abi: usdcBalanceAbi,
      functionName: "balanceOf",
      args: [payer],
    });
  } catch {
    throw new HireError("The USDC balance could not be read. No USDC has moved.", 503);
  }
  const refusal = usdcLockRefusal(balance, amount);
  if (refusal) throw new HireError(refusal, 409);
}

export async function quoteHire(input: {
  payer: string;
  agentId: string;
  criteria: string;
  longHorizon: boolean;
  agreedAmountUsdc?: string;
  deadline?: string;
  hiringAgentId?: string;
  files?: HireImageRef[];
}) {
  if (!sandboxConfigured()) throw new HireError("The hire sandbox is not deployed. No USDC has moved.", 409);
  const criteria = workerTaskText(input.criteria);
  if (!criteria) throw new HireError("Describe the task.", 400);
  if (criteria.length > 8000) throw new HireError("Task text is too long.", 400);
  const scan = scanUntrusted(criteria);
  if (!scan.allow) throw new HireError(scan.reason, 400);
  const payer = getAddress(input.payer);
  const priced = await requirePayable(input.agentId, payer, input.agreedAmountUsdc, input.agreedAmountUsdc);
  const supervisor = await requireDealSupervisor({
    hiringAgentId: input.hiringAgentId ?? "",
    workerAgentId: priced.id,
    hirer: payer,
  });
  if (sameAddress(supervisor.agentWallet, payer) || sameAddress(supervisor.agentWallet, priced.agentWallet)) {
    throw new HireError("The supervisor must be a different agent from the hiring agent and the hired agent.", 409);
  }
  const amount = input.agreedAmountUsdc ?? priced.hirePriceUsdc;
  await assertPayerUsdc(payer, amount);
  const domain = await readUsdcDomain();
  const hireId = randomBytes(16).toString("hex");
  const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
  const lock = buildHireLock({
    payer,
    receiver: getAddress(priced.agentWallet),
    amount,
    operator: payer,
    now: Math.floor(Date.now() / 1000),
    salt,
  });
  const pending: PendingHire = {
    hireId,
    agentId: priced.id,
    payer: getAddress(input.payer),
    criteria,
    longHorizon: input.longHorizon,
    domain,
    lock,
    agreedAmountUsdc: input.agreedAmountUsdc,
    deadline: input.deadline,
    hiringAgentId: input.hiringAgentId ?? "",
    supervisorAgentId: supervisor.id,
    files: input.files ?? [],
  };
  await writeDocument(pendingKey(hireId), JSON.stringify(pending));
  const message = receiveMessage(lock);
  return {
    error: "Payment required.",
    hireId,
    accepts: [hireRequirement(lock)],
    typedData: {
      domain,
      types: receiveWithAuthorizationTypes,
      primaryType: "ReceiveWithAuthorization" as const,
      message,
    },
    agent: { id: priced.id, name: priced.name, hirePrice: formatUsdc(amount) },
    supervisor: { id: supervisor.id, name: supervisor.name },
    authorize: { to: getAddress(AUTH_CAPTURE_ESCROW), chainId: IDENTITY_CHAIN_ID },
  };
}

async function loadPending(hireId: string, payer: Address): Promise<PendingHire> {
  if (!/^[0-9a-f]{32}$/.test(hireId)) throw new HireError("This hire quote expired. Start again.", 404);
  const raw = await readDocument(pendingKey(hireId));
  if (!raw) throw new HireError("This hire quote expired. Start again.", 404);
  const pending = JSON.parse(raw) as PendingHire;
  if (!sameAddress(pending.payer, payer)) throw new HireError("This quote belongs to a different wallet.", 403);
  if (!sameAddress(pending.lock.operator, payer)) throw new HireError("The hirer sends the escrow transaction.", 400);
  if (Math.floor(Date.now() / 1000) >= pending.lock.preApprovalExpiry) {
    throw new HireError("This quote expired. Start again.", 400);
  }
  return pending;
}

/** The signature is checked here. The hirer wallet sends the returned authorize call. */
export async function prepareAuthorize(input: { payer: string; hireId: string; signature: Hex }) {
  const payer = getAddress(input.payer);
  const pending = await loadPending(input.hireId, payer);
  await assertHireSignature(pending.domain, receiveMessage(pending.lock), input.signature, payer);
  const agent = await requirePayable(pending.agentId, payer, pending.lock.maxAmount, pending.agreedAmountUsdc);
  if (!sameAddress(agent.agentWallet, pending.lock.receiver)) {
    throw new HireError("The agent wallet changed. Start again.", 409);
  }
  return { error: "Payment required.", hireId: pending.hireId, authorize: authorizeCall(pending.lock, input.signature) };
}

export async function confirmHire(input: { payer: string; hireId: string; signature: Hex; authorizeTx: Hash }) {
  const payer = getAddress(input.payer);
  const net = await desk();
  const existing = net.tasks.get(input.hireId);
  if (existing?.authorizeTx && existing.paymentId) {
    if (!existing.lock || !sameAddress(existing.lock.payer, payer)) {
      throw new HireError("This quote belongs to a different wallet.", 403);
    }
    return { taskId: existing.id, authorizeTx: existing.authorizeTx, modelKeyMissing: modelKeyMissing() };
  }
  const pending = await loadPending(input.hireId, payer);
  await assertHireSignature(pending.domain, receiveMessage(pending.lock), input.signature, payer);
  const call = authorizeCall(pending.lock, input.signature);
  await assertEscrowTransaction(input.authorizeTx, payer, call.data);
  if (!pending.supervisorAgentId) throw new HireError("This deal has no supervisor agent.", 409);
  const task = net.openTask({
    id: pending.hireId,
    buyerAgentId: pending.payer,
    workerAgentId: pending.agentId,
    criteria: pending.criteria,
    amount: BigInt(pending.lock.maxAmount),
    longHorizon: pending.longHorizon,
    lock: pending.lock,
  });
  task.authorizeTx = input.authorizeTx;
  task.supervisorAgentId = pending.supervisorAgentId;
  task.hiringAgentId = pending.hiringAgentId ?? "";
  if (pending.deadline) task.deadline = pending.deadline;
  if (pending.files?.length) task.inputs = pending.files;
  const payment = net.authorizePayment({
    id: `pay-${pending.hireId}`,
    payer: pending.payer,
    receiver: pending.lock.receiver,
    amount: BigInt(pending.lock.maxAmount),
    taskId: task.id,
    expiry: pending.lock.authorizationExpiry * 1000,
  });
  net.markAuthorized(task.id, payment.id);
  net.noteSpend(pending.agentId, BigInt(pending.lock.maxAmount));
  await saveDesk(net);
  await deleteDocument(pendingKey(pending.hireId));
  return { taskId: task.id, authorizeTx: input.authorizeTx, modelKeyMissing: modelKeyMissing() };
}

export function supervisorHasReviewed(task: { artifactCid: string | null; supervisorReport?: string | null }): boolean {
  return Boolean(task.artifactCid && task.supervisorReport?.trim());
}

export function supervisorNote(task: { artifactCid: string | null; supervisorReport?: string | null }): string {
  if (!supervisorHasReviewed(task)) return "The supervisor has not reviewed a delivery.";
  return task.supervisorReport?.trim() || "The supervisor has not reviewed a delivery.";
}

export function failedBeforePackage(task: { jobError?: string | null; artifactCid: string | null; supervisorReport?: string | null }): boolean {
  return Boolean(task.jobError?.trim()) && !task.artifactCid && !task.supervisorReport?.trim();
}

async function settlementTask(taskId: string, payer: string, verdict: "pass" | "fail" | "needs_revision") {
  const net = await desk();
  const task = net.tasks.get(taskId);
  if (verdict === "fail" && task && failedBeforePackage(task)) {
    if (!task.lock) throw new HireError("This task has no escrow lock.", 404);
    if (!sameAddress(task.lock.payer, payer)) throw new HireError("Only the hirer can settle this task.", 403);
    if (!sameAddress(task.lock.operator, payer)) throw new HireError("The hirer sends the escrow transaction.", 400);
    return { net, task };
  }
  return requireReviewed(taskId, payer);
}

async function requireReviewed(taskId: string, payer: string) {
  const net = await desk();
  const task = net.tasks.get(taskId);
  if (!task?.lock) throw new HireError("This task has no escrow lock.", 404);
  if (!sameAddress(task.lock.payer, payer)) throw new HireError("Only the hirer can settle this task.", 403);
  if (!sameAddress(task.lock.operator, payer)) throw new HireError("The hirer sends the escrow transaction.", 400);
  if (!supervisorHasReviewed(task)) throw new HireError("The supervisor has not reviewed a delivery.", 409);
  return { net, task };
}

/** The supervisor agent opens the delivery. The hirer receives only the description. */
export async function reviewDelivery(input: { payer: string; taskId: string }) {
  const net = await desk();
  const task = net.tasks.get(input.taskId);
  if (!task?.lock) throw new HireError("This task has no escrow lock.", 404);
  if (!sameAddress(task.lock.payer, input.payer)) throw new HireError("Only the hirer can settle this task.", 403);
  if (!task.artifactCid) throw new HireError("The supervisor has not reviewed a delivery.", 409);
  if (!task.supervisorAgentId) throw new HireError("This deal has no supervisor agent.", 409);
  if (modelKeyMissing()) throw new HireError("The model key is missing. USDC stays locked.", 409);
  let supervisor;
  try {
    supervisor = await publicAgent(task.supervisorAgentId);
    supervisorSeat({
      supervisorAgentId: supervisor.id,
      hiringAgentId: task.hiringAgentId ?? "",
      workerAgentId: task.workerAgentId,
      supervisorOwner: supervisor.owner,
      hirer: task.lock.payer,
    });
  } catch (error) {
    if (error instanceof HireError) throw error;
    const message = error instanceof Error ? error.message : "This deal has no supervisor agent.";
    throw new HireError(message.includes("different agent") || message.includes("cannot belong") ? message : "This deal has no supervisor agent.", 409);
  }
  await ensureArtifactKey(net, task.artifactCid);
  const readers = net.artifactReaders(task.artifactCid);
  const worker = await publicAgent(task.workerAgentId);
  if (!readers || !sealedToSupervisor(readers, supervisor.agentWallet, [task.lock.payer, worker.agentWallet, supervisor.owner])) {
    throw new HireError("The delivery is not sealed to the supervisor agent.", 409);
  }
  const evidence = await net.readArtifact(task.artifactCid, getAddress(supervisor.agentWallet));
  const workspace = await ensureWorkspace(supervisor.id, { name: supervisor.name, description: supervisor.description });
  const reviewModel = conversationModel(await agentPreferredModel(supervisor.id, true));
  const described = await describeDelivery(reviewInstruction(task.criteria, evidence, supervisorGuidance(workspace.tree.files)), reviewModel);
  const report = acceptSupervisorReport(described.summary, evidence);
  if (!report) throw new HireError("The review could not be shown. USDC stays locked.", 409);
  task.supervisorReport = report;
  task.supervisorSuggestion = acceptSupervisorSuggestion(described.suggestion);
  task.status = "delivered";
  await saveDesk(net);
  await publishHireStatus(task.id);
  return { taskId: task.id, report };
}

function settleLocal(net: Awaited<ReturnType<typeof desk>>, taskId: string, verdict: "pass" | "fail" | "needs_revision") {
  const task = net.tasks.get(taskId);
  const signed = task?.verdict ?? null;
  const closed = net.closeHire({ taskId, verdict, now: Date.now() });
  closed.verdict = signed;
  return closed;
}

export function applyVerifiedVerdict(net: Awaited<ReturnType<typeof desk>>, taskId: string, verdict: "pass" | "fail") {
  const closed = settleLocal(net, taskId, verdict);
  if (verdict === "pass") closed.deliveryReleased = true;
  if (verdict === "fail") {
    closed.deliveryReleased = false;
    closed.jobError = null;
    closed.artifactKeyWrap = undefined;
    closed.artifactReaders = undefined;
    if (closed.artifactCid) net.forgetArtifact(closed.artifactCid);
  }
  return closed;
}

export async function readReleasedDelivery(payer: string, taskId: string): Promise<{ files: { path: string; text: string }[] }> {
  const net = await desk();
  const task = net.tasks.get(taskId);
  if (!task?.lock) throw new HireError("This task has no escrow lock.", 404);
  if (!sameAddress(task.lock.payer, payer)) throw new HireError("Only the hirer can open this delivery.", 403);
  const payment = task.paymentId ? net.getPayment(task.paymentId) : undefined;
  if (payment?.status !== "captured" || task.deliveryReleased !== true) {
    throw new HireError("The delivery stays sealed until you confirm.", 409);
  }
  try {
    return { files: parseBundle(await readSealedPlaintext(net, task)) };
  } catch {
    throw new HireError("The delivery stays sealed until you confirm.", 409);
  }
}

export async function settlementCall(input: { payer: string; taskId: string; verdict: "pass" | "fail" | "needs_revision" }) {
  const { net, task } = await settlementTask(input.taskId, input.payer, input.verdict);
  if (!task.lock) throw new HireError("This task has no escrow lock.", 404);
  if (input.verdict === "needs_revision") {
    const closed = settleLocal(net, task.id, "needs_revision");
    await saveDesk(net);
    const payment = closed.paymentId ? net.getPayment(closed.paymentId) : undefined;
    return { taskId: closed.id, status: closed.status, verdict: closed.verdict, paymentStatus: payment?.status ?? null };
  }
  if (input.verdict === "pass" && modelKeyMissing()) {
    throw new HireError("The model key is missing. USDC stays locked.", 409);
  }
  if (input.verdict === "pass") return { taskId: task.id, capture: captureCall(task.lock) };
  return { taskId: task.id, void: voidCall(task.lock) };
}

export async function confirmSettlement(input: { payer: string; taskId: string; verdict: "pass" | "fail"; txHash: Hash }) {
  const { net, task } = await settlementTask(input.taskId, input.payer, input.verdict);
  if (!task.lock) throw new HireError("This task has no escrow lock.", 404);
  if (input.verdict === "pass" && modelKeyMissing()) {
    throw new HireError("The model key is missing. USDC stays locked.", 409);
  }
  const call = input.verdict === "pass" ? captureCall(task.lock) : voidCall(task.lock);
  await assertEscrowTransaction(input.txHash, getAddress(input.payer), call.data);
  const closed = applyVerifiedVerdict(net, task.id, input.verdict);
  closed.settlementTx = input.txHash;
  await saveDesk(net);
  await closeTaskBudget(closed.id);
  await publishHireStatus(closed.id);
  const payment = closed.paymentId ? net.getPayment(closed.paymentId) : undefined;
  return { taskId: closed.id, status: closed.status, verdict: closed.verdict, paymentStatus: payment?.status ?? null };
}

async function negotiationLines(net: Network, task: { id: string; hiringAgentId?: string; workerAgentId: string; criteria?: string }): Promise<DealMessage[]> {
  const hiring = task.hiringAgentId?.trim() ?? "";
  const worker = net.snapshot().agents.find((agent) => agent.agentId === task.workerAgentId);
  const workerName = worker?.metadata.name || `Agent ${task.workerAgentId}`;
  const hiringAgent = hiring ? net.snapshot().agents.find((agent) => agent.agentId === hiring) : undefined;
  const hiringName = hiringAgent?.metadata.name || (hiring ? `Agent ${hiring}` : "Hiring agent");
  const handed = task.criteria?.trim() ?? "";
  if (!hiring) return handed ? dealMessages({ hiringName, workerName, work: handed, offers: [] }) : [];
  const raw = await readDocument(`deal:${hiring}`);
  if (!raw) return handed ? dealMessages({ hiringName, workerName, work: handed, offers: [] }) : [];
  let deal: {
    taskId?: string | null;
    selectedName?: string;
    brief?: string;
    clarifications?: string[];
    constraints?: string;
    deadline?: string | null;
    agreedDeadline?: string | null;
    offers?: { side?: string; action?: string; priceLabel?: string; deadline?: string; reason?: string }[];
  };
  try {
    deal = JSON.parse(raw) as typeof deal;
  } catch {
    return handed ? dealMessages({ hiringName, workerName, work: handed, offers: [] }) : [];
  }
  if (deal.taskId && deal.taskId !== task.id) return handed ? dealMessages({ hiringName, workerName, work: handed, offers: [] }) : [];
  const work = handed || dealWorkText({
    brief: deal.brief ?? "",
    clarifications: deal.clarifications ?? [],
    constraints: deal.constraints ?? "",
    deadline: deal.agreedDeadline ?? deal.deadline ?? "",
  });
  return dealMessages({
    hiringName,
    workerName: deal.selectedName?.trim() || workerName,
    brief: deal.brief ?? "",
    work,
    offers: deal.offers ?? [],
  });
}

export async function taskPayload(taskId: string, viewer: string) {
  const net = await desk();
  let task = net.tasks.get(taskId);
  if (task?.lock && sameAddress(viewer, task.lock.payer) && task.artifactCid && task.supervisorAgentId && !task.supervisorReport?.trim() && !modelKeyMissing()) {
    try {
      await reviewDelivery({ payer: viewer, taskId });
      task = (await desk()).tasks.get(taskId);
    } catch {
      task = (await desk()).tasks.get(taskId);
    }
  }
  if (!task) return null;
  const worker = net.snapshot().agents.find((agent) => agent.agentId === task.workerAgentId);
  const payer = task.lock?.payer;
  const isPayer = payer ? sameAddress(viewer, payer) : false;
  const isWorkerOwner = worker ? sameAddress(viewer, worker.owner) : false;
  if (!isPayer && !isWorkerOwner) return null;
  const payment = task.paymentId ? net.getPayment(task.paymentId) : undefined;
  return {
    task: {
      id: task.id,
      status: task.status,
      verdict: task.verdict,
      criteria: task.criteria,
      amount: task.amount.toString(),
      amountLabel: formatUsdc(task.amount.toString()),
      deadline: task.deadline ?? null,
      longHorizon: task.longHorizon === true,
      model: await agentPreferredModel(task.workerAgentId, task.longHorizon === true),
      artifactCid: task.artifactCid,
      authorizeTx: task.authorizeTx ?? null,
      settlementTx: task.settlementTx ?? null,
      workerAgentId: task.workerAgentId,
      workerName: worker?.metadata.name || `Agent ${task.workerAgentId}`,
      payer: payer ?? null,
      supervisorAgentId: task.supervisorAgentId ?? "",
      supervisorNote: supervisorNote(task),
      supervisorSuggestion: supervisorSuggestionNote(task.supervisorSuggestion),
      jobError: task.jobError ?? "",
      jobLog: (task.jobLog ?? []).map((entry) => ({ at: entry.at, text: entry.text })),
      deliveryReleased: task.deliveryReleased === true,
      progress: hireProgress({
        paymentStatus: payment?.status ?? null,
        taskStatus: task.status,
        hasArtifact: Boolean(task.artifactCid),
        reviewed: supervisorHasReviewed(task),
        jobError: task.jobError ?? "",
        viewer: isPayer ? "hirer" : "worker",
      }),
      conversation: await negotiationLines(net, task),
    },
    role: isPayer ? "hirer" : "worker",
    payer: isPayer ? getAddress(viewer) : null,
    payment: payment
      ? { status: payment.status, amount: payment.amount.toString(), amountLabel: formatUsdc(payment.amount.toString()) }
      : null,
    modelKeyMissing: modelKeyMissing(),
    reviewed: supervisorHasReviewed(task),
    canReview: isPayer && payment?.status === "authorized" && Boolean(task.artifactCid) && Boolean(task.supervisorAgentId) && !supervisorHasReviewed(task),
    canAccept: isPayer && payment?.status === "authorized" && supervisorHasReviewed(task) && !modelKeyMissing(),
    canDecline: isPayer && payment?.status === "authorized" && (supervisorHasReviewed(task) || failedBeforePackage(task)),
    canSendBack: isPayer && payment?.status === "authorized" && task.status !== "revision" && supervisorHasReviewed(task),
  };
}

export async function tasksForViewer(viewer: string) {
  const net = await desk();
  const tasks = [];
  for (const task of net.tasks.values()) {
    const worker = net.snapshot().agents.find((agent) => agent.agentId === task.workerAgentId);
    const payer = task.lock?.payer;
    const isPayer = payer ? sameAddress(viewer, payer) : false;
    const isWorkerOwner = worker ? sameAddress(viewer, worker.owner) : false;
    if (!isPayer && !isWorkerOwner) continue;
    const payment = task.paymentId ? net.getPayment(task.paymentId) : undefined;
    tasks.push({
      id: task.id,
      role: isPayer ? "buyer" : "hired",
      workerAgentId: task.workerAgentId,
      workerName: worker?.metadata.name || `Agent ${task.workerAgentId}`,
      payer: payer ?? null,
      criteria: task.criteria,
      amountLabel: formatUsdc(task.amount.toString()),
      deadline: task.deadline ?? null,
      model: await agentPreferredModel(task.workerAgentId, task.longHorizon === true),
      longHorizon: task.longHorizon === true,
      status: task.status,
      paymentStatus: payment?.status ?? null,
      supervisorNote: supervisorNote(task),
    });
  }
  return tasks;
}
