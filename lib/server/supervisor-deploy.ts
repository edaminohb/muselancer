import { createPrivateKey, createPublicKey } from "node:crypto";
import { generateAuthorizationSignature } from "@privy-io/server-auth/wallet-api";
import { getAddress, isHash, type Address, type Hash, type Hex } from "viem";
import { IDENTITY_CHAIN_ID, IDENTITY_REGISTRY } from "../chain/constants";
import { readDocument, writeDocument } from "../db";
import { baseClient, readOnchainAgent } from "../identity/chain";
import { identityAbi, registerCall, setAgentUriCall, setAgentWalletCall, setMetadataCall } from "../identity/registry";
import { DEFAULT_ORDINARY } from "../gateway/models";
import { loadSkillCatalog } from "../protocol/skills";
import { privyConfigured, privyServer } from "./privy";
import { prepareRegistration, publicAgent, publishAgentRecord, registrationFollowup, type AgentView } from "./register";
import { SUPERVISOR_ROLE, supervisorJobFiles } from "./supervisor-report";
import { SUPERVISOR_DISPLAY_NAME, SUPERVISOR_RECORD_KEY } from "./supervisor-id";
import { commitWorkspace, ensureWorkspace } from "./workspace";

const RECORD_KEY = SUPERVISOR_RECORD_KEY;
const NAME = SUPERVISOR_DISPLAY_NAME;
const DESCRIPTION = "Reviews a delivery in private and describes it for the hirer. Does not decide payment.";

type SupervisorRecord = {
  ownerWalletId: string;
  agentWalletId: string;
  ownerAddress: string;
  agentWallet: string;
  registerTxHash?: string;
  agentId?: string;
};

export class SupervisorDeployError extends Error {}

let inflight: Promise<AgentView> | null = null;

