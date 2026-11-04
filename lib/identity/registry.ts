import { encodeFunctionData, type Address, type Hex } from "viem";
import { IDENTITY_CHAIN_ID, IDENTITY_REGISTRY } from "../chain/constants";

/** Domain from IdentityRegistryUpgradeable.__EIP712_init("ERC8004IdentityRegistry", "1"). */
export const identityDomain = {
  name: "ERC8004IdentityRegistry",
  version: "1",
  chainId: IDENTITY_CHAIN_ID,
  verifyingContract: IDENTITY_REGISTRY,
} as const;

/** AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline) */
export const agentWalletSetTypes = {
  AgentWalletSet: [
    { name: "agentId", type: "uint256" },
    { name: "newWallet", type: "address" },
    { name: "owner", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type AgentWalletSetMessage = {
  agentId: bigint;
  newWallet: Address;
  owner: Address;
  deadline: bigint;
};

/** The registry rejects a deadline more than five minutes ahead. */
export function walletDeadline(nowSeconds: number): bigint {
  return BigInt(nowSeconds + 120);
}

export const identityAbi = [
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentURI", type: "string" },
      {
        name: "metadata",
        type: "tuple[]",
        components: [
          { name: "metadataKey", type: "string" },
          { name: "metadataValue", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setMetadata",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "metadataKey", type: "string" },
      { name: "metadataValue", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setAgentWallet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newWallet", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getMetadata",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "metadataKey", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * ERC-7201 base slot for IdentityRegistryStorage.
 * The first word is `_lastId`. `register` assigns `agentId = _lastId++`, so this word is the next mint.
 */
export const IDENTITY_REGISTRY_STORAGE_SLOT = "0xa040f782729de4970518741823ec1276cbcd41a0c7493f62d173341566a04e00" as const;

/** Mint with an empty URI. The chain assigns agentId; the file is written after that id exists. */
export function registerCall(): Hex {
  return encodeFunctionData({ abi: identityAbi, functionName: "register", args: [] });
}

/** Mint, write the registration file, and store the OASF signature in one transaction. */
export function registerWithRecordCall(agentUri: string, oasfSignature: Hex): Hex {
  return encodeFunctionData({
    abi: identityAbi,
    functionName: "register",
    args: [agentUri, [{ metadataKey: "oasfSignature", metadataValue: oasfSignature }]],
  });
}

export function setAgentUriCall(agentId: bigint, agentUri: string): Hex {
  return encodeFunctionData({ abi: identityAbi, functionName: "setAgentURI", args: [agentId, agentUri] });
}

export function setMetadataCall(agentId: bigint, key: string, value: Hex): Hex {
  return encodeFunctionData({ abi: identityAbi, functionName: "setMetadata", args: [agentId, key, value] });
}

export function setAgentWalletCall(agentId: bigint, newWallet: Address, deadline: bigint, signature: Hex): Hex {
  return encodeFunctionData({
    abi: identityAbi,
    functionName: "setAgentWallet",
    args: [agentId, newWallet, deadline, signature],
  });
}
