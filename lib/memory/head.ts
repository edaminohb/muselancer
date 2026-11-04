import { MEMORY_HEAD_KEY } from "../chain/constants";
import type { Address } from "viem";
import { type Network } from "../world/network";

/** Pin an encrypted snapshot and point the NFT at it. The Lit share is dropped so a later device uses the password wrap. */
export async function writeMemoryHead(
  net: Network,
  input: { agentId: string; owner: Address; memoryKey: Uint8Array; plaintext: string; password: string },
): Promise<string> {
  const cid = await net.saveMemory(input);
  net.forgetLitShare(input.agentId);
  if (net.getAgent(input.agentId).metadata[MEMORY_HEAD_KEY] !== cid) {
    throw new Error("memoryHead was not written.");
  }
  return cid;
}