/** One Privy-held supervisor for every deal. The app stores addresses and the agent id, not a wallet key. */
export function ensurePlatformSupervisor(): Promise<AgentView> {
  if (!inflight) {
    inflight = deploy().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function deploy(): Promise<AgentView> {
  if (!privyConfigured()) throw new SupervisorDeployError("Privy is not configured. The supervisor cannot be registered.");
  const record = await wallets();
  const agentId = record.agentId ?? (await registerOnChain(record));
  await teach(agentId);
  return publicAgent(agentId);
}

function authorizationPrivateKey(): string {
  const raw = process.env.PRIVY_AUTHORIZATION_KEY?.trim() ?? "";
  if (!raw) throw new SupervisorDeployError("The supervisor needs a Privy authorization key on the server. No USDC has moved.");
  return raw.startsWith("wallet-auth:") || raw.startsWith("wallet-api:") ? raw : `wallet-auth:${raw}`;
}

/** Base64 SPKI public key. Privy documents this as the P-256 public key that owns a server wallet. */
export function authorizationPublicKey(privateKey: string): string {
  const body = privateKey.replace(/^wallet-auth:/, "").replace(/^wallet-api:/, "");
  try {
    const key = createPrivateKey({ key: Buffer.from(body, "base64"), format: "der", type: "pkcs8" });
    return Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" })).toString("base64");
  } catch {
    throw new SupervisorDeployError("The Privy authorization key is not a P-256 key. No USDC has moved.");
  }
}

async function wallets(): Promise<SupervisorRecord> {
  const saved = await readRecord();
  if (saved?.ownerWalletId && saved.agentWalletId && saved.ownerAddress && saved.agentWallet) return saved;
  const publicKey = authorizationPublicKey(authorizationPrivateKey());
  const privy = privyServer();
  try {
    const owner = await privy.walletApi.createWallet({ chainType: "ethereum", owner: { publicKey } });
    const agent = await privy.walletApi.createWallet({ chainType: "ethereum", owner: { publicKey } });
    if (!owner.id || !agent.id || !owner.address || !agent.address) throw new SupervisorDeployError("Privy did not create the supervisor wallets.");
    const next: SupervisorRecord = {
      ownerWalletId: owner.id,
      agentWalletId: agent.id,
      ownerAddress: getAddress(owner.address),
      agentWallet: getAddress(agent.address),
    };
    if (next.ownerAddress === next.agentWallet) throw new SupervisorDeployError("The supervisor needs two different wallets.");
    await writeRecord(next);
    return next;
  } catch (error) {
    if (error instanceof SupervisorDeployError) throw error;
    const detail = error instanceof Error ? error.message.slice(0, 240) : "Privy did not create the supervisor wallets.";
    throw new SupervisorDeployError(detail);
  }
}

async function registerOnChain(record: SupervisorRecord): Promise<string> {
  const catalog = await loadSkillCatalog();
  const skillId = catalog.find((skill) => Number.isInteger(skill.id) && skill.id > 0)?.id;
  if (!skillId) throw new SupervisorDeployError("The skill list is unavailable, so the supervisor was not registered.");
  await prepareRegistration({
    owner: record.ownerAddress,
    agentWallet: record.agentWallet,
    name: NAME,
    description: DESCRIPTION,
    skillIds: [skillId],
    model: DEFAULT_ORDINARY,
  });
  const registerHash = await registrationHash(record);
  await writeRecord({ ...record, registerTxHash: registerHash });
  const followup = await registrationFollowup(record.ownerAddress, registerHash);
  const bound = await baseClient().readContract({
    address: IDENTITY_REGISTRY,
    abi: identityAbi,
    functionName: "getAgentWallet",
    args: [BigInt(followup.agentId)],
  });
  if (getAddress(bound) !== getAddress(record.agentWallet)) {
    const walletSignature = await signTyped(record.agentWalletId, {
      domain: followup.typedData.domain,
      types: followup.typedData.types,
      primaryType: followup.typedData.primaryType,
      message: followup.typedData.message,
    });
    await send(record.ownerWalletId, record.ownerAddress, setAgentWalletCall(BigInt(followup.agentId), getAddress(record.agentWallet), BigInt(followup.typedData.message.deadline), walletSignature));
  }
  const oasfSignature = await signMessage(record.agentWalletId, followup.oasfMessage);
  await send(record.ownerWalletId, record.ownerAddress, setMetadataCall(BigInt(followup.agentId), "oasfSignature", oasfSignature));
  await send(record.ownerWalletId, record.ownerAddress, setAgentUriCall(BigInt(followup.agentId), followup.agentUri));
  const onchain = await readOnchainAgent(followup.agentId);
  if (getAddress(onchain.owner) !== getAddress(record.ownerAddress)) {
    throw new SupervisorDeployError("The supervisor registration does not belong to its Privy owner.");
  }
  if (getAddress(onchain.agentWallet) !== getAddress(record.agentWallet)) {
    throw new SupervisorDeployError("The supervisor agent wallet was not set.");
  }
  try {
    await publishAgentRecord(record.ownerAddress, followup.agentId);
  } catch {
    // The identity exists. Directory publication can be repeated later.
  }
  await writeRecord({ ...record, registerTxHash: registerHash, agentId: followup.agentId });
  return followup.agentId;
}

async function teach(agentId: string): Promise<void> {
  const seeded = await ensureWorkspace(agentId, { name: NAME, description: DESCRIPTION });
  if (seeded.tree.files.some((file) => file.path === "AGENTS.md" && file.text.includes(SUPERVISOR_ROLE))) return;
  const files = supervisorJobFiles(NAME);
  await commitWorkspace(agentId, (current) => {
    const kept = current.files.filter((file) => !files.some((next) => next.path === file.path));
    return { files: [...kept, ...files] };
  }, "owner");
}

async function registrationHash(record: SupervisorRecord): Promise<Hash> {
  if (record.registerTxHash && isHash(record.registerTxHash)) return record.registerTxHash;
  const from = getAddress(record.ownerAddress);
  const client = baseClient();
  const nonce = await client.getTransactionCount({ address: from });
  if (nonce > BigInt(0)) {
    const existing = await transactionAtNonce(from, BigInt(0));
    if (existing) {
      const receipt = await client.getTransactionReceipt({ hash: existing });
      if (receipt.status === "success" && receipt.to && getAddress(receipt.to) === IDENTITY_REGISTRY) return existing;
    }
  }
  return send(record.ownerWalletId, record.ownerAddress, registerCall());
}

async function send(walletId: string, address: string, data: Hex): Promise<Hash> {
  try {
    return await broadcast(walletId, address, data, true);
  } catch (error) {
    if (error instanceof SupervisorDeployError) throw error;
    const detail = error instanceof Error ? error.message : "Privy did not send the transaction.";
    if (!/sponsorship is not enabled/i.test(detail)) {
      throw new SupervisorDeployError(`The supervisor could not be registered. ${detail.slice(0, 180)}`);
    }
    const balance = await baseClient().getBalance({ address: getAddress(address) });
    if (balance === BigInt(0)) {
      throw new SupervisorDeployError("Turn on Privy gas sponsorship for Base Sepolia, then press Confirm and lock USDC again. No USDC has moved.");
    }
    try {
      return await broadcast(walletId, address, data, false);
    } catch (retry) {
      const retryDetail = retry instanceof Error ? retry.message.slice(0, 180) : "Privy did not send the transaction.";
      throw new SupervisorDeployError(`The supervisor could not be registered. ${retryDetail}`);
    }
  }
}

async function broadcast(walletId: string, _address: string, data: Hex, sponsor: boolean): Promise<Hash> {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ?? "";
  const appSecret = process.env.PRIVY_APP_SECRET?.trim() ?? "";
  const path = `/api/v1/wallets/${walletId}/rpc`;
  const url = `https://api.privy.io${path}`;
  const body = {
    method: "eth_sendTransaction",
    caip2: `eip155:${IDENTITY_CHAIN_ID}`,
    sponsor,
    params: { transaction: { to: IDENTITY_REGISTRY, data, chain_id: IDENTITY_CHAIN_ID } },
  };
  const signature = generateAuthorizationSignature({
    input: { version: 1, method: "POST", url, body, headers: { "privy-app-id": appId } },
    authorizationPrivateKey: authorizationPrivateKey(),
  });
  if (!signature) throw new SupervisorDeployError("The supervisor authorization key could not sign the registration.");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "privy-app-id": appId,
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
      "privy-authorization-signature": signature,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { data?: { hash?: string; transaction_id?: string }; error?: unknown; message?: string };
  if (!response.ok) {
    const nested = payload.error && typeof payload.error === "object" && "message" in payload.error ? String(payload.error.message) : "";
    const detail = payload.message || nested || (typeof payload.error === "string" ? payload.error : "Privy did not send the transaction.");
    throw new Error(detail.slice(0, 180));
  }
  if (isHash(payload.data?.hash ?? "")) return payload.data?.hash as Hash;
  if (!payload.data?.transaction_id) throw new SupervisorDeployError("Privy did not return a registration transaction.");
  return confirmedHash(payload.data.transaction_id);
}

async function confirmedHash(transactionId: string): Promise<Hash> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const tx = await readPrivyTransaction(transactionId);
    if (tx && isHash(tx.hash ?? "")) return tx.hash as Hash;
    if (tx && (tx.status === "execution_reverted" || tx.status === "failed" || tx.status === "replaced")) {
      throw new SupervisorDeployError("The supervisor registration did not confirm.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new SupervisorDeployError("The supervisor registration is still confirming. Press Confirm and lock USDC again.");
}

async function readPrivyTransaction(transactionId: string): Promise<{ hash?: string; status?: string } | null> {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ?? "";
  const appSecret = process.env.PRIVY_APP_SECRET?.trim() ?? "";
  const headers = {
    "privy-app-id": appId,
    authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
  };
  for (const url of [`https://api.privy.io/v1/transactions/${transactionId}`, `https://api.privy.io/api/v1/transactions/${transactionId}`]) {
    const response = await fetch(url, { headers });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Privy transaction lookup returned ${response.status}.`);
    const body = await response.json() as { transaction_hash?: string | null; status?: string };
    return { hash: body.transaction_hash ?? "", status: body.status };
  }
  return null;
}

async function transactionAtNonce(address: Address, nonce: bigint): Promise<Hash | null> {
  const client = baseClient();
  let low = BigInt(0);
  let high = await client.getBlockNumber();
  while (low < high) {
    const mid = (low + high) / BigInt(2);
    const count = await client.getTransactionCount({ address, blockNumber: mid });
    if (count <= nonce) low = mid + BigInt(1);
    else high = mid;
  }
  const block = await client.getBlock({ blockNumber: low, includeTransactions: true });
  const found = block.transactions.find((tx) => typeof tx !== "string" && getAddress(tx.from) === address && BigInt(tx.nonce) === nonce);
  return found && typeof found !== "string" ? found.hash : null;
}

async function signTyped(walletId: string, typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex> {
  const privy = privyServer();
  const signed = await privy.walletApi.ethereum.signTypedData({ walletId, typedData });
  if (!signed.signature.startsWith("0x")) throw new SupervisorDeployError("Privy did not sign the supervisor wallet update.");
  return signed.signature as Hex;
}

async function signMessage(walletId: string, message: string): Promise<Hex> {
  const privy = privyServer();
  const signed = await privy.walletApi.ethereum.signMessage({ walletId, message });
  if (!signed.signature.startsWith("0x")) throw new SupervisorDeployError("Privy did not sign the supervisor record.");
  return signed.signature as Hex;
}

async function readRecord(): Promise<SupervisorRecord | null> {
  const raw = await readDocument(RECORD_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as SupervisorRecord;
  if (!parsed?.ownerWalletId || !parsed.agentWalletId || !parsed.ownerAddress || !parsed.agentWallet) return null;
  if (raw.toLowerCase().includes("privatekey")) throw new SupervisorDeployError("The supervisor record must not contain a wallet key.");
  return parsed;
}

async function writeRecord(record: SupervisorRecord): Promise<void> {
  const json = JSON.stringify(record);
  if (json.toLowerCase().includes("privatekey")) throw new SupervisorDeployError("The supervisor record must not contain a wallet key.");
  await writeDocument(RECORD_KEY, json);
}
