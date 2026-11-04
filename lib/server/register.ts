import { getAddress, isHash, isHex, recoverMessageAddress, type Address, type Hash, type Hex } from "viem";
import { AUTH_CAPTURE_ESCROW, IDENTITY_CHAIN_ID, IDENTITY_REGISTRY, MEMORY_HEAD_KEY } from "../chain/constants";
import { deleteDocument, readDocument, writeDocument } from "../db";
import { directoryEndpoint } from "../directory/address";
import { deleteDirectoryRecord, pushDirectoryRecord, searchAllDirectoryRecords, searchDirectory } from "../directory/client";
import { verifyDirectoryRecord } from "../directory/verify";
import { assertRegistryTransaction, readImplementationSlot, readNextAgentId, readOnchainAgent, readRegistration, registryOwner, type OnchainAgent } from "../identity/chain";
import { assertPinnedImplementation } from "../identity/implementation";
import { agentWalletSetTypes, identityDomain, registerCall, setAgentUriCall, walletDeadline } from "../identity/registry";
import { writeMemoryHead } from "../memory/head";
import { buildDirectoryRecord } from "../protocol/directory-record";
import { appOrigin } from "../protocol/origin";
import { parseCanonicalJson } from "../protocol/oasf";
import { defaultPolicy } from "../protocol/policy";
import { formatUsdc, parseUsdc } from "../protocol/usdc";
import { agentRegistryId, buildOnchainRegistration } from "../protocol/registration";
import { assertRegistrationSkills, categoryCaption, SkillUnknownError, resolveSkillNames } from "../protocol/skills";
import { blankProfile, normalizeProfile, saveModels } from "../agent/profile";
import { assertModel } from "../gateway/meta";
import { memoryKey, Network } from "../world/network";
import { desk, saveDesk } from "./desk";
import { isPlatformSupervisor, platformSupervisorId } from "./supervisor-id";
import { ensureWorkspace } from "./workspace";

export type AgentView = {
  id: string;
  name: string;
  description: string;
  owner: string;
  agentWallet: string;
  skillIds: number[];
  paused: boolean;
  memoryHead: string;
  agentUri: string;
  oasfCid: string;
  identity: string;
  perTaskCapUsdc: string;
  dailyBudgetUsdc: string;
  hirePriceUsdc: string;
  perTaskCap: string;
  dailyBudget: string;
  hirePrice: string;
  allowedActions: string[];
};

function hirePriceBase(agent: { metadata: Record<string, string>; policy: { perTaskCapUsdc: string } }): string {
  const stored = agent.metadata.hirePriceUsdc;
  if (stored && /^\d+$/.test(stored) && BigInt(stored) > BigInt(0)) return stored;
  return agent.policy.perTaskCapUsdc;
}

function view(net: Network, agentId: string): AgentView {
  const agent = net.getAgent(agentId);
  const skillIds = (agent.metadata.skillIds ?? "")
    .split(",")
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
  const price = hirePriceBase(agent);
  return {
    id: agent.agentId,
    name: agent.metadata.name ?? "",
    description: agent.metadata.description ?? "",
    owner: agent.owner,
    agentWallet: agent.agentWallet,
    skillIds,
    paused: agent.paused,
    memoryHead: agent.metadata[MEMORY_HEAD_KEY] ?? "",
    agentUri: agent.agentUri,
    oasfCid: agent.metadata.directoryCid ?? "",
    identity: `${agentRegistryId()}:${agent.agentId}`,
    perTaskCapUsdc: agent.policy.perTaskCapUsdc,
    dailyBudgetUsdc: agent.policy.dailyBudgetUsdc,
    hirePriceUsdc: price,
    perTaskCap: formatUsdc(agent.policy.perTaskCapUsdc),
    dailyBudget: formatUsdc(agent.policy.dailyBudgetUsdc),
    hirePrice: formatUsdc(price),
    allowedActions: agent.policy.allowedActions,
  };
}

type KnownAgent = {
  paused: boolean;
  metadata: Record<string, string>;
  policy: ReturnType<typeof registrationPolicy>;
};

