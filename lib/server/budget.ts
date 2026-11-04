import { deleteDocument, readDocument, writeDocument } from "../db";
import type { GatewayBudget } from "../gateway/meta";

const DEFAULT_BUDGET: GatewayBudget = { remainingCalls: 20, remainingTokens: 100_000 };

function taskBudgetKey(taskId: string): string {
  return `budget:gateway:task:${taskId}`;
}

/** A hire starts with a full allowance. A previous hire does not spend it. */
export async function openTaskBudget(taskId: string): Promise<void> {
  await writeDocument(taskBudgetKey(taskId), JSON.stringify({ ...DEFAULT_BUDGET }));
}

export async function loadTaskBudget(taskId: string): Promise<GatewayBudget> {
  const raw = await readDocument(taskBudgetKey(taskId));
  if (!raw) {
    const fresh = { ...DEFAULT_BUDGET };
    await writeDocument(taskBudgetKey(taskId), JSON.stringify(fresh));
    return fresh;
  }
  const parsed = JSON.parse(raw) as Partial<GatewayBudget>;
  return {
    remainingCalls: typeof parsed.remainingCalls === "number" ? parsed.remainingCalls : DEFAULT_BUDGET.remainingCalls,
    remainingTokens: typeof parsed.remainingTokens === "number" ? parsed.remainingTokens : DEFAULT_BUDGET.remainingTokens,
  };
}

export async function saveTaskBudget(taskId: string, budget: GatewayBudget): Promise<void> {
  await writeDocument(taskBudgetKey(taskId), JSON.stringify({ remainingCalls: budget.remainingCalls, remainingTokens: budget.remainingTokens }));
}

export async function closeTaskBudget(taskId: string): Promise<void> {
  await deleteDocument(taskBudgetKey(taskId));
}

/** One owner message. A previous message does not spend this allowance. */
export function ownerChatBudget(): GatewayBudget {
  return { remainingCalls: 8, remainingTokens: 100_000 };
}

function budgetKey(scope: string, id: string): string {
  return `budget:${scope}:${id}`;
}

export async function loadBudget(scope: string, id: string): Promise<GatewayBudget> {
  const raw = await readDocument(budgetKey(scope, id));
  if (!raw) return { ...DEFAULT_BUDGET };
  const parsed = JSON.parse(raw) as Partial<GatewayBudget>;
  return {
    remainingCalls: typeof parsed.remainingCalls === "number" ? parsed.remainingCalls : DEFAULT_BUDGET.remainingCalls,
    remainingTokens: typeof parsed.remainingTokens === "number" ? parsed.remainingTokens : DEFAULT_BUDGET.remainingTokens,
  };
}

export async function saveBudget(scope: string, id: string, budget: GatewayBudget): Promise<void> {
  await writeDocument(
    budgetKey(scope, id),
    JSON.stringify({ remainingCalls: budget.remainingCalls, remainingTokens: budget.remainingTokens }),
  );
}
