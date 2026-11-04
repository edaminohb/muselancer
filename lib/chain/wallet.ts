import { getAddress, isAddress, type Address } from "viem";
import { USDC_BASE_SEPOLIA } from "./constants";

export type WalletCard = {
  role: "owner" | "agent";
  name: string;
  address: Address;
  agentId: string;
};

export type WalletToken = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  raw: string;
  display: string;
};

export type WalletActivity = {
  hash: string;
  direction: "in" | "out";
  amount: string;
  symbol: string;
  peer: string;
  when: string;
};

const USDC = getAddress(USDC_BASE_SEPOLIA);

/** Owner wallet first, then each agent wallet once. */
export function walletCards(
  owner: string,
  sessionAgent: string,
  agents: { id: string; name: string; agentWallet: string }[],
): WalletCard[] {
  const ownerAddress = getAddress(owner);
  const cards: WalletCard[] = [{ role: "owner", name: "Owner", address: ownerAddress, agentId: "" }];
  const seen = new Set([ownerAddress.toLowerCase()]);
  for (const agent of agents) {
    let address: Address;
    try {
      address = getAddress(agent.agentWallet);
    } catch {
      continue;
    }
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    const name = agent.name.trim() || `Agent ${agent.id}`;
    cards.push({ role: "agent", name, address, agentId: agent.id });
  }
  try {
    const extra = getAddress(sessionAgent);
    if (!seen.has(extra.toLowerCase())) {
      cards.push({ role: "agent", name: "Agent wallet", address: extra, agentId: "" });
    }
  } catch {
    return cards;
  }
  return cards;
}

/** Whole and fractional display. Trailing zeros are dropped. The fraction stops at `places`. */
export function formatTokenAmount(raw: string, decimals: number, places = 6): string {
  if (!/^\d+$/.test(raw) || decimals < 0 || decimals > 36) return "0";
  const scale = BigInt(10) ** BigInt(decimals);
  const value = BigInt(raw);
  const whole = value / scale;
  if (decimals === 0) return whole.toString();
  const frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, places);
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

/** A positive amount in base units, refused when it is above the balance. */
export function parseTokenAmount(input: string, decimals: number, balanceRaw: string): string {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed) || decimals < 0 || decimals > 36 || !/^\d+$/.test(balanceRaw)) {
    return "Enter an amount.";
  }
  const [wholeRaw, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return decimals === 0 ? "This asset has no decimals." : `Use at most ${decimals} decimal places.`;
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const value = BigInt(whole) * scale + BigInt((frac.padEnd(decimals, "0") || "0"));
  if (value <= BigInt(0)) return "Enter an amount greater than zero.";
  if (value > BigInt(balanceRaw)) return "This wallet does not hold enough.";
  return value.toString();
}

export function parseSendTo(value: string, from: string): Address | string {
  const trimmed = value.trim();
  if (!isAddress(trimmed)) return "Enter the destination address.";
  const to = getAddress(trimmed);
  if (to.toLowerCase() === from.toLowerCase()) return "Choose a different address.";
  return to;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function digits(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
}

/** ETH plus fungible tokens. USDC stays visible at zero. Other zero balances stay off the list. */
export function holdingsFromExplorer(coinBalance: unknown, rows: unknown): { ethRaw: string; tokens: WalletToken[] } {
  const ethRaw = digits(coinBalance) || "0";
  const tokens: WalletToken[] = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const record = row as { value?: unknown; token?: unknown };
    const token = record.token && typeof record.token === "object" ? record.token as { address?: unknown; address_hash?: unknown; name?: unknown; symbol?: unknown; decimals?: unknown; type?: unknown } : null;
    if (!token) continue;
    const kind = text(token.type, 20).toUpperCase();
    if (kind && kind !== "ERC-20") continue;
    const rawAddress = typeof token.address_hash === "string" ? token.address_hash : typeof token.address === "string" ? token.address : "";
    if (!isAddress(rawAddress)) continue;
    const address = getAddress(rawAddress);
    const raw = digits(record.value) || "0";
    const decimalValue = typeof token.decimals === "number" ? token.decimals : typeof token.decimals === "string" && /^\d+$/.test(token.decimals) ? Number(token.decimals) : 18;
    const decimals = decimalValue >= 0 && decimalValue <= 36 ? decimalValue : 18;
    const keep = raw !== "0" || address.toLowerCase() === USDC.toLowerCase();
    if (!keep) continue;
    if (tokens.some((item) => item.address.toLowerCase() === address.toLowerCase())) continue;
    tokens.push({
      symbol: text(token.symbol, 12) || "Token",
      name: text(token.name, 40) || "Token",
      address,
      decimals,
      raw,
      display: formatTokenAmount(raw, decimals),
    });
  }
  if (!tokens.some((item) => item.address.toLowerCase() === USDC.toLowerCase())) {
    tokens.unshift({ symbol: "USDC", name: "USD Coin", address: USDC, decimals: 6, raw: "0", display: "0" });
  }
  tokens.sort((left, right) => {
    if (left.address.toLowerCase() === USDC.toLowerCase()) return -1;
    if (right.address.toLowerCase() === USDC.toLowerCase()) return 1;
    return left.symbol.localeCompare(right.symbol);
  });
  return { ethRaw, tokens: tokens.slice(0, 24) };
}