function registrationFile(onchain: OnchainAgent): { name: string; description: string; skillIds: number[] } {
  const file = JSON.parse(onchain.registrationJson) as { name?: string; description?: string };
  const record = JSON.parse(onchain.oasfMessage) as { description?: string; skills?: { id?: number }[] };
  const skillIds = (record.skills ?? []).map((skill) => skill.id).filter((id): id is number => Number.isInteger(id));
  return { name: file.name ?? "", description: file.description ?? record.description ?? "", skillIds };
}

function present(onchain: OnchainAgent, directoryCid: string, known?: KnownAgent): AgentView {
  const file = registrationFile(onchain);
  const policy = known?.policy ?? registrationPolicy();
  const price = known ? hirePriceBase(known) : policy.perTaskCapUsdc;
  return {
    id: onchain.agentId,
    name: file.name,
    description: file.description,
    owner: onchain.owner,
    agentWallet: onchain.agentWallet,
    skillIds: file.skillIds,
    paused: known?.paused ?? false,
    memoryHead: known?.metadata[MEMORY_HEAD_KEY] ?? "",
    agentUri: onchain.agentUri,
    oasfCid: directoryCid || known?.metadata.directoryCid || "",
    identity: `${agentRegistryId()}:${onchain.agentId}`,
    perTaskCapUsdc: policy.perTaskCapUsdc,
    dailyBudgetUsdc: policy.dailyBudgetUsdc,
    hirePriceUsdc: price,
    perTaskCap: formatUsdc(policy.perTaskCapUsdc),
    dailyBudget: formatUsdc(policy.dailyBudgetUsdc),
    hirePrice: formatUsdc(price),
    allowedActions: policy.allowedActions,
  };
}

async function readChainOrNull(agentId: string): Promise<OnchainAgent | null> {
  try {
    return await readOnchainAgent(agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message.includes("not on the identity registry") ||
      message.includes("not on the registry yet") ||
      message.includes("not an on-chain data URI") ||
      message.includes("no OASF record")
    ) {
      return null;
    }
    throw error;
  }
}

async function rememberFromChain(net: Network, agentId: string, owner: Address): Promise<void> {
  const onchain = await readOnchainAgent(agentId);
  if (onchain.owner !== owner) throw new Error("ownerOf does not match this account.");
  const file = registrationFile(onchain);
  net.cacheAgent({
    agentId,
    owner: onchain.owner,
    agentWallet: onchain.agentWallet,
    agentUri: onchain.agentUri,
    name: file.name,
    description: file.description,
    skillIds: file.skillIds.join(","),
    policy: net.snapshot().agents.find((agent) => agent.agentId === agentId)?.policy ?? registrationPolicy(),
  });
}

export async function listOwned(owner: string): Promise<AgentView[]> {
  const target = getAddress(owner);
  const found = await directorySearch();
  const known = new Map((await desk()).snapshot().agents.map((agent) => [agent.agentId, agent]));
  const views: AgentView[] = [];
  for (const hit of found.hits) {
    if (getAddress(hit.owner) !== target) continue;
    const onchain = await readChainOrNull(hit.agentId);
    if (!onchain || onchain.owner !== target) continue;
    views.push(present(onchain, hit.id, known.get(hit.agentId)));
  }
  return views;
}

export async function ownedAgent(owner: string, agentId: string): Promise<AgentView | null> {
  if (!/^\d+$/.test(agentId) || agentId === "0") return null;
  const target = getAddress(owner);
  const onchain = await readChainOrNull(agentId);
  if (!onchain || onchain.owner !== target) return null;
  const found = await directorySearch();
  const hit = found.hits.find((item) => item.agentId === agentId && getAddress(item.owner) === target);
  const known = (await desk()).snapshot().agents.find((agent) => agent.agentId === agentId);
  return present(onchain, hit?.id ?? "", known);
}

export type RegistryCall = { to: Address; data: Hex; chainId: number };

export type RegistrationPrepared = {
  owner: Address;
  agentWallet: Address;
  register: RegistryCall;
  registerTxHash?: Hash;
};

export type RegistrationDraft = {
  name: string;
  description: string;
  skillIds: number[];
  model: string;
  registerTxHash: string;
  agentId: string;
};

