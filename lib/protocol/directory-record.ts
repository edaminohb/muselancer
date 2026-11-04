import { getAddress, isAddress, zeroAddress } from "viem";
import { IDENTITY_CHAIN_ID } from "../chain/constants";
import { canonicalJson } from "./oasf";
import { isAllowedAppOrigin } from "./origin";
import { agentRegistryId } from "./registration";

export const OASF_SCHEMA_VERSION = "1.0.0";
export const OASF_RECORD_VERSION = "v1.0.0";

export type DirectoryAnnotations = {
  "muselancer.agentId": string;
  "muselancer.agentWallet": string;
  "muselancer.chainId": string;
  "muselancer.displayName": string;
  "muselancer.owner": string;
  "muselancer.registry": string;
};

export type DirectoryRecord = {
  annotations: DirectoryAnnotations;
  authors: string[];
  created_at: string;
  description: string;
  locators: { type: "url"; urls: string[] }[];
  name: string;
  schema_version: typeof OASF_SCHEMA_VERSION;
  skills: { id: number; name: string }[];
  version: typeof OASF_RECORD_VERSION;
};

function checksumAddress(value: string, label: string): string {
  if (!isAddress(value, { strict: true }) || getAddress(value) !== value) {
    throw new Error(`${label} must be a checksummed address.`);
  }
  return value;
}

function skillName(taxonomy: ReadonlyMap<number, string>, id: number): string {
  const name = taxonomy.get(id);
  if (!name || !/^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/.test(name)) {
    throw new Error(`Skill id ${id} is not in the OASF taxonomy.`);
  }
  return name;
}

/** Canonical OASF 1.0.0 record. The returned string is what the agent wallet signs. */
export function buildDirectoryRecord(input: {
  displayName: string;
  description: string;
  skillIds: number[];
  taxonomy: ReadonlyMap<number, string>;
  agentId: string;
  agentWallet: string;
  owner: string;
  createdAt: string;
  origin: string;
}): string {
  const displayName = input.displayName.trim();
  const description = input.description.trim();
  const origin = input.origin.replace(/\/$/, "");
  if (!displayName || displayName.length > 80) throw new Error("Name must be 1–80 characters.");
  if (!description || description.length > 280) throw new Error("Description must be 1–280 characters.");
  if (!/^(0|[1-9]\d*)$/.test(input.agentId)) throw new Error("Agent id must be a non-negative integer.");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.createdAt) || Number.isNaN(Date.parse(input.createdAt))) {
    throw new Error("created_at must be UTC RFC3339.");
  }
  if (!isAllowedAppOrigin(origin)) throw new Error("Set NEXT_PUBLIC_APP_URL to an https origin or http://localhost:3000.");
  const owner = checksumAddress(input.owner, "Owner");
  const agentWallet = checksumAddress(input.agentWallet, "Agent wallet");
  if (owner === zeroAddress || agentWallet === zeroAddress) throw new Error("The agent wallet is not set.");
  if (owner === agentWallet) throw new Error("The agent wallet must be a second Privy wallet.");
  if (!input.skillIds.length || new Set(input.skillIds).size !== input.skillIds.length) {
    throw new Error("At least one OASF taxonomy skill id is required.");
  }
  const locator = `${origin}/api/agents/${input.agentId}/oasf`;
  const record: DirectoryRecord = {
    annotations: {
      "muselancer.agentId": input.agentId,
      "muselancer.agentWallet": agentWallet,
      "muselancer.chainId": String(IDENTITY_CHAIN_ID),
      "muselancer.displayName": displayName,
      "muselancer.owner": owner,
      "muselancer.registry": agentRegistryId(),
    },
    authors: [owner],
    created_at: input.createdAt,
    description,
    locators: [{ type: "url", urls: [locator] }],
    name: locator,
    schema_version: OASF_SCHEMA_VERSION,
    skills: input.skillIds.map((id) => {
      if (!Number.isInteger(id) || id <= 0) throw new Error("Skill id must be a positive integer.");
      return { id, name: skillName(input.taxonomy, id) };
    }),
    version: OASF_RECORD_VERSION,
  };
  return canonicalJson(record);
}
