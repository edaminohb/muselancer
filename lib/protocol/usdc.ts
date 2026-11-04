const SCALE = BigInt(1_000_000);
const MAX_U120 = (BigInt(1) << BigInt(120)) - BigInt(1);

/** USDC display amount to base units. At most 6 decimal places. */
export function parseUsdc(input: string): string {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error("Enter a USDC amount with up to 6 decimals.");
  }
  const [wholeRaw, frac = ""] = trimmed.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  const base = BigInt(whole) * SCALE + BigInt(frac.padEnd(6, "0"));
  if (base <= BigInt(0)) throw new Error("Amount must be greater than zero.");
  if (base > MAX_U120) throw new Error("Amount is too large.");
  return base.toString();
}

/** The lock cannot be signed when the payer holds less than the amount. */
export function usdcLockRefusal(balance: bigint, amount: string): string | null {
  if (!/^\d+$/.test(amount)) return "The lock amount is not a USDC amount. No USDC has moved.";
  if (balance >= BigInt(amount)) return null;
  return `The owner wallet holds ${formatUsdc(balance.toString())} USDC. This lock needs ${formatUsdc(amount)} USDC. No USDC has moved.`;
}

/** Base units to a USDC display amount. */
export function formatUsdc(base: string): string {
  if (!/^\d+$/.test(base)) throw new Error("Amount is not a USDC base-unit integer.");
  const value = BigInt(base);
  const whole = value / SCALE;
  const frac = (value % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
}

export function assertCommercialTerms(hirePrice: string, perTaskCap: string, dailyBudget: string): {
  hirePriceUsdc: string;
  perTaskCapUsdc: string;
  dailyBudgetUsdc: string;
} {
  const hirePriceUsdc = parseUsdc(hirePrice);
  const perTaskCapUsdc = parseUsdc(perTaskCap);
  const dailyBudgetUsdc = parseUsdc(dailyBudget);
  if (BigInt(hirePriceUsdc) > BigInt(perTaskCapUsdc)) throw new Error("Hire price is above the per-task cap.");
  if (BigInt(perTaskCapUsdc) > BigInt(dailyBudgetUsdc)) throw new Error("Per-task cap is above the daily budget.");
  return { hirePriceUsdc, perTaskCapUsdc, dailyBudgetUsdc };
}