export type RegistrationFollowup = {
  agentId: string;
  agentWallet: Address;
  oasfMessage: string;
  agentUri: string;
  uriTx: RegistryCall;
  settled: boolean;
  recordWritten: boolean;
  resign: boolean;
  typedData: {
    domain: typeof identityDomain;
    types: typeof agentWalletSetTypes;
    primaryType: "AgentWalletSet";
    message: {
      agentId: string;
      newWallet: Address;
      owner: Address;
      deadline: string;
    };
  };
};

export type MintPlan = {
  predictedAgentId: string;
  oasfMessage: string;
  agentUri: string;
  agentWallet: Address;
};

type PendingRegistration = {
  name: string;
  description: string;
  skillIds: number[];
  model?: string;
  owner: Address;
  agentWallet: Address;
  registerTxHash?: Hash;
  agentId?: string;
  predictedAgentId?: string;
  deadline?: string;
  oasfMessage?: string;
  agentUri?: string;
};

export function pendingRegistrationKey(owner: Address): string {
  return `pending-registration:${owner.toLowerCase()}`;
}

function sameSkillIds(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((id, index) => id === b[index]);
}

function registrationPolicy() {
  return {
    ...defaultPolicy(),
    allowedActions: ["discover", "message", "hire", "deliver", "pay"],
    perTaskCapUsdc: "5000000",
    dailyBudgetUsdc: "5000000",
    allowedRecipients: [AUTH_CAPTURE_ESCROW.toLowerCase()],
  };
}

export async function prepareRegistration(input: {
  owner: string;
  agentWallet: string;
  name: string;
  description: string;
  skillIds: number[];
  model: string;
}): Promise<RegistrationPrepared> {
  assertRegistrationSkills(input.skillIds);
  const model = assertModel(input.model, true);
  const owner = getAddress(input.owner);
  const agentWallet = getAddress(input.agentWallet);
  if (owner === agentWallet) throw new Error("The agent wallet must be a second Privy wallet.");
  const name = input.name.trim();
  const description = input.description.trim();
  const existingRaw = await readDocument(pendingRegistrationKey(owner));
  const existing = existingRaw ? (JSON.parse(existingRaw) as PendingRegistration) : null;
  const sameIdentity = Boolean(
    existing &&
      existing.owner === owner &&
      existing.agentWallet === agentWallet &&
      existing.name === name &&
      existing.description === description &&
      sameSkillIds(existing.skillIds, input.skillIds),
  );
  const pending: PendingRegistration =
    sameIdentity && existing
      ? { ...existing, name, description, model, owner, agentWallet }
      : { name, description, skillIds: input.skillIds, model, owner, agentWallet };
  await writeDocument(pendingRegistrationKey(owner), JSON.stringify(pending));
  return {
    owner,
    agentWallet,
    register: { to: IDENTITY_REGISTRY, data: registerCall(), chainId: IDENTITY_CHAIN_ID },
    ...(pending.registerTxHash ? { registerTxHash: pending.registerTxHash } : {}),
  };
}

export async function registrationDraft(ownerAddress: string): Promise<RegistrationDraft | null> {
  const owner = getAddress(ownerAddress);
  const raw = await readDocument(pendingRegistrationKey(owner));
  if (!raw) return null;
  const pending = JSON.parse(raw) as PendingRegistration;
  if (pending.owner !== owner || !pending.name || !pending.description || !pending.skillIds?.length) return null;
  return {
    name: pending.name,
    description: pending.description,
    skillIds: pending.skillIds,
    model: pending.model ?? "",
    registerTxHash: pending.registerTxHash ?? "",
    agentId: pending.agentId ?? "",
  };
}

async function buildRecord(pending: PendingRegistration, agentId: string): Promise<{ oasfMessage: string; agentUri: string }> {
  const taxonomy = await resolveSkillNames(pending.skillIds);
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const oasfMessage = buildDirectoryRecord({
    displayName: pending.name,
    description: pending.description,
    skillIds: pending.skillIds,
    taxonomy,
    agentId,
    agentWallet: pending.agentWallet,
    owner: pending.owner,
    createdAt,
    origin: appOrigin(),
  });
  const agentUri = buildOnchainRegistration({
    name: pending.name,
    description: pending.description,
    agentId,
    oasfMessage,
  }).uri;
  return { oasfMessage, agentUri };
}

