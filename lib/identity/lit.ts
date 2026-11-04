import { IDENTITY_REGISTRY } from "../chain/constants";

/** Lit access-control condition: only the current ERC-721 owner can decrypt. */
export function ownerMemoryCondition(agentId: string) {
  return {
    contractAddress: IDENTITY_REGISTRY,
    standardContractType: "ERC721" as const,
    chain: "baseSepolia" as const,
    method: "ownerOf",
    parameters: [agentId],
    returnValueTest: { comparator: "==" as const, value: ":userAddress" },
  };
}
