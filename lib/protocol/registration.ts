import { IDENTITY_REGISTRY, IDENTITY_CHAIN_ID } from "../chain/constants";

export type RegistrationFile = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description: string;
  services: { name: string; endpoint: string; version?: string }[];
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
};

export function agentRegistryId(): string {
  return `eip155:${IDENTITY_CHAIN_ID}:${IDENTITY_REGISTRY}`;
}

export function registrationDataUri(json: string): string {
  return `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`;
}

export function decodeDataJson(uri: string): string {
  const prefix = "data:application/json;base64,";
  if (!uri.startsWith(prefix)) throw new Error("Registration file is not an on-chain data URI.");
  return Buffer.from(uri.slice(prefix.length), "base64").toString("utf8");
}

/** Registration file stored in the NFT URI. The OASF record is inside the file, on chain. */
export function buildOnchainRegistration(input: {
  name: string;
  description: string;
  agentId: string;
  oasfMessage: string;
}): { json: string; uri: string } {
  const agentId = BigInt(input.agentId);
  if (agentId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Agent id is too large for the registration file.");
  const file: RegistrationFile = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: input.name,
    description: input.description,
    services: [{ name: "OASF", endpoint: registrationDataUri(input.oasfMessage), version: "1.0.0" }],
    x402Support: true,
    active: true,
    registrations: [{ agentId: Number(agentId), agentRegistry: agentRegistryId() }],
    supportedTrust: [],
  };
  const json = JSON.stringify(file);
  return { json, uri: registrationDataUri(json) };
}

export function buildRegistrationFile(input: {
  name: string;
  description: string;
  agentId: number;
  a2aEndpoint: string;
  oasfCid: string;
}): RegistrationFile {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: input.name,
    description: input.description,
    services: [
      { name: "A2A", endpoint: input.a2aEndpoint, version: "0.3.0" },
      { name: "OASF", endpoint: `ipfs://${input.oasfCid}`, version: "0.8.0" },
    ],
    x402Support: true,
    active: true,
    registrations: [{ agentId: input.agentId, agentRegistry: agentRegistryId() }],
    supportedTrust: ["reputation", "crypto-economic"],
  };
}