/** Build the registration file for the next agent id so one transaction can mint it and write the file. */
export async function planMintRegistration(ownerAddress: string): Promise<MintPlan> {
  const owner = getAddress(ownerAddress);
  const raw = await readDocument(pendingRegistrationKey(owner));
  if (!raw) throw new Error("Start registration again.");
  const pending = JSON.parse(raw) as PendingRegistration;
  if (pending.owner !== owner) throw new Error("Start registration again.");
  if (!pending.model) throw new Error("Choose a model. Start registration again.");
  if (pending.registerTxHash) throw new Error("Registration already started.");
  const predictedAgentId = (await readNextAgentId()).toString();
  const built = await buildRecord(pending, predictedAgentId);
  const next: PendingRegistration = { ...pending, model: pending.model, predictedAgentId, ...built };
  await writeDocument(pendingRegistrationKey(owner), JSON.stringify(next));
  return { predictedAgentId, agentWallet: pending.agentWallet, ...built };
}

function followupFrom(pending: PendingRegistration, deadline: bigint, flags: { settled: boolean; recordWritten: boolean; resign: boolean }): RegistrationFollowup {
  if (!pending.agentId || !pending.oasfMessage || !pending.agentUri) throw new Error("Start registration again.");
  return {
    agentId: pending.agentId,
    agentWallet: pending.agentWallet,
    oasfMessage: pending.oasfMessage,
    agentUri: pending.agentUri,
    settled: flags.settled,
    recordWritten: flags.recordWritten,
    resign: flags.resign,
    uriTx: {
      to: IDENTITY_REGISTRY,
      data: setAgentUriCall(BigInt(pending.agentId), pending.agentUri),
      chainId: IDENTITY_CHAIN_ID,
    },
    typedData: {
      domain: identityDomain,
      types: agentWalletSetTypes,
      primaryType: "AgentWalletSet",
      message: {
        agentId: pending.agentId,
        newWallet: pending.agentWallet,
        owner: pending.owner,
        deadline: deadline.toString(),
      },
    },
  };
}

async function registrationChainStatus(pending: PendingRegistration): Promise<{ settled: boolean; recordWritten: boolean }> {
  if (!pending.agentId || !pending.oasfMessage || !pending.agentUri) return { settled: false, recordWritten: false };
  try {
    const onchain = await readOnchainAgent(pending.agentId);
    const uriMatches = onchain.agentUri === pending.agentUri && onchain.oasfMessage === pending.oasfMessage;
    let signatureMatches = false;
    if (uriMatches && onchain.oasfSignature) {
      const signer = getAddress(await recoverMessageAddress({ message: pending.oasfMessage, signature: onchain.oasfSignature }));
      signatureMatches = signer === pending.agentWallet;
    }
    const recordWritten = uriMatches && signatureMatches;
    const settled = recordWritten && onchain.owner === pending.owner && onchain.agentWallet === pending.agentWallet;
    return { settled, recordWritten };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message.includes("not on the identity registry") ||
      message.includes("not on the registry yet") ||
      message.includes("not an on-chain data URI") ||
      message.includes("no OASF record")
    ) {
      return { settled: false, recordWritten: false };
    }
    throw error;
  }
}

export async function registrationFollowup(ownerAddress: string, registerTxHash: Hash): Promise<RegistrationFollowup> {
  const owner = getAddress(ownerAddress);
  const raw = await readDocument(pendingRegistrationKey(owner));
  if (!raw) throw new Error("Start registration again.");
  const pending = JSON.parse(raw) as PendingRegistration;
  if (pending.owner !== owner) throw new Error("Start registration again.");
  const minted = await readRegistration(registerTxHash, owner);
  const deadline = walletDeadline(Math.floor(Date.now() / 1000));
  const keepPlanned = Boolean(pending.oasfMessage && pending.agentUri && pending.predictedAgentId === minted.agentId);
  const keepMinted = Boolean(
    pending.oasfMessage && pending.agentUri && pending.agentId === minted.agentId && pending.registerTxHash === registerTxHash,
  );
  let next: PendingRegistration;
  let resign = false;
  if (keepPlanned || keepMinted) {
    next = {
      ...pending,
      model: pending.model,
      registerTxHash,
      agentId: minted.agentId,
      deadline: deadline.toString(),
      oasfMessage: pending.oasfMessage,
      agentUri: pending.agentUri,
    };
  } else {
    resign = Boolean(pending.predictedAgentId && pending.predictedAgentId !== minted.agentId);
    const built = await buildRecord(pending, minted.agentId);
    next = {
      ...pending,
      model: pending.model,
      registerTxHash,
      agentId: minted.agentId,
      predictedAgentId: minted.agentId,
      deadline: deadline.toString(),
      oasfMessage: built.oasfMessage,
      agentUri: built.agentUri,
    };
  }
  await writeDocument(pendingRegistrationKey(owner), JSON.stringify(next));
  const chain = await registrationChainStatus(next);
  return followupFrom(next, deadline, { ...chain, resign });
}

