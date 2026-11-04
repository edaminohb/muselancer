import { readDocument, writeDocument } from "../db";
import { hireStatusReport, type HireSnapshot } from "../deal/status-report";
import { desk } from "./desk";
import type { Network, Payment, TaskRecord } from "../world/network";

type StoredTask = {
  id?: string;
  status?: string;
  workerAgentId?: string;
  hiringAgentId?: string;
  paymentId?: string | null;
  artifactCid?: string | null;
  deliveryReleased?: boolean;
  supervisorReport?: string | null;
  jobError?: string | null;
};

type StoredPayment = { id?: string; status?: string };

const TASK_RANK: Record<string, number> = {
  offered: 0,
  authorized: 1,
  running: 2,
  delivered: 3,
  revision: 3,
  frozen: 3,
  settled: 4,
  released: 4,
};

const PAY_RANK: Record<string, number> = {
  authorized: 1,
  captured: 2,
  voided: 2,
  reclaimed: 2,
};

function taskRank(status: string | undefined): number {
  return TASK_RANK[status ?? ""] ?? 0;
}

function payRank(status: string | null | undefined): number {
  return PAY_RANK[status ?? ""] ?? 0;
}

function score(status: string | undefined, payment: string | null | undefined): number {
  return taskRank(status) * 10 + payRank(payment);
}

/** The saved desk can be ahead of this process. Keep the further stage. */
export function preferHireState<T extends { status?: string }>(
  memory: T | undefined,
  memoryPayment: string | null | undefined,
  stored: T | undefined,
  storedPayment: string | null | undefined,
): { task: T | undefined; paymentStatus: string | null } {
  const memoryScore = score(memory?.status, memoryPayment);
  const storedScore = score(stored?.status, storedPayment);
  if (stored && storedScore > memoryScore) {
    return { task: stored, paymentStatus: storedPayment ?? memoryPayment ?? null };
  }
  return { task: memory ?? stored, paymentStatus: memoryPayment ?? storedPayment ?? null };
}

async function storedDesk(): Promise<{ tasks: StoredTask[]; payments: StoredPayment[] }> {
  const raw = await readDocument("network");
  if (!raw) return { tasks: [], payments: [] };
  try {
    const parsed = JSON.parse(raw) as { tasks?: StoredTask[]; payments?: StoredPayment[] };
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      payments: Array.isArray(parsed.payments) ? parsed.payments : [],
    };
  } catch {
    return { tasks: [], payments: [] };
  }
}

type LiveHire = HireSnapshot & { taskId: string; hiringAgentId: string };

function snapshotOf(role: "hirer" | "worker", task: TaskRecord | StoredTask, paymentStatus: string | null, workerName: string): LiveHire {
  return {
    role,
    workerName,
    workerAgentId: task.workerAgentId ?? "",
    taskId: task.id ?? "",
    hiringAgentId: task.hiringAgentId ?? "",
    paymentStatus,
    taskStatus: task.status ?? "",
    hasArtifact: Boolean(task.artifactCid),
    reviewed: Boolean(task.supervisorReport?.trim()),
    deliveryReleased: task.deliveryReleased === true,
    jobError: task.jobError?.trim() ?? "",
  };
}

function applyAhead(net: Network, storedTask: StoredTask, paymentStatus: string | null): void {
  const live = storedTask.id ? net.tasks.get(storedTask.id) : undefined;
  if (!live) return;
  if (storedTask.status) live.status = storedTask.status as TaskRecord["status"];
  if (storedTask.artifactCid) live.artifactCid = storedTask.artifactCid;
  if (storedTask.deliveryReleased === true) live.deliveryReleased = true;
  if (storedTask.supervisorReport?.trim()) live.supervisorReport = storedTask.supervisorReport;
  if (typeof storedTask.jobError === "string") live.jobError = storedTask.jobError;
  const payment = live.paymentId ? net.getPayment(live.paymentId) : undefined;
  if (payment && paymentStatus && payRank(paymentStatus) > payRank(payment.status)) {
    payment.status = paymentStatus as Payment["status"];
  }
}

