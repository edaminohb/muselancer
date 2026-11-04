import { createPublicClient, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

export type PreparedOwnerCall = {
  gasLimit: number;
  maxFeePerGas: number;
  maxPriorityFeePerGas: number;
  nonce: number;
};

/** Privy signs a request with empty gas when preparation fails. Keep the refusal here instead. */
export function ownerCallRefusal(error: unknown): string {
  const details = error && typeof error === "object" && "details" in error ? String(error.details) : "";
  const message = error instanceof Error ? error.message : "";
  const text = `${details}\n${message}`;
  if (/transfer amount exceeds balance/i.test(text)) {
    return "The owner wallet does not hold enough USDC for this lock. No USDC has moved.";
  }
  if (/insufficient funds/i.test(text)) {
    return "The owner wallet does not hold enough ETH for gas. No USDC has moved.";
  }
  const reason = (details || message).split("URL:")[0].replace(/\s+/g, " ").trim();
  return (reason || "The wallet could not prepare the lock. No USDC has moved.").slice(0, 180);
}

function safeQuantity(value: bigint | undefined, label: string): number {
  if (value === undefined || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`The wallet could not prepare the ${label}. No USDC has moved.`);
  }
  return Number(value);
}

function quantity(value: bigint | undefined, label: string): number {
  if (value === undefined || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`The wallet could not prepare the ${label}.`);
  }
  return Number(value);
}

/** Fill gas, fees, and nonce for an owner or agent wallet send. */
export async function preparedWalletSend(input: { from: Address; to: Address; data: Hex; valueWei: bigint }): Promise<PreparedOwnerCall> {
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  try {
    const prepared = await client.prepareTransactionRequest({
      account: input.from,
      chain: baseSepolia,
      to: input.to,
      data: input.data,
      value: input.valueWei,
    });
    return {
      gasLimit: quantity(prepared.gas, "gas limit"),
      maxFeePerGas: quantity(prepared.maxFeePerGas, "gas fee"),
      maxPriorityFeePerGas: quantity(prepared.maxPriorityFeePerGas, "gas fee"),
      nonce: prepared.nonce,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The wallet could not prepare")) throw error;
    const details = error && typeof error === "object" && "details" in error ? String(error.details) : "";
    const message = error instanceof Error ? error.message : "";
    const text = `${details}\n${message}`;
    if (/transfer amount exceeds balance/i.test(text)) throw new Error("This wallet does not hold enough of that token.");
    if (/insufficient funds/i.test(text)) throw new Error("This wallet does not hold enough ETH for gas.");
    throw new Error("The wallet could not prepare the send.");
  }
}

/** Fill gas, fees, and nonce before Privy signs. A reverting call is refused here. */
export async function preparedOwnerCall(input: { from: Address; to: Address; data: Hex }): Promise<PreparedOwnerCall> {
  const client = createPublicClient({ chain: baseSepolia, transport: http() });
  try {
    const prepared = await client.prepareTransactionRequest({
      account: input.from,
      chain: baseSepolia,
      to: input.to,
      data: input.data,
      value: BigInt(0),
    });
    return {
      gasLimit: safeQuantity(prepared.gas, "gas limit"),
      maxFeePerGas: safeQuantity(prepared.maxFeePerGas, "gas fee"),
      maxPriorityFeePerGas: safeQuantity(prepared.maxPriorityFeePerGas, "gas fee"),
      nonce: prepared.nonce,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The wallet could not prepare")) throw error;
    throw new Error(ownerCallRefusal(error));
  }
}
