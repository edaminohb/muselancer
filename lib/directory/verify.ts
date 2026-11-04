import { getAddress, isAddress, recoverMessageAddress, zeroAddress, type Address, type Hex } from "viem";
import { IDENTITY_CHAIN_ID } from "../chain/constants";
import { assertPinnedImplementation } from "../identity/implementation";
import { parseCanonicalJson } from "../protocol/oasf";
import { recordNameAllowed } from "../protocol/origin";
import { agentRegistryId } from "../protocol/registration";

export type ChainIdentity = {
  owner: Address;
  agentWallet: Address;
  oasfMessage: string;
  oasfSignature: Hex | null;
};

export type VerifiedAgent = {
  displayName: string;
  description: string;
  skillIds: number[];
  registry: string;
  agentId: string;
  owner: Address;
  agentWallet: Address;
};

type DirectoryShape = {
  annotations?: Record<string, unknown>;
  authors?: unknown;
  created_at?: unknown;
  description?: unknown;
  locators?: { type?: unknown; urls?: unknown }[];
  name?: unknown;
  schema_version?: unknown;
  skills?: { id?: unknown; name?: unknown }[];
  version?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function checksum(value: string): string | null {
  if (!isAddress(value, { strict: true }) || getAddress(value) !== value) return null;
  return value;
}

export async function verifyDirectoryRecord(input: {
  recordJson: string;
  taxonomy: ReadonlyMap<number, string>;
  implementationSlot: Hex;
  chain: ChainIdentity;
}): Promise<{ ok: true; agent: VerifiedAgent } | { ok: false; reason: string }> {
  assertPinnedImplementation(input.implementationSlot);
  let parsed: DirectoryShape;
  try {
    parsed = parseCanonicalJson(input.recordJson) as DirectoryShape;
  } catch (error) {
    const message = error instanceof Error ? error.message : "OASF record is not canonical JSON.";
    return { ok: false, reason: message };
  }
  const annotations = parsed.annotations ?? {};
  const registry = text(annotations["muselancer.registry"]);
  const chainId = text(annotations["muselancer.chainId"]);
  const agentId = text(annotations["muselancer.agentId"]);
  const owner = checksum(text(annotations["muselancer.owner"]));
  const agentWallet = checksum(text(annotations["muselancer.agentWallet"]));
  const displayName = text(annotations["muselancer.displayName"]);
  if (registry !== agentRegistryId() || chainId !== String(IDENTITY_CHAIN_ID)) {
    return { ok: false, reason: "Record names a registry other than the pinned identity registry." };
  }
  if (!/^(0|[1-9]\d*)$/.test(agentId) || !owner || !agentWallet || !displayName) {
    return { ok: false, reason: "Record identity annotations are incomplete." };
  }
  if (agentWallet === zeroAddress || owner === zeroAddress) {
    return { ok: false, reason: "The agent wallet is not set." };
  }
  if (parsed.schema_version !== "1.0.0" || parsed.version !== "v1.0.0") {
    return { ok: false, reason: "Record is not OASF schema 1.0.0." };
  }
  if (!Array.isArray(parsed.skills) || parsed.skills.length === 0) {
    return { ok: false, reason: "Record has no OASF skill." };
  }
  const skillIds: number[] = [];
  for (const skill of parsed.skills) {
    if (typeof skill.id !== "number" || !Number.isInteger(skill.id) || skill.id <= 0) {
      return { ok: false, reason: "Skill id must be a positive integer." };
    }
    if (input.taxonomy.get(skill.id) !== skill.name) {
      return { ok: false, reason: "Skill name does not match the OASF taxonomy." };
    }
    skillIds.push(skill.id);
  }
  if (new Set(skillIds).size !== skillIds.length) return { ok: false, reason: "Record repeats a skill id." };
  const locator = parsed.locators?.[0];
  const urls = Array.isArray(locator?.urls) ? locator.urls : [];
  const expectedLocator = parsed.name;
  if (locator?.type !== "url" || urls.length !== 1 || urls[0] !== expectedLocator || !recordNameAllowed(text(expectedLocator))) {
    return { ok: false, reason: "Record locator is not the agent OASF URL." };
  }
  if (!text(expectedLocator).endsWith(`/api/agents/${agentId}/oasf`)) {
    return { ok: false, reason: "Record locator is not the agent OASF URL." };
  }
  if (input.chain.oasfMessage !== input.recordJson) {
    return { ok: false, reason: "Record bytes do not match the identity registry." };
  }
  if (getAddress(input.chain.owner) !== owner) return { ok: false, reason: "ownerOf does not match the signed record." };
  if (getAddress(input.chain.agentWallet) !== agentWallet) return { ok: false, reason: "The agent wallet is not set." };
  if (!input.chain.oasfSignature) return { ok: false, reason: "The OASF signature is not on the identity registry." };
  try {
    const signer = getAddress(await recoverMessageAddress({ message: input.recordJson, signature: input.chain.oasfSignature }));
    if (signer !== agentWallet) return { ok: false, reason: "OASF signature did not recover to the agent wallet." };
  } catch {
    return { ok: false, reason: "OASF signature did not recover to the agent wallet." };
  }
  return {
    ok: true,
    agent: {
      displayName,
      description: text(parsed.description),
      skillIds,
      registry,
      agentId,
      owner,
      agentWallet,
    },
  };
}