/** A chain reading replaces the explorer figure. A missing reading leaves the explorer figure. */
export function withChainBalances(
  holdings: { ethRaw: string; tokens: WalletToken[] },
  chain: { ethRaw: string | null; usdcRaw: string | null },
): { ethRaw: string; tokens: WalletToken[] } {
  let tokens = holdings.tokens;
  if (chain.usdcRaw && /^\d+$/.test(chain.usdcRaw)) {
    const usdc: WalletToken = {
      symbol: "USDC",
      name: "USD Coin",
      address: USDC,
      decimals: 6,
      raw: chain.usdcRaw,
      display: formatTokenAmount(chain.usdcRaw, 6),
    };
    tokens = [usdc, ...holdings.tokens.filter((token) => token.address.toLowerCase() !== USDC.toLowerCase())];
  }
  return {
    ethRaw: chain.ethRaw && /^\d+$/.test(chain.ethRaw) ? chain.ethRaw : holdings.ethRaw,
    tokens: tokens.slice(0, 24),
  };
}

function party(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const hash = (value as { hash?: unknown }).hash;
  return typeof hash === "string" && isAddress(hash) ? getAddress(hash) : "";
}

function whenOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const time = Date.parse(value);
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function hashOf(value: unknown): string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : "";
}

/** Recent ETH and token movements for one address. */
export function activityFromExplorer(self: string, nativeRows: unknown, transferRows: unknown): WalletActivity[] {
  const mine = getAddress(self).toLowerCase();
  const items: WalletActivity[] = [];
  const natives = Array.isArray(nativeRows) ? nativeRows : [];
  for (const row of natives) {
    if (!row || typeof row !== "object") continue;
    const record = row as { hash?: unknown; value?: unknown; timestamp?: unknown; from?: unknown; to?: unknown };
    const hash = hashOf(record.hash);
    const from = party(record.from);
    const to = party(record.to);
    const when = whenOf(record.timestamp);
    const raw = digits(record.value);
    if (!hash || !when || !raw || raw === "0") continue;
    const direction = from.toLowerCase() === mine ? "out" : to.toLowerCase() === mine ? "in" : "";
    if (!direction) continue;
    items.push({
      hash,
      direction,
      amount: formatTokenAmount(raw, 18),
      symbol: "ETH",
      peer: direction === "out" ? to : from,
      when,
    });
  }
  const transfers = Array.isArray(transferRows) ? transferRows : [];
  for (const row of transfers) {
    if (!row || typeof row !== "object") continue;
    const record = row as { tx_hash?: unknown; timestamp?: unknown; from?: unknown; to?: unknown; total?: unknown };
    const total = record.total && typeof record.total === "object" ? record.total as { value?: unknown; decimals?: unknown; token?: unknown } : null;
    const token = total?.token && typeof total.token === "object" ? total.token as { symbol?: unknown; type?: unknown } : null;
    if (token && text(token.type, 20).toUpperCase() && text(token.type, 20).toUpperCase() !== "ERC-20") continue;
    const hash = hashOf(record.tx_hash);
    const from = party(record.from);
    const to = party(record.to);
    const when = whenOf(record.timestamp);
    const raw = digits(total?.value);
    const decimalValue = typeof total?.decimals === "number" ? total.decimals : typeof total?.decimals === "string" && /^\d+$/.test(total.decimals) ? Number(total.decimals) : 18;
    const decimals = decimalValue;
    if (!hash || !when || !raw || raw === "0" || decimals < 0 || decimals > 36) continue;
    const direction = from.toLowerCase() === mine ? "out" : to.toLowerCase() === mine ? "in" : "";
    if (!direction) continue;
    items.push({
      hash,
      direction,
      amount: formatTokenAmount(raw, decimals),
      symbol: text(token?.symbol, 12) || "Token",
      peer: direction === "out" ? to : from,
      when,
    });
  }
  items.sort((left, right) => right.when.localeCompare(left.when));
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.hash}:${item.symbol}:${item.direction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}