function chosenRegistrationModel(stored: string | undefined, submitted: string | undefined): string {
  const saved = stored ? assertModel(stored, true) : "";
  const sent = submitted?.trim() ? assertModel(submitted, true) : "";
  if (saved && sent && saved !== sent) throw new Error("The model is chosen at registration.");
  const model = saved || sent;
  if (!model) throw new Error("Choose a model. Start registration again.");
  return model;
}

function optionalHash(value: Hash | "" | undefined): Hash | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isHash(value)) throw new Error("Registry transaction hash is required.");
  return value;
}

export async function completeRegistration(input: {
  owner: string;
  agentWallet: string;
  password: string;
  registerTxHash: Hash;
  model?: string;
  uriTxHash?: Hash;
  signatureTxHash?: Hash;
  walletTxHash?: Hash;
  walletSignature?: Hex | "";
  oasfSignature?: Hex | "";
}): Promise<AgentView> {
  if (input.password.length < 8) throw new Error("Choose a memory password of at least 8 characters.");
  if (!isHash(input.registerTxHash)) throw new Error("Registry transaction hash is required.");
  const uriTxHash = optionalHash(input.uriTxHash);
  const signatureTxHash = optionalHash(input.signatureTxHash);
  const walletTxHash = optionalHash(input.walletTxHash);
  if (input.walletSignature !== undefined && input.walletSignature !== "" && !isHex(input.walletSignature, { strict: true })) {
    throw new Error("Wallet signatures are required.");
  }
  if (input.oasfSignature !== undefined && input.oasfSignature !== "" && !isHex(input.oasfSignature, { strict: true })) {
    throw new Error("Wallet signatures are required.");
  }
  const owner = getAddress(input.owner);
  const agentWallet = getAddress(input.agentWallet);
  const raw = await readDocument(pendingRegistrationKey(owner));
  if (!raw) throw new Error("Sign the registration again.");
  const pending = JSON.parse(raw) as PendingRegistration;
  if (!pending.agentId || !pending.oasfMessage || !pending.agentUri || pending.registerTxHash !== input.registerTxHash) {
    throw new Error("Sign the registration again.");
  }
  const model = chosenRegistrationModel(pending.model, input.model);
  if (pending.owner !== owner || pending.agentWallet !== agentWallet) throw new Error("Sign the registration again.");
  if (pending.model !== model) {
    pending.model = model;
    await writeDocument(pendingRegistrationKey(owner), JSON.stringify(pending));
  }
  const extra = [uriTxHash, signatureTxHash, walletTxHash].flatMap((hash) => (hash ? [assertRegistryTransaction(hash, owner)] : []));
  const [minted] = await Promise.all([readRegistration(input.registerTxHash, owner), ...extra]);
  if (minted.agentId !== pending.agentId) throw new Error("The identity id changed. Sign again.");
  parseCanonicalJson(pending.oasfMessage);
  const onchain = await readOnchainAgent(pending.agentId);
  if (onchain.owner !== owner) throw new Error("ownerOf does not match this account.");
  if (onchain.agentWallet !== agentWallet) throw new Error("The agent wallet is not set on the identity registry.");
  if (onchain.agentUri !== pending.agentUri || onchain.oasfMessage !== pending.oasfMessage) {
    throw new Error("The registration file on the registry does not match this agent.");
  }
  if (!onchain.oasfSignature) throw new Error("The OASF signature is not on the identity registry.");
  if (input.oasfSignature && onchain.oasfSignature.toLowerCase() !== input.oasfSignature.toLowerCase()) {
    throw new Error("The OASF signature is not on the identity registry.");
  }
  const signer = getAddress(await recoverMessageAddress({ message: pending.oasfMessage, signature: onchain.oasfSignature }));
  if (signer !== agentWallet) throw new Error("OASF signature did not recover to the agent wallet.");
  const net = await desk();
  const agent = net.cacheAgent({
    agentId: pending.agentId,
    owner,
    agentWallet,
    agentUri: onchain.agentUri,
    name: pending.name,
    description: pending.description,
    skillIds: pending.skillIds.join(","),
    policy: registrationPolicy(),
  });
  if (!agent.metadata[MEMORY_HEAD_KEY]) {
    await writeMemoryHead(net, {
      agentId: agent.agentId,
      owner,
      memoryKey: memoryKey(),
      plaintext: `Registered ${pending.name}.`,
      password: input.password,
    });
    await saveDesk(net);
  }
  await ensureWorkspace(agent.agentId, { name: pending.name, description: pending.description });
  await rememberRegistrationModel(agent.agentId, owner, model);
  try {
    await storeDirectoryCid(net, agent.agentId, onchain);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Directory request failed.";
    throw new DirectoryPublishError(agent.agentId, `Registered on the identity registry. ${message} The mint does not need to be repeated.`);
  }
  await deleteDocument(pendingRegistrationKey(owner));
  return view(net, agent.agentId);
}

