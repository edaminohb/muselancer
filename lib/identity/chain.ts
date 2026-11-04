import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  isHash,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { ERC1967_IMPLEMENTATION_SLOT, IDENTITY_REGISTRY } from "../chain/constants";
import { decodeDataJson } from "../protocol/registration";
import { IDENTITY_REGISTRY_STORAGE_SLOT, identityAbi } from "./registry";

export type OnchainAgent = {
  agentId: string;
  owner: Address;
  agentWallet: Address;
  agentUri: string;
  registrationJson: string;
  oasfMessage: string;
  oasfSignature: Hex | null;
};

type RegistryLog = { address: Address; topics: readonly Hex[]; data: Hex };

export function baseClient() {
  const url = process.env.BASE_RPC_URL?.trim();
  if (!url?.startsWith("https://")) throw new Error("Set BASE_RPC_URL to a Base Sepolia HTTPS endpoint.");
  return createPublicClient({ chain: baseSepolia, transport: http(url) });
}

export function registeredAgentId(logs: readonly RegistryLog[], owner: Address): bigint {
  const found: bigint[] = [];
  for (const log of logs) {
    if (getAddress(log.address) !== IDENTITY_REGISTRY) continue;
    try {
      const decoded = decodeEventLog({
        abi: identityAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== "Registered") continue;
      if (getAddress(decoded.args.owner) !== getAddress(owner)) continue;
      found.push(decoded.args.agentId);
    } catch {
      continue;
    }
  }
  if (found.length !== 1) {
    throw new Error(found.length === 0 ? "Receipt has no registration for this owner." : "Receipt registered more than one agent.");
  }
  return found[0]!;
}

function missingToken(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ERC721NonexistentToken") || message.includes("nonexistent token");
}

export async function assertRegistryTransaction(hash: Hash, owner: Address): Promise<void> {
  if (!isHash(hash)) throw new Error("Registry transaction hash is required.");
  const client = baseClient();
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: 45_000, confirmations: 1 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.toLowerCase().includes("not found") || message.toLowerCase().includes("could not be found")) {
      throw new Error("A registry transaction is not on Base Sepolia.");
    }
    throw new Error("A registry transaction was not confirmed.");
  }
  if (receipt.status !== "success") throw new Error("A registry transaction failed.");
  if (!receipt.to || getAddress(receipt.to) !== IDENTITY_REGISTRY) {
    throw new Error("A transaction was not sent to the identity registry.");
  }
  if (getAddress(receipt.from) !== getAddress(owner)) throw new Error("The owner wallet did not send a registry transaction.");
}

export async function readRegistration(hash: Hash, owner: Address): Promise<{ agentId: string; from: Address }> {
  if (!isHash(hash)) throw new Error("Registration transaction hash is required.");
  const client = baseClient();
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: 45_000, confirmations: 1 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.toLowerCase().includes("not found") || message.toLowerCase().includes("could not be found")) {
      throw new Error("That transaction is not on Base Sepolia.");
    }
    throw new Error("The registration transaction was not confirmed.");
  }
  if (receipt.status !== "success") throw new Error("Registration transaction failed.");
  let agentId: bigint;
  try {
    agentId = registeredAgentId(receipt.logs, owner);
  } catch (error) {
    if (!receipt.to || getAddress(receipt.to) !== IDENTITY_REGISTRY) {
      throw new Error("Transaction was not sent to the identity registry.");
    }
    if (getAddress(receipt.from) !== getAddress(owner)) throw new Error("The owner wallet did not send this transaction.");
    throw error;
  }
  const from = getAddress(receipt.from) === getAddress(owner) ? getAddress(receipt.from) : getAddress(owner);
  return { agentId: agentId.toString(), from };
}

/** The agent id the next `register` call receives, read from the registry's ERC-7201 counter. */
export async function readNextAgentId(): Promise<bigint> {
  const client = baseClient();
  const raw = await client.getStorageAt({ address: IDENTITY_REGISTRY, slot: IDENTITY_REGISTRY_STORAGE_SLOT });
  if (!raw) throw new Error("Could not read the next agent id.");
  return BigInt(raw);
}

export async function readImplementationSlot(): Promise<Hex> {
  const client = baseClient();
  const value = await client.getStorageAt({ address: IDENTITY_REGISTRY, slot: ERC1967_IMPLEMENTATION_SLOT });
  if (!value || value === "0x") throw new Error("Identity registry implementation slot is unreadable.");
  return value;
}

export async function registryOwner(agentId: string): Promise<Address> {
  const client = baseClient();
  try {
    return getAddress(
      await client.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityAbi,
        functionName: "ownerOf",
        args: [BigInt(agentId)],
      }),
    );
  } catch (error) {
    if (missingToken(error)) throw new Error("Agent is not on the identity registry.");
    throw error;
  }
}

export async function readOnchainAgent(agentId: string): Promise<OnchainAgent> {
  const client = baseClient();
  const id = BigInt(agentId);
  const owner = await registryOwner(agentId);
  const [wallet, uri, signature] = await Promise.all([
    client.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "getAgentWallet", args: [id] }),
    client.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [id] }),
    client.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "getMetadata", args: [id, "oasfSignature"] }),
  ]);
  if (!uri) throw new Error("Registration file is not on the registry yet.");
  const registrationJson = decodeDataJson(uri);
  const file = JSON.parse(registrationJson) as {
    services?: { name?: string; endpoint?: string }[];
  };
  const oasf = file.services?.find((service) => service.name === "OASF");
  if (!oasf?.endpoint) throw new Error("Registration file has no OASF record.");
  const oasfMessage = decodeDataJson(oasf.endpoint);
  return {
    agentId,
    owner,
    agentWallet: getAddress(wallet),
    agentUri: uri,
    registrationJson,
    oasfMessage,
    oasfSignature: signature.length > 2 ? signature : null,
  };
}