async function liveHires(net: Network): Promise<LiveHire[]> {
  const stored = await storedDesk();
  const storedPay = new Map(stored.payments.map((payment) => [payment.id ?? "", payment.status ?? ""]));
  const ids = new Set<string>();
  for (const task of net.tasks.values()) ids.add(task.id);
  for (const task of stored.tasks) if (task.id) ids.add(task.id);
  const hires: LiveHire[] = [];
  for (const id of ids) {
    const memory = net.tasks.get(id);
    const saved = stored.tasks.find((task) => task.id === id);
    const memoryPay = memory?.paymentId ? net.getPayment(memory.paymentId)?.status ?? null : null;
    const savedPay = saved?.paymentId ? storedPay.get(saved.paymentId) ?? null : null;
    const chosen = preferHireState(memory, memoryPay, saved, savedPay);
    if (!chosen.task?.id || !chosen.task.workerAgentId) continue;
    if (saved && score(saved.status, savedPay) > score(memory?.status, memoryPay)) applyAhead(net, saved, chosen.paymentStatus);
    const worker = net.snapshot().agents.find((agent) => agent.agentId === chosen.task?.workerAgentId);
    const workerName = worker?.metadata.name || `Agent ${chosen.task.workerAgentId}`;
    hires.push(snapshotOf("hirer", chosen.task, chosen.paymentStatus, workerName));
  }
  return hires;
}

async function closeDeal(hiringAgentId: string, taskId: string): Promise<void> {
  const raw = await readDocument(`deal:${hiringAgentId}`);
  if (!raw) return;
  let deal: {
    taskId?: string | null;
    stage?: string;
    selectedAgentId?: string | null;
    pendingAsk?: unknown;
    pendingCounter?: unknown;
    needsWindow?: boolean;
    turns?: { role: string; text: string }[];
  };
  try {
    deal = JSON.parse(raw) as typeof deal;
  } catch {
    return;
  }
  if (deal.taskId !== taskId) return;
  if (deal.stage === "stopped" && !deal.selectedAgentId) return;
  deal.stage = "stopped";
  deal.selectedAgentId = null;
  deal.pendingAsk = null;
  deal.pendingCounter = null;
  deal.needsWindow = false;
  await writeDocument(`deal:${hiringAgentId}`, JSON.stringify(deal));
}

function voiced(hire: LiveHire, role: "hirer" | "worker"): string {
  return hireStatusReport({ ...hire, role });
}

/** Facts this agent can see. The model decides what to say. */
export async function currentHireBrief(owner: string, agentId: string): Promise<string> {
  const net = await desk();
  const hires = await liveHires(net);
  const asHirer = hires.filter((hire) => hire.hiringAgentId === agentId);
  const asWorker = hires.filter((hire) => hire.workerAgentId === agentId);
  const parts: string[] = [];
  for (const hire of asHirer) {
    const line = voiced(hire, "hirer");
    parts.push(line);
    if (hire.paymentStatus === "captured" || hire.taskStatus === "settled") await closeDeal(agentId, hire.taskId);
    else if (hire.paymentStatus === "voided" || hire.paymentStatus === "reclaimed" || hire.taskStatus === "released") await closeDeal(agentId, hire.taskId);
  }
  for (const hire of asWorker) {
    if (asHirer.some((item) => item.taskId === hire.taskId)) continue;
    parts.push(voiced(hire, "worker"));
  }
  void owner;
  return parts.join("\n");
}

/** After the task changes, both chats learn the same stage. */
export async function publishHireStatus(taskId: string): Promise<void> {
  try {
    const net = await desk();
    const hires = await liveHires(net);
    const hire = hires.find((item) => item.taskId === taskId);
    if (!hire) return;
    if ((hire.paymentStatus === "captured" || hire.taskStatus === "settled") && hire.hiringAgentId) {
      await closeDeal(hire.hiringAgentId, hire.taskId);
    }
    if ((hire.paymentStatus === "voided" || hire.paymentStatus === "reclaimed" || hire.taskStatus === "released") && hire.hiringAgentId) {
      await closeDeal(hire.hiringAgentId, hire.taskId);
    }
  } catch {
    return;
  }
}