async function rememberRegistrationModel(agentId: string, owner: string, model: string): Promise<void> {
  const key = `profile:${agentId}`;
  const raw = await readDocument(key);
  let profile = blankProfile(agentId, owner);
  if (raw) {
    try {
      profile = normalizeProfile(agentId, owner, JSON.parse(raw) as unknown);
    } catch {
      profile = blankProfile(agentId, owner);
    }
  }
  await writeDocument(key, JSON.stringify(saveModels(profile, { ordinary: model, longHorizon: model })));
}

export class DirectorySkillCorrection extends Error {
  readonly correction: {
    oasfMessage: string;
    agentUri: string;
    agentWallet: string;
    removed: string[];
  };

  constructor(correction: DirectorySkillCorrection["correction"]) {
    const label = correction.removed.join(", ");
    super(correction.removed.length === 1 ? `${label} is a category. Choose a skill inside it.` : `${label} are categories. Choose a skill inside each one.`);
    this.correction = correction;
  }
}

async function skillCorrection(onchain: OnchainAgent): Promise<DirectorySkillCorrection["correction"] | null> {
  const record = JSON.parse(onchain.oasfMessage) as {
    created_at?: string;
    description?: string;
    skills?: { id?: number }[];
    annotations?: { "muselancer.displayName"?: string };
  };
  const file = JSON.parse(onchain.registrationJson) as { name?: string; description?: string };
  const ids = (record.skills ?? []).map((skill) => skill.id).filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0);
  const removed: string[] = [];
  const kept: number[] = [];
  for (const id of ids) {
    const category = await categoryCaption(id);
    if (category) {
      removed.push(category);
      continue;
    }
    kept.push(id);
  }
  if (removed.length === 0) return null;
  if (kept.length === 0) throw new Error("The registration only lists OASF categories. Choose a skill inside the category.");
  const taxonomy = await resolveSkillNames(kept);
  const name = (file.name || record.annotations?.["muselancer.displayName"] || "").trim();
  const description = (file.description || record.description || "").trim();
  const oasfMessage = buildDirectoryRecord({
    displayName: name,
    description,
    skillIds: kept,
    taxonomy,
    agentId: onchain.agentId,
    agentWallet: onchain.agentWallet,
    owner: onchain.owner,
    createdAt: record.created_at ?? "",
    origin: appOrigin(),
  });
  const agentUri = buildOnchainRegistration({ name, description, agentId: onchain.agentId, oasfMessage }).uri;
  return { oasfMessage, agentUri, agentWallet: onchain.agentWallet, removed };
}

export class DirectoryPublishError extends Error {
  readonly agentId: string;

  constructor(agentId: string, message: string) {
    super(message);
    this.agentId = agentId;
  }
}

