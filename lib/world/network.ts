import { getAddress, isHex, recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { AUTH_CAPTURE_ESCROW, MEMORY_HEAD_KEY, USDC_BASE_SEPOLIA } from "../chain/constants";
import { supervisorCoversArtifact, type Verdict } from "../chain/operator";
import type { HireLock } from "../chain/commerce";
import { base64UrlToBytes, bytesToBase64Url } from "../crypto/b64";
import { aesDecrypt, aesEncrypt, decodeText, encodeText, unwrapKey, wrapKey, type PasswordWrap } from "../crypto/aes";
import { cidForBytes } from "../crypto/cid";
import { getFilebaseObject, putFilebaseObject, remotePinsEnabled } from "../storage/filebase";
import { scanPlaintext } from "../gateway/llama";
import { ownerMemoryCondition } from "../identity/lit";
import { agentWalletSetTypes, identityDomain } from "../identity/registry";
import { createMailboxKey, openEnvelope, relayView, sealTo, type Envelope, type MailboxKey } from "../messaging/seal";
import { canonicalJson, validateOasf, type OasfRecord } from "../protocol/oasf";
import { evaluatePolicy, type Policy, type PolicyRequest } from "../protocol/policy";
import { buildRegistrationFile, type RegistrationFile } from "../protocol/registration";

export type AgentOnChain = {
  agentId: string;
  owner: Address;
  agentWallet: Address;
  agentUri: string;
  metadata: Record<string, string>;
  paused: boolean;
  policy: Policy;
  spentTodayUsdc: bigint;
  actionsLastMinute: number;
};

export type PublishedRecord = {
  cid: string;
  record: OasfRecord;
  signature: Hex;
  signer: Address;
};

export type Payment = {
  id: string;
  payer: Address;
  receiver: Address;
  amount: bigint;
  expiry: number;
  status: "authorized" | "captured" | "voided" | "reclaimed";
  taskId: string;
  dispute: boolean;
  ownerApprovals: Address[];
};

export type ArtifactManifest = {
  cid: string;
  size: number;
  mediaType: string;
  taskId: string;
  readers: Address[];
};

export type DeskSnapshot = {
  nextAgent: number;
  /** Present only in memory. The desk file must not contain this key. */
  supervisorKey?: Hex;
  agents: Array<Omit<AgentOnChain, "spentTodayUsdc"> & { spentTodayUsdc: string }>;
  pins: { cid: string; bytes: string }[];
  wraps: { agentId: string; wrap: PasswordWrap }[];
  envelopes: Envelope[];
  directory: PublishedRecord[];
  payments: Array<Omit<Payment, "amount"> & { amount: string }>;
  tasks: Array<Omit<TaskRecord, "amount"> & { amount: string }>;
};

export type TaskRecord = {
  id: string;
  buyerAgentId: string;
  workerAgentId: string;
  criteria: string;
  amount: bigint;
  status: "offered" | "authorized" | "running" | "delivered" | "settled" | "revision" | "released" | "frozen";
  paymentId: string | null;
  artifactCid: string | null;
  verdict: Verdict | null;
  /** Safe description from the supervisor agent. The delivery text is not stored here. */
  supervisorReport?: string | null;
  /** Advice only. The hirer still chooses confirm, send back, or reject. */
  supervisorSuggestion?: "confirm" | "revise" | "reject" | null;
  /** What the hirer asked the worker to change when sending a delivery back. Shown to the worker on the revision run. */
  revisionNote?: string;
  /** Wrapped content key for the sealed bundle. This is not a wallet key. */
  artifactKeyWrap?: PasswordWrap;
  artifactReaders?: Address[];
  /** Set after a verified capture. The hirer can download the bundle. */
  deliveryReleased?: boolean;
  jobError?: string | null;
  /** Read-only steps from the sandbox. File text is not stored here. */
  jobLog?: { at: string; text: string }[];
  supervisorAgentId?: string;
  hiringAgentId?: string;
  supervisorSignature?: Hex;
  longHorizon?: boolean;
  deadline?: string;
  lock?: HireLock;
  authorizeTx?: Hex;
  settlementTx?: Hex;
  /** Images from the hiring agent's chat. The bytes stay in the chat record. */
  inputs?: { path: string; imageId: string; sourceAgentId: string }[];
};

export type PublicExport = {
  agents: AgentOnChain[];
  pins: { cid: string; bytes: string }[];
  envelopes: Envelope[];
  directory: PublishedRecord[];
  payments: Payment[];
  tasks: TaskRecord[];
};

export class Network {
  private nextAgent = 1;
  private agents = new Map<string, AgentOnChain>();
  private pins = new Map<string, Uint8Array>();
  private wraps = new Map<string, PasswordWrap>();
  /** Held apart from public storage. The app database never receives this map. */
  private litShares = new Map<string, Uint8Array>();
  private artifactKeys = new Map<string, { key: Uint8Array; readers: Address[] }>();
  private envelopes: Envelope[] = [];
  readonly directory: PublishedRecord[] = [];
  private payments = new Map<string, Payment>();
  readonly tasks = new Map<string, TaskRecord>();
  readonly supervisor: PrivateKeyAccount | null;
  private readonly supervisorKey?: Hex;

  constructor(supervisorKey?: Hex) {
    this.supervisorKey = supervisorKey;
    this.supervisor = supervisorKey ? privateKeyToAccount(supervisorKey) : null;
  }

  peekNextAgentId(): string {
    return String(this.nextAgent);
  }

  mintAgent(input: {
    owner: Address;
    agentWallet: Address;
    agentUri: string;
    policy: Policy;
  }): AgentOnChain {
    const agentId = String(this.nextAgent++);
    const agent: AgentOnChain = {
      agentId,
      owner: getAddress(input.owner),
      agentWallet: getAddress(input.agentWallet),
      agentUri: input.agentUri,
      metadata: {},
      paused: false,
      policy: input.policy,
      spentTodayUsdc: BigInt(0),
      actionsLastMinute: 0,
    };
    this.agents.set(agentId, agent);
    return agent;
  }

  /** Remember an agent whose id, owner, and wallet were read from the identity registry. */
  cacheAgent(input: {
    agentId: string;
    owner: Address;
    agentWallet: Address;
    agentUri: string;
    name: string;
    description: string;
    skillIds: string;
    policy: Policy;
  }): AgentOnChain {
    const current = this.agents.get(input.agentId);
    const agent: AgentOnChain = current ?? {
      agentId: input.agentId,
      owner: getAddress(input.owner),
      agentWallet: getAddress(input.agentWallet),
      agentUri: input.agentUri,
      metadata: {},
      paused: false,
      policy: input.policy,
      spentTodayUsdc: BigInt(0),
      actionsLastMinute: 0,
    };
    agent.owner = getAddress(input.owner);
    agent.agentWallet = getAddress(input.agentWallet);
    agent.agentUri = input.agentUri;
    agent.metadata = {
      ...agent.metadata,
      name: input.name,
      description: input.description,
      skillIds: input.skillIds,
    };
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  ownerOf(agentId: string): Address {
    return this.requireAgent(agentId).owner;
  }

  getAgent(agentId: string): AgentOnChain {
    return this.requireAgent(agentId);
  }

  async setAgentWallet(input: {
    agentId: string;
    owner: Address;
    nextWallet: Address;
    signature: Hex;
    deadline: bigint;
  }): Promise<void> {
    const agent = this.requireAgent(input.agentId);
    if (getAddress(input.owner) !== agent.owner) throw new Error("Only the NFT owner can set the agent wallet.");
    if (!isHex(input.signature, { strict: true })) throw new Error("Agent wallet proof is not a hex signature.");
    const nextWallet = getAddress(input.nextWallet);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (input.deadline < now) throw new Error("Agent wallet proof expired.");
    if (input.deadline > now + BigInt(300)) throw new Error("Deadline is too far.");
    const message = {
      agentId: BigInt(input.agentId),
      newWallet: nextWallet,
      owner: agent.owner,
      deadline: input.deadline,
    };
    const recovered = await recoverTypedDataAddress({
      domain: identityDomain,
      types: agentWalletSetTypes,
      primaryType: "AgentWalletSet",
      message,
      signature: input.signature,
    });
    if (getAddress(recovered) !== nextWallet) throw new Error("Agent wallet proof failed.");
    agent.agentWallet = nextWallet;
  }

  setMetadata(agentId: string, owner: Address, key: string, value: string): void {
    const agent = this.requireAgent(agentId);
    if (getAddress(owner) !== agent.owner) throw new Error("Only the NFT owner can write metadata.");
    if (key === "agentWallet") throw new Error("agentWallet is reserved.");
    agent.metadata[key] = value;
  }

  async pin(bytes: Uint8Array): Promise<string> {
    const cid = cidForBytes(bytes);
    if (!remotePinsEnabled()) {
      this.pins.set(cid, bytes);
      return cid;
    }
    await putFilebaseObject(cid, bytes);
    this.pins.delete(cid);
    return cid;
  }

  async fetchPin(cid: string): Promise<Uint8Array> {
    const local = this.pins.get(cid);
    if (local && remotePinsEnabled()) {
      await putFilebaseObject(cid, local);
      this.pins.delete(cid);
      const { saveDesk } = await import("../server/desk");
      await saveDesk(this);
      return local;
    }
    if (local) return local;
    if (!remotePinsEnabled()) throw new Error(`Unknown CID ${cid}.`);
    const remote = await getFilebaseObject(cid);
    if (!remote) throw new Error(`Unknown CID ${cid}.`);
    return remote;
  }

  async publishRegistration(input: {
    name: string;
    description: string;
    agentId: string;
    a2aEndpoint: string;
    oasfCid: string;
  }): Promise<{ file: RegistrationFile; uri: string }> {
    const file = buildRegistrationFile({
      name: input.name,
      description: input.description,
      agentId: Number(input.agentId),
      a2aEndpoint: input.a2aEndpoint,
      oasfCid: input.oasfCid,
    });
    const cid = await this.pin(encodeText(JSON.stringify(file)));
    const uri = `ipfs://${cid}/registration.json`;
    this.requireAgent(input.agentId).agentUri = uri;
    return { file, uri };
  }

  async publishOasf(input: { record: OasfRecord; signature: Hex }): Promise<PublishedRecord> {
    const problem = validateOasf(input.record);
    if (problem) throw new Error(problem);
    if (!isHex(input.signature, { strict: true })) throw new Error("OASF signature is not a hex signature.");
    const message = canonicalJson(input.record);
    const signer = getAddress(await recoverMessageAddress({ message, signature: input.signature }));
    const ext = input.record.extensions.find((item) => item.name === "muselancer.identity");
    if (!ext || signer !== getAddress(ext.data.agentWallet as Address)) {
      throw new Error("OASF signature did not recover to the agent wallet.");
    }
    const cid = cidForBytes(encodeText(message));
    await this.pin(encodeText(message));
    const published = { cid, record: input.record, signature: input.signature, signer };
    this.directory.push(published);
    return published;
  }

  search(skillId: number): PublishedRecord[] {
    return this.directory.filter((item) => item.record.skills.some((skill) => skill.id === skillId));
  }

  verifyDirectoryHit(hit: PublishedRecord): { ok: boolean; reason: string } {
    const ext = hit.record.extensions.find((item) => item.name === "muselancer.identity");
    if (!ext) return { ok: false, reason: "Missing identity extension." };
    if (getAddress(hit.signer) !== getAddress(ext.data.agentWallet as Address)) {
      return { ok: false, reason: "Signer is not the agent wallet." };
    }
    const agent = this.agents.get(ext.data.agentId);
    if (!agent) return { ok: false, reason: "Agent is not on the identity registry." };
    if (getAddress(agent.owner) !== getAddress(ext.data.owner as Address)) {
      return { ok: false, reason: "Owner does not match ownerOf." };
    }
    if (getAddress(agent.agentWallet) !== getAddress(ext.data.agentWallet as Address)) {
      return { ok: false, reason: "Agent wallet does not match the registry." };
    }
    return { ok: true, reason: "CID signature and ownerOf match." };
  }

  async saveMemory(input: {
    agentId: string;
    owner: Address;
    memoryKey: Uint8Array;
    plaintext: string;
    password: string;
  }): Promise<string> {
    if (this.ownerOf(input.agentId) !== getAddress(input.owner)) throw new Error("Memory follows the NFT owner.");
    const sealed = await aesEncrypt(input.memoryKey, encodeText(input.plaintext));
    const cid = await this.pin(encodeText(JSON.stringify(sealed)));
    this.litShares.set(input.agentId, input.memoryKey);
    this.wraps.set(input.agentId, await wrapKey(input.memoryKey, input.password));
    this.setMetadata(input.agentId, input.owner, MEMORY_HEAD_KEY, cid);
    return cid;
  }

  async readMemory(input: { agentId: string; owner: Address; password?: string }): Promise<string> {
    const condition = ownerMemoryCondition(input.agentId);
    if (condition.returnValueTest.value !== ":userAddress") throw new Error("Lit condition is malformed.");
    if (this.ownerOf(input.agentId) !== getAddress(input.owner)) {
      throw new Error("Lit refused decryption. ownerOf does not match the signer.");
    }
    let key: Uint8Array | undefined;
    try {
      key = input.password ? await unwrapKey(this.requireWrap(input.agentId), input.password) : this.litShares.get(input.agentId);
    } catch {
      throw new Error("Password did not open this memory.");
    }
    if (!key) throw new Error("No memory key for this agent.");
    const head = this.requireAgent(input.agentId).metadata[MEMORY_HEAD_KEY];
    if (!head) return "";
    const sealed = JSON.parse(decodeText(await this.fetchPin(head))) as { iv: string; ciphertext: string };
    try {
      return decodeText(await aesDecrypt(key, sealed.iv, sealed.ciphertext));
    } catch {
      throw new Error(input.password ? "Password did not open this memory." : "Memory ciphertext could not be opened.");
    }
  }

  forgetLitShare(agentId: string): void {
    this.litShares.delete(agentId);
  }

  async send(input: {
    id: string;
    from: string;
    to: string;
    sender: MailboxKey;
    recipientSpki: string;
    plaintext: string;
  }): Promise<Envelope> {
    const scan = scanPlaintext(input.plaintext, "text");
    if (!scan.allow) throw new Error(scan.reason);
    const envelope = relayView(
      await sealTo({
        id: input.id,
        from: input.from,
        to: input.to,
        senderPrivate: input.sender.privateKey,
        recipientSpki: input.recipientSpki,
        plaintext: input.plaintext,
      }),
    );
    this.envelopes.push(envelope);
    return envelope;
  }

  async putArtifact(input: {
    plaintext: string;
    readers: Address[];
    taskId?: string;
    signer?: PrivateKeyAccount;
  }): Promise<{ cid: string; manifest: ArtifactManifest; signature: Hex | null }> {
    const scan = scanPlaintext(input.plaintext, "code");
    if (!scan.allow) throw new Error(scan.reason);
    const key = memoryKey();
    const sealed = await aesEncrypt(key, encodeText(input.plaintext));
    const bytes = encodeText(JSON.stringify(sealed));
    const cid = await this.pin(bytes);
    const readers = input.readers.map((reader) => getAddress(reader));
    this.artifactKeys.set(cid, { key, readers });
    const manifest: ArtifactManifest = {
      cid,
      size: bytes.length,
      mediaType: "application/json",
      taskId: input.taskId ?? "",
      readers,
    };
    const signature = input.signer ? await input.signer.signMessage({ message: canonicalJson(manifest) }) : null;
    return { cid, manifest, signature };
  }

  artifactReaders(cid: string): Address[] | null {
    const entry = this.artifactKeys.get(cid);
    return entry ? [...entry.readers] : null;
  }

  artifactKeyBytes(cid: string): Uint8Array | null {
    return this.artifactKeys.get(cid)?.key ?? null;
  }

  restoreArtifactKey(cid: string, key: Uint8Array, readers: Address[]): void {
    this.artifactKeys.set(cid, { key, readers: readers.map((reader) => getAddress(reader)) });
  }

  forgetArtifact(cid: string): void {
    this.artifactKeys.delete(cid);
  }

  async readArtifact(cid: string, reader: Address): Promise<string> {
    const entry = this.artifactKeys.get(cid);
    if (!entry || !entry.readers.includes(getAddress(reader))) {
      throw new Error("This wallet cannot open the artifact.");
    }
    const sealed = JSON.parse(decodeText(await this.fetchPin(cid))) as { iv: string; ciphertext: string };
    return decodeText(await aesDecrypt(entry.key, sealed.iv, sealed.ciphertext));
  }

  async readInbox(recipient: MailboxKey, id: string): Promise<string> {
    const envelope = this.envelopes.find((item) => item.id === id);
    if (!envelope) throw new Error("Missing envelope.");
    return openEnvelope(envelope, recipient.privateKey);
  }

  relayExport(): Envelope[] {
    return this.envelopes.map(relayView);
  }

  authorizePayment(input: { id: string; payer: Address; receiver: Address; amount: bigint; taskId: string; expiry: number }): Payment {
    if (input.amount <= BigInt(0)) throw new Error("Amount must be positive.");
    const payment: Payment = {
      id: input.id,
      payer: getAddress(input.payer),
      receiver: getAddress(input.receiver),
      amount: input.amount,
      expiry: input.expiry,
      status: "authorized",
      taskId: input.taskId,
      dispute: false,
      ownerApprovals: [],
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  async settle(input: {
    paymentId: string;
    taskId: string;
    verdict: Verdict;
    artifactCid: string;
    signature: Hex;
    now: number;
  }): Promise<Payment> {
    const payment = this.requirePayment(input.paymentId);
    if (payment.taskId !== input.taskId) throw new Error("Payment is for a different task.");
    if (payment.status !== "authorized") throw new Error("Payment is not locked.");
    if (input.now >= payment.expiry) throw new Error("Authorization expired. The payer may reclaim.");
    if (!this.supervisor) throw new Error("A verdict signature is not available.");
    const covers = await supervisorCoversArtifact({
      taskId: input.taskId,
      verdict: input.verdict,
      artifactCid: input.artifactCid,
      signature: input.signature,
      supervisor: this.supervisor.address,
    });
    if (!covers) throw new Error("Supervisor signature does not cover this artifact.");
    if (payment.dispute && input.verdict !== "dispute") {
      throw new Error("Dispute is frozen.");
    }
    if (input.verdict === "pass") {
      payment.status = "captured";
      return payment;
    }
    if (input.verdict === "fail") {
      payment.status = "voided";
      return payment;
    }
    if (input.verdict === "needs_revision") {
      return payment;
    }
    payment.dispute = true;
    return payment;
  }

  approveDispute(paymentId: string, owner: Address): Payment {
    const payment = this.requirePayment(paymentId);
    if (!payment.dispute) throw new Error("Payment is not in dispute.");
    if (!payment.ownerApprovals.includes(getAddress(owner))) payment.ownerApprovals.push(getAddress(owner));
    return payment;
  }

  async resolveDispute(input: {
    paymentId: string;
    taskId: string;
    verdict: "pass" | "fail";
    artifactCid: string;
    signature: Hex;
    now: number;
  }): Promise<Payment> {
    const payment = this.requirePayment(input.paymentId);
    if (payment.ownerApprovals.length < 2) throw new Error("Both owners must sign before the dispute can move.");
    payment.dispute = false;
    return this.settle(input);
  }

  reclaim(paymentId: string, payer: Address, now: number): Payment {
    const payment = this.requirePayment(paymentId);
    if (getAddress(payer) !== payment.payer) throw new Error("Only the payer can reclaim.");
    if (now < payment.expiry) throw new Error("Reclaim opens at authorization expiry.");
    if (payment.status !== "authorized") throw new Error("Nothing left to reclaim.");
    payment.status = "reclaimed";
    payment.dispute = false;
    return payment;
  }

  decide(agentId: string, request: PolicyRequest) {
    const agent = this.requireAgent(agentId);
    return evaluatePolicy(agent.policy, {
      ...request,
      paused: agent.paused,
      spentTodayUsdc: agent.spentTodayUsdc.toString(),
      actionsLastMinute: agent.actionsLastMinute,
    });
  }

  noteSpend(agentId: string, amount: bigint): void {
    const agent = this.requireAgent(agentId);
    agent.spentTodayUsdc += amount;
    agent.actionsLastMinute += 1;
  }

  openTask(input: {
    id: string;
    buyerAgentId: string;
    workerAgentId: string;
    criteria: string;
    amount: bigint;
    longHorizon?: boolean;
    lock?: HireLock;
  }): TaskRecord {
    const task: TaskRecord = {
      id: input.id,
      buyerAgentId: input.buyerAgentId,
      workerAgentId: input.workerAgentId,
      criteria: input.criteria,
      amount: input.amount,
      status: "offered",
      paymentId: null,
      artifactCid: null,
      verdict: null,
      longHorizon: input.longHorizon ?? false,
      lock: input.lock,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  markAuthorized(taskId: string, paymentId: string): void {
    const task = this.requireTask(taskId);
    task.paymentId = paymentId;
    task.status = "authorized";
  }

  markRunning(taskId: string): void {
    this.requireTask(taskId).status = "running";
  }

  deliver(taskId: string, artifactCid: string): void {
    const task = this.requireTask(taskId);
    task.artifactCid = artifactCid;
    task.status = "delivered";
  }

  async applyVerdict(input: {
    taskId: string;
    verdict: Verdict;
    signature: Hex;
    now: number;
  }): Promise<TaskRecord> {
    const task = this.requireTask(input.taskId);
    if (!task.paymentId || !task.artifactCid) throw new Error("Task has no locked payment or artifact.");
    task.verdict = input.verdict;
    const payment = await this.settle({
      paymentId: task.paymentId,
      taskId: task.id,
      verdict: input.verdict,
      artifactCid: task.artifactCid,
      signature: input.signature,
      now: input.now,
    });
    if (input.verdict === "pass" && payment.status === "captured") task.status = "settled";
    else if (input.verdict === "fail" && payment.status === "voided") task.status = "released";
    else if (input.verdict === "needs_revision" && payment.status === "authorized") task.status = "revision";
    else if (input.verdict === "dispute") task.status = "frozen";
    return task;
  }

  closeHire(input: { taskId: string; verdict: "pass" | "fail" | "needs_revision"; now: number }): TaskRecord {
    const task = this.requireTask(input.taskId);
    if (!task.paymentId) throw new Error("Task has no locked payment.");
    const payment = this.requirePayment(task.paymentId);
    if (payment.status !== "authorized") throw new Error("Payment is not locked.");
    if (input.now >= payment.expiry) throw new Error("Authorization expired. The payer may reclaim.");
    task.verdict = input.verdict;
    if (input.verdict === "pass") {
      payment.status = "captured";
      task.status = "settled";
      return task;
    }
    if (input.verdict === "fail") {
      payment.status = "voided";
      task.status = "released";
      return task;
    }
    task.status = "revision";
    return task;
  }

  getPayment(id: string): Payment | undefined {
    const payment = this.payments.get(id);
    return payment ? { ...payment, ownerApprovals: [...payment.ownerApprovals] } : undefined;
  }

  snapshot(): DeskSnapshot {
    return {
      nextAgent: this.nextAgent,
      supervisorKey: this.supervisorKey,
      agents: [...this.agents.values()].map((agent) => ({
        ...agent,
        spentTodayUsdc: agent.spentTodayUsdc.toString(),
        metadata: { ...agent.metadata },
        policy: {
          ...agent.policy,
          allowedActions: [...agent.policy.allowedActions],
          allowedRecipients: [...agent.policy.allowedRecipients],
        },
      })),
      pins: [...this.pins.entries()].map(([cid, bytes]) => ({ cid, bytes: bytesToBase64Url(bytes) })),
      wraps: [...this.wraps.entries()].map(([agentId, wrap]) => ({ agentId, wrap: { ...wrap } })),
      envelopes: this.relayExport(),
      directory: this.directory.map((item) => ({ ...item, record: structuredClone(item.record) })),
      payments: [...this.payments.values()].map((payment) => ({
        ...payment,
        amount: payment.amount.toString(),
        ownerApprovals: [...payment.ownerApprovals],
      })),
      tasks: [...this.tasks.values()].map((task) => ({ ...task, amount: task.amount.toString() })),
    };
  }

  static restore(snapshot: DeskSnapshot, supervisorKey?: Hex): Network {
    const net = new Network(supervisorKey);
    net.nextAgent = snapshot.nextAgent;
    for (const agent of snapshot.agents) {
      net.agents.set(agent.agentId, {
        ...agent,
        spentTodayUsdc: BigInt(agent.spentTodayUsdc),
        metadata: { ...agent.metadata },
        policy: {
          ...agent.policy,
          allowedActions: [...agent.policy.allowedActions],
          allowedRecipients: [...agent.policy.allowedRecipients],
        },
      });
    }
    for (const pin of snapshot.pins) net.pins.set(pin.cid, base64UrlToBytes(pin.bytes));
    for (const item of snapshot.wraps) net.wraps.set(item.agentId, { ...item.wrap });
    net.envelopes.push(...snapshot.envelopes.map(relayView));
    net.directory.push(...snapshot.directory.map((item) => ({ ...item, record: structuredClone(item.record) })));
    for (const payment of snapshot.payments) {
      net.payments.set(payment.id, { ...payment, amount: BigInt(payment.amount), ownerApprovals: [...payment.ownerApprovals] });
    }
    for (const task of snapshot.tasks) net.tasks.set(task.id, { ...task, amount: BigInt(task.amount) });
    return net;
  }

  escrowAddress(): Address {
    return getAddress(AUTH_CAPTURE_ESCROW);
  }

  usdc(): Address {
    return getAddress(USDC_BASE_SEPOLIA);
  }

  publicExport(): PublicExport {
    return {
      agents: [...this.agents.values()].map((agent) => ({ ...agent, metadata: { ...agent.metadata }, policy: { ...agent.policy } })),
      pins: [...this.pins.entries()].map(([cid, bytes]) => ({ cid, bytes: bytesToBase64Url(bytes) })),
      envelopes: this.relayExport(),
      directory: this.directory.map((item) => ({ ...item })),
      payments: [...this.payments.values()].map((payment) => ({ ...payment, ownerApprovals: [...payment.ownerApprovals] })),
      tasks: [...this.tasks.values()].map((task) => {
        const { artifactKeyWrap: _wrap, ...rest } = task;
        return rest;
      }),
    };
  }

  private requireAgent(agentId: string): AgentOnChain {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}.`);
    return agent;
  }

  private requirePayment(id: string): Payment {
    const payment = this.payments.get(id);
    if (!payment) throw new Error(`Unknown payment ${id}.`);
    return payment;
  }

  private requireTask(id: string): TaskRecord {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task ${id}.`);
    return task;
  }

  private requireWrap(agentId: string): PasswordWrap {
    const wrapped = this.wraps.get(agentId);
    if (!wrapped) throw new Error("Password wrap is missing.");
    return wrapped;
  }
}

export function freshAccount(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export async function signVerdict(supervisor: PrivateKeyAccount, taskId: string, verdict: Verdict, artifactCid: string): Promise<Hex> {
  const { verdictDigest } = await import("../chain/operator");
  return supervisor.signMessage({ message: { raw: verdictDigest(taskId, verdict, artifactCid) } });
}

export function memoryKey(): Uint8Array {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export async function newMailbox(): Promise<MailboxKey> {
  return createMailboxKey();
}
