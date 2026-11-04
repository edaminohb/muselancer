import { getAddress, type Address } from "viem";
import { baseClient } from "../identity/chain";
import { USDC_BASE_SEPOLIA } from "./constants";
import { activityFromExplorer, formatTokenAmount, holdingsFromExplorer, withChainBalances, type WalletActivity, type WalletToken } from "./wallet";

const EXPLORER = "https://base-sepolia.blockscout.com/api/v2";

const usdcAbi = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }],
}] as const;

export type WalletSnapshot = {
  ethRaw: string;
  ethDisplay: string;
  tokens: WalletToken[];
  activity: WalletActivity[];
  error: string;
};

async function explorerJson(path: string): Promise<unknown> {
  const response = await fetch(`${EXPLORER}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("The explorer did not answer.");
  return response.json();
}

async function chainBalances(address: Address): Promise<{ ethRaw: string | null; usdcRaw: string | null }> {
  const unread = { ethRaw: null, usdcRaw: null };
  try {
    const client = baseClient();
    let ethRaw: string | null = null;
    let usdcRaw: string | null = null;
    try {
      ethRaw = (await client.getBalance({ address })).toString();
    } catch {
      ethRaw = null;
    }
    try {
      usdcRaw = (await client.readContract({
        address: getAddress(USDC_BASE_SEPOLIA),
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [address],
      })).toString();
    } catch {
      usdcRaw = null;
    }
    return { ethRaw, usdcRaw };
  } catch {
    return unread;
  }
}

/** ETH, USDC, and any other fungible token the explorer reports for this address. */
export async function readWallet(address: string): Promise<WalletSnapshot> {
  const account = getAddress(address);
  try {
    const [accountBody, tokenBody, txBody, transferBody] = await Promise.all([
      explorerJson(`/addresses/${account}`),
      explorerJson(`/addresses/${account}/token-balances`),
      explorerJson(`/addresses/${account}/transactions`),
      explorerJson(`/addresses/${account}/token-transfers`),
    ]);
    const coin = accountBody && typeof accountBody === "object" ? (accountBody as { coin_balance?: unknown }).coin_balance : "0";
    const tokenRows = Array.isArray(tokenBody)
      ? tokenBody
      : tokenBody && typeof tokenBody === "object" && Array.isArray((tokenBody as { items?: unknown }).items)
        ? (tokenBody as { items: unknown[] }).items
        : [];
    const chain = await chainBalances(account);
    const holdings = withChainBalances(holdingsFromExplorer(coin, tokenRows), chain);
    const nativeItems = txBody && typeof txBody === "object" ? (txBody as { items?: unknown }).items : [];
    const transferItems = transferBody && typeof transferBody === "object" ? (transferBody as { items?: unknown }).items : [];
    return {
      ethRaw: holdings.ethRaw,
      ethDisplay: formatTokenAmount(holdings.ethRaw, 18),
      tokens: holdings.tokens,
      activity: activityFromExplorer(account, nativeItems, transferItems),
      error: "",
    };
  } catch {
    try {
      const chain = await chainBalances(account);
      if (!chain.ethRaw && !chain.usdcRaw) throw new Error("Balances could not be read.");
      const holdings = withChainBalances(holdingsFromExplorer(chain.ethRaw ?? "0", []), chain);
      return {
        ethRaw: holdings.ethRaw,
        ethDisplay: formatTokenAmount(holdings.ethRaw, 18),
        tokens: holdings.tokens,
        activity: [],
        error: "Other tokens and recent activity could not be read.",
      };
    } catch {
      return {
        ethRaw: "0",
        ethDisplay: "0",
        tokens: holdingsFromExplorer("0", []).tokens,
        activity: [],
        error: "Balances could not be read.",
      };
    }
  }
}