async function storeDirectoryCid(net: Network, agentId: string, onchain: OnchainAgent): Promise<void> {
  const slot = await readImplementationSlot();
  assertPinnedImplementation(slot);
  const parsed = parseCanonicalJson(onchain.oasfMessage) as { skills?: { id?: unknown }[] };
  const skillIds = (parsed.skills ?? []).map((skill) => skill.id).filter((id): id is number => typeof id === "number" && Number.isInteger(id));
  const taxonomy = await resolveSkillNames(skillIds);
  const verdict = await verifyDirectoryRecord({
    recordJson: onchain.oasfMessage,
    taxonomy,
    implementationSlot: slot,
    chain: onchain,
  });
  if (!verdict.ok) throw new Error(verdict.reason);
  const agent = net.getAgent(agentId);
  const previous = agent.metadata.directoryCid ?? "";
  const cid = await pushDirectoryRecord(onchain.oasfMessage);
  agent.metadata.directoryCid = cid;
  await saveDesk(net);
  if (previous && previous !== cid) await deleteDirectoryRecord(previous);
}

export async function publishAgentRecord(
  owner: string,
  agentId: string,
  proof?: { uriTxHash: Hash; signatureTxHash: Hash; oasfSignature: Hex },
): Promise<AgentView> {
  const chainOwner = await registryOwner(agentId);
  if (chainOwner !== getAddress(owner)) throw new Error("Only the NFT owner can publish this agent.");
  const net = await desk();
  await rememberFromChain(net, agentId, chainOwner);
  let onchain = await readOnchainAgent(agentId);
  if (onchain.owner !== chainOwner) throw new Error("ownerOf does not match this account.");
  const correction = await skillCorrection(onchain);
  if (correction) {
    if (!proof || !isHash(proof.uriTxHash) || !isHash(proof.signatureTxHash) || !isHex(proof.oasfSignature, { strict: true })) {
      throw new DirectorySkillCorrection(correction);
    }
    await Promise.all([
      assertRegistryTransaction(proof.uriTxHash, chainOwner),
      assertRegistryTransaction(proof.signatureTxHash, chainOwner),
    ]);
    onchain = await readOnchainAgent(agentId);
    if (onchain.owner !== chainOwner) throw new Error("ownerOf does not match this account.");
    if (onchain.oasfMessage !== correction.oasfMessage || onchain.agentUri !== correction.agentUri) {
      throw new Error("The registration file on the registry does not match this agent.");
    }
    if (!onchain.oasfSignature || onchain.oasfSignature.toLowerCase() !== proof.oasfSignature.toLowerCase()) {
      throw new Error("The OASF signature is not on the identity registry.");
    }
    await rememberFromChain(net, agentId, chainOwner);
  }
  await storeDirectoryCid(net, agentId, onchain);
  return view(net, agentId);
}

export async function setPaused(owner: string, agentId: string, paused: boolean): Promise<AgentView> {
  const net = await desk();
  const chainOwner = await registryOwner(agentId);
  if (chainOwner !== getAddress(owner)) throw new Error("Only the NFT owner can pause this agent.");
  await rememberFromChain(net, agentId, chainOwner);
  const agent = net.getAgent(agentId);
  agent.owner = chainOwner;
  agent.paused = paused;
  await saveDesk(net);
  return view(net, agentId);
}

export async function setCommercialTerms(
  owner: string,
  agentId: string,
  input: { hirePrice: string },
): Promise<AgentView> {
  const chainOwner = await registryOwner(agentId);
  if (chainOwner !== getAddress(owner)) throw new Error("Only the NFT owner can set the hire terms.");
  const hirePriceUsdc = parseUsdc(input.hirePrice);
  const net = await desk();
  await rememberFromChain(net, agentId, chainOwner);
  const agent = net.getAgent(agentId);
  const recipients = new Set(agent.policy.allowedRecipients.map((item) => item.toLowerCase()));
  recipients.add(AUTH_CAPTURE_ESCROW.toLowerCase());
  const actions = new Set(agent.policy.allowedActions);
  actions.add("hire");
  actions.add("pay");
  agent.owner = chainOwner;
  agent.policy = {
    ...agent.policy,
    allowedRecipients: [...recipients],
    allowedActions: [...actions],
  };
  agent.metadata = { ...agent.metadata, hirePriceUsdc };
  await saveDesk(net);
  return view(net, agentId);
}

