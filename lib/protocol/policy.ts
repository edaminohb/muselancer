export type Risk = "low" | "medium" | "high";
export type SignerRole = "owner" | "agent" | "none";

export const KNOWN_ACTIONS = ["discover", "message", "hire", "deliver", "pay"] as const;
export type KnownAction = (typeof KNOWN_ACTIONS)[number];

export type Policy = {
  perTaskCapUsdc: string;
  dailyBudgetUsdc: string;
  allowedActions: string[];
  allowedRecipients: string[];
  maxPerMinute: number;
};

export type PolicyRequest = {
  action: string;
  amountUsdc: string;
  recipient: string | null;
  paused: boolean;
  spentTodayUsdc: string;
  actionsLastMinute: number;
};

export type PolicyDecision = {
  allow: boolean;
  reason: string;
  risk: Risk;
  signer: SignerRole;
};

export function defaultPolicy(): Policy {
  return {
    perTaskCapUsdc: "0",
    dailyBudgetUsdc: "0",
    allowedActions: ["discover", "message", "deliver"],
    allowedRecipients: [],
    maxPerMinute: 10,
  };
}

function parseUnits(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function decide(allow: boolean, reason: string, risk: Risk, signer: SignerRole = "none"): PolicyDecision {
  return { allow, reason, risk, signer: allow ? signer : "none" };
}

/** Fail closed. Registration does not authorize spending. Amounts are USDC base units (6 decimals). */
export function evaluatePolicy(policy: Policy, request: PolicyRequest): PolicyDecision {
  const amount = parseUnits(request.amountUsdc);
  const cap = parseUnits(policy.perTaskCapUsdc);
  const daily = parseUnits(policy.dailyBudgetUsdc);
  const spent = parseUnits(request.spentTodayUsdc);
  if (amount == null || cap == null || daily == null || spent == null) {
    return decide(false, "Amount or budget is not a USDC base-unit integer.", "high");
  }

  const payment = request.action === "pay" || amount > BigInt(0);
  const risk: Risk = payment ? "high" : request.action === "discover" ? "low" : "medium";

  if (request.paused) return decide(false, "Agent is paused.", risk);
  if (!KNOWN_ACTIONS.includes(request.action as KnownAction)) {
    return decide(false, "Unknown action.", "high");
  }
  if (!policy.allowedActions.includes(request.action)) {
    return decide(false, "Action is not allowed.", risk);
  }
  if (policy.maxPerMinute <= 0 || request.actionsLastMinute >= policy.maxPerMinute) {
    return decide(false, "Request frequency is exhausted.", risk);
  }
  if (payment) {
    if (!request.recipient || !policy.allowedRecipients.includes(request.recipient.toLowerCase())) {
      return decide(false, "Recipient is not the escrow.", "high");
    }
    return decide(true, "Owner signature required for this payment.", "high", "owner");
  }
  return decide(true, "Allowed inside the owner policy.", risk, "agent");
}