export async function publicAgent(agentId: string): Promise<AgentView> {
  if (!/^\d+$/.test(agentId) || agentId === "0") throw new Error("Agent id must be a positive integer.");
  const onchain = await readOnchainAgent(agentId);
  const file = JSON.parse(onchain.registrationJson) as { name?: string; description?: string };
  const record = JSON.parse(onchain.oasfMessage) as { description?: string; skills?: { id?: number }[] };
  const skillIds = (record.skills ?? []).map((skill) => skill.id).filter((id): id is number => Number.isInteger(id));
  const net = await desk();
  net.cacheAgent({
    agentId,
    owner: onchain.owner,
    agentWallet: onchain.agentWallet,
    agentUri: onchain.agentUri,
    name: file.name ?? "",
    description: file.description ?? record.description ?? "",
    skillIds: skillIds.join(","),
    policy: registrationPolicy(),
  });
  await saveDesk(net);
  return view(net, agentId);
}

export async function recoverMemory(owner: string, agentId: string, password: string): Promise<string> {
  const chainOwner = await registryOwner(agentId);
  if (chainOwner !== getAddress(owner)) throw new Error("Memory follows the NFT owner.");
  const net = await desk();
  const restarted = Network.restore(net.snapshot());
  return restarted.readMemory({ agentId, owner: chainOwner, password });
}

export async function directorySearch(skillId?: number) {
  if (skillId !== undefined && (!Number.isInteger(skillId) || skillId <= 0)) throw new Error("Skill id must be a positive integer.");
  directoryEndpoint(process.env.DIRECTORY_CLIENT_SERVER_ADDRESS);
  const slot = await readImplementationSlot();
  assertPinnedImplementation(slot);
  if (skillId !== undefined) await resolveSkillNames([skillId]);
  const candidates = skillId === undefined ? await searchAllDirectoryRecords() : await searchDirectory(skillId);
  const net = await desk();
  const supervisorId = await platformSupervisorId();
  const hits = [];
  let rejected = 0;
  for (const candidate of candidates) {
    try {
      const parsed = parseCanonicalJson(candidate.recordJson) as {
        annotations?: Record<string, unknown>;
        skills?: { id?: unknown }[];
      };
      const agentId = typeof parsed.annotations?.["muselancer.agentId"] === "string" ? parsed.annotations["muselancer.agentId"] : "";
      const skillIds = (parsed.skills ?? []).map((skill) => skill.id).filter((id): id is number => typeof id === "number" && Number.isInteger(id));
      if (!/^(0|[1-9]\d*)$/.test(agentId) || (skillId !== undefined && !skillIds.includes(skillId))) {
        rejected += 1;
        continue;
      }
      const [taxonomy, onchain] = await Promise.all([resolveSkillNames(skillIds), readOnchainAgent(agentId)]);
      const verdict = await verifyDirectoryRecord({
        recordJson: candidate.recordJson,
        taxonomy,
        implementationSlot: slot,
        chain: onchain,
      });
      if (!verdict.ok) {
        rejected += 1;
        continue;
      }
      const known = net.snapshot().agents.find((agent) => agent.agentId === verdict.agent.agentId);
      if (known?.paused) continue;
      // Discover and hire search omit the supervisor. requireDealSupervisor still seats that same agent on the hire.
      if (isPlatformSupervisor({ agentId: verdict.agent.agentId, displayName: verdict.agent.displayName }, supervisorId)) continue;
      hits.push({
        id: candidate.cid,
        ...verdict.agent,
        hirePrice: known ? formatUsdc(hirePriceBase(known)) : null,
      });
    } catch (error) {
      if (error instanceof SkillUnknownError) {
        rejected += 1;
        continue;
      }
      const message = error instanceof Error ? error.message : "";
      if (
        message.startsWith("Set BASE_RPC_URL") ||
        message.includes("HTTP request failed") ||
        message.includes("fetch") ||
        message.includes("implementation changed") ||
        message.includes("OASF skill taxonomy") ||
        message.startsWith("Directory ")
      ) {
        throw error;
      }
      rejected += 1;
    }
  }
  return {
    rejected,
    hits,
    note: "Available agents are the directory records the identity registry confirms. Paused agents are left out. Choose one to hire.",
  };
}
