"use client";

/**
 * One tab owns the XMTP database. Other tabs of this site read and send
 * through it. The owner releases the database when the tab closes.
 */

import { mergeChatRows, oldestFirst } from "@/lib/chat/rows";

type Peer = { identifier: string; kind: "ethereum" };
type HistoryPosition = { sentAt: unknown; deliveryCursor: string };
type DmMessage = {
  id: string;
  senderInboxId: string;
  content: { kind: string; value?: unknown };
  sentAtNs?: string | number | bigint;
  sentAt?: string | number | Date | { ns?: bigint };
};
type Dm = {
  sync: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  messages: (options?: { limit?: number; direction?: "ascending" | "descending" }) => Promise<DmMessage[]>;
  messageHistoryPage?: (
    options?: { limit?: number; direction?: "ascending" | "descending" },
    before?: HistoryPosition,
  ) => Promise<{ messages: DmMessage[]; firstPosition?: HistoryPosition; lastPosition?: HistoryPosition; hasMore?: boolean }>;
};
type XmtpSigner = {
  identity: () => Promise<Peer>;
  kind: () => Promise<{ kind: "eoa" }>;
  sign: (request: { text: string }) => Promise<{ kind: "ecdsa"; value: Uint8Array }>;
};
type XmtpClient = {
  inboxId: string;
  conversations: {
    sync: () => Promise<void>;
    createDm: (peer: Peer) => Promise<Dm>;
    getDmByIdentity: (peer: Peer) => Promise<Dm | null | undefined>;
  };
  end: () => Promise<void>;
};
type XmtpOptions = {
  backend: { url: string; appVersion: string };
  storage: { location: "default"; label: string };
  allowOffline?: boolean;
};
type XmtpModule = {
  Client: {
    create: (signer: XmtpSigner, options: XmtpOptions) => Promise<XmtpClient>;
    build: (identity: Peer, options: XmtpOptions, inboxId?: string) => Promise<XmtpClient>;
  };
};

export type ChatRow = { id: string; role: "owner" | "agent"; text: string };
export type ChatIntro = { backendUrl: string; ownerAddress: string; agentWallet: string };
export type ChatSession = {
  agentId: string;
  owner: XmtpClient;
  agent: XmtpClient;
  dm: Dm;
  ownerInboxId: string;
  ownerAddress: string;
  agentWallet: string;
  backendUrl: string;
  rows: ChatRow[];
};
export type HubRole = "leader" | "follower";

type SignFactory = (address: string) => XmtpSigner;
type HubMessage =
  | { type: "ask"; requestId: string; agentId: string; intro: ChatIntro }
  | { type: "publish"; requestId: string; agentId: string; intro: ChatIntro; ownerText: string; agentText: string }
  | { type: "rows" | "published"; requestId: string; agentId: string; rows: ChatRow[]; error?: string }
  | { type: "update"; agentId: string; rows: ChatRow[] };

const LOCK = "muselancer-xmtp";
const sessions = new Map<string, ChatSession>();
const opening = new Map<string, Promise<ChatSession>>();
const clientPromises = new Map<string, Promise<XmtpClient>>();
const dmPromises = new Map<string, Promise<Dm>>();
const rowListeners = new Set<(agentId: string, rows: ChatRow[]) => void>();
const roleListeners = new Set<(role: HubRole) => void>();
const pending = new Map<string, { resolve: (rows: ChatRow[]) => void; reject: (error: Error) => void }>();
const serving = new Set<string>();

let signFactory: SignFactory | null = null;
let role: HubRole | null = null;
let starting: Promise<HubRole> | null = null;
let releaseHold: (() => void) | null = null;
let channel: BroadcastChannel | null = null;
let syncTimer: number | null = null;
let xmtpTail: Promise<void> = Promise.resolve();
let signTail: Promise<void> = Promise.resolve();

export function bindSigner(factory: SignFactory) {
  signFactory = factory;
}

export function hubRole(): HubRole | null {
  return role;
}

export function cachedSession(agentId: string): ChatSession | undefined {
  return sessions.get(agentId);
}

export function dropChat(agentId: string) {
  sessions.delete(agentId);
  opening.delete(agentId);
}

export async function refreshChat(agentId: string): Promise<ChatRow[] | null> {
  const session = sessions.get(agentId);
  if (!session || role !== "leader") return null;
  await session.dm.sync();
  return commitRows(session);
}

export function onHubRows(listener: (agentId: string, rows: ChatRow[]) => void): () => void {
  rowListeners.add(listener);
  return () => rowListeners.delete(listener);
}

export function onHubRole(listener: (role: HubRole) => void): () => void {
  roleListeners.add(listener);
  return () => roleListeners.delete(listener);
}

export function startHub(): Promise<HubRole> {
  if (starting) return starting;
  starting = elect();
  return starting;
}

function afterXmtp<T>(task: () => Promise<T>): Promise<T> {
  const run = xmtpTail.then(task, task);
  xmtpTail = run.then(() => undefined, () => undefined);
  return run;
}

function afterSign<T>(task: () => Promise<T>): Promise<T> {
  const run = signTail.then(task, task);
  signTail = run.then(() => undefined, () => undefined);
  return run;
}

function databaseBusy(cause: unknown): boolean {
  return cause instanceof Error && (
    cause.name === "XmtpError.StorageBusy"
    || cause.message.includes("StorageBusy")
    || cause.message.includes("close all target database connections")
  );
}

function needsRegistration(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "XmtpError.IdentityNotFound" || cause.message.includes("IdentityNotFound"));
}

export function connectionError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "Could not open XMTP.";
  if (databaseBusy(cause)) return "XMTP still had this wallet's database open. Wait a moment and reload the page.";
  return message;
}

function walletKey(address: string, backendUrl: string): string {
  return `${address.toLowerCase()}|${backendUrl}`;
}

function rememberedInbox(address: string): string | undefined {
  try {
    return localStorage.getItem(`muselancer-xmtp-inbox:${address.toLowerCase()}`) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberInbox(address: string, inboxId: string) {
  try {
    localStorage.setItem(`muselancer-xmtp-inbox:${address.toLowerCase()}`, inboxId);
  } catch {
    // The connection still works for this page when storage is blocked.
  }
}

async function loadXmtp(): Promise<XmtpModule> {
  const statement = ["return ", "imp", `ort(${JSON.stringify("/xmtp/client.js")})`].join("");
  const load = new Function(statement) as () => Promise<XmtpModule>;
  return load();
}

async function openClient(create: () => Promise<XmtpClient>): Promise<XmtpClient> {
  try {
    return await create();
  } catch (cause) {
    if (!databaseBusy(cause)) throw cause;
    await new Promise((resolve) => setTimeout(resolve, 700));
    return await create();
  }
}

async function buildStored(Client: XmtpModule["Client"], address: string, backend: XmtpOptions["backend"]): Promise<XmtpClient> {
  const identity: Peer = { identifier: address, kind: "ethereum" };
  const storage = { location: "default" as const, label: address.toLowerCase() };
  const inboxId = rememberedInbox(address);
  try {
    return await Client.build(identity, { backend, storage, allowOffline: Boolean(inboxId) }, inboxId);
  } catch (cause) {
    if (!inboxId || needsRegistration(cause)) throw cause;
    return Client.build(identity, { backend, storage });
  }
}

function signerFor(address: string): XmtpSigner {
  const factory = signFactory;
  if (factory) return factory(address);
  return {
    identity: async () => ({ identifier: address, kind: "ethereum" as const }),
    kind: async () => ({ kind: "eoa" as const }),
    sign: async () => {
      throw new Error("This tab cannot sign yet. Reload the conversation.");
    },
  };
}

function connectWallet(
  Client: XmtpModule["Client"],
  address: string,
  backend: XmtpOptions["backend"],
  onRegister: () => void,
): Promise<XmtpClient> {
  const key = walletKey(address, backend.url);
  const existing = clientPromises.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const client = await buildStored(Client, address, backend);
      rememberInbox(address, client.inboxId);
      return client;
    } catch (cause) {
      if (databaseBusy(cause)) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        try {
          const client = await buildStored(Client, address, backend);
          rememberInbox(address, client.inboxId);
          return client;
        } catch (again) {
          if (!needsRegistration(again)) throw again;
        }
      } else if (!needsRegistration(cause)) {
        throw cause;
      }
    }
    return afterSign(async () => {
      onRegister();
      const client = await openClient(() => Client.create(signerFor(address), {
        backend,
        storage: { location: "default", label: address.toLowerCase() },
      }));
      rememberInbox(address, client.inboxId);
      return client;
    });
  })().catch((cause) => {
    clientPromises.delete(key);
    throw cause;
  });
  clientPromises.set(key, promise);
  return promise;
}

function connectDm(owner: XmtpClient, agentWallet: string): Promise<Dm> {
  const key = `${owner.inboxId}|${agentWallet.toLowerCase()}`;
  const existing = dmPromises.get(key);
  if (existing) return existing;
  const peer: Peer = { identifier: agentWallet, kind: "ethereum" };
  const promise = (async () => {
    const found = await owner.conversations.getDmByIdentity(peer).catch(() => undefined);
    if (found) return found;
    await owner.conversations.sync();
    const again = await owner.conversations.getDmByIdentity(peer);
    return again ?? await owner.conversations.createDm(peer);
  })().catch((cause) => {
    dmPromises.delete(key);
    throw cause;
  });
  dmPromises.set(key, promise);
  return promise;
}

function textOf(content: { kind: string; value?: unknown }): string | null {
  if ((content.kind === "text" || content.kind === "markdown") && typeof content.value === "string" && content.value) return content.value;
  return null;
}

const MESSAGE_LIMIT = 1000;
const PAGE_LIMIT = 200;
const HISTORY_CAP = 2000;
const NS_PER_MS = BigInt("1000000");

async function listMessages(dm: Dm): Promise<DmMessage[]> {
  if (dm.messageHistoryPage) {
    try {
      return await listHistory(dm);
    } catch {
      return dm.messages({ limit: MESSAGE_LIMIT, direction: "ascending" });
    }
  }
  return dm.messages({ limit: MESSAGE_LIMIT, direction: "ascending" });
}

async function listHistory(dm: Dm): Promise<DmMessage[]> {
  const page = dm.messageHistoryPage;
  if (!page) return dm.messages({ limit: MESSAGE_LIMIT, direction: "ascending" });
  const collected: DmMessage[] = [];
  let before: HistoryPosition | undefined;
  let previous = "";
  for (let index = 0; index < 10 && collected.length < HISTORY_CAP; index += 1) {
    const history = await page({ limit: PAGE_LIMIT, direction: "descending" }, before);
    collected.push(...history.messages);
    const cursor = history.lastPosition ?? history.firstPosition;
    const mark = cursor ? `${cursor.deliveryCursor}` : "";
    if (!history.hasMore || !cursor || mark === previous) break;
    previous = mark;
    before = cursor;
  }
  return collected.slice(0, HISTORY_CAP).reverse();
}

function sentNs(message: DmMessage): bigint | null {
  if (message.sentAtNs != null) {
    try {
      return BigInt(message.sentAtNs);
    } catch {
      return null;
    }
  }
  if (message.sentAt instanceof Date) {
    try {
      return BigInt(message.sentAt.getTime()) * NS_PER_MS;
    } catch {
      return null;
    }
  }
  if (message.sentAt && typeof message.sentAt === "object" && "ns" in message.sentAt && message.sentAt.ns != null) {
    try {
      return BigInt(message.sentAt.ns);
    } catch {
      return null;
    }
  }
  if (message.sentAt != null && typeof message.sentAt !== "object") {
    try {
      return BigInt(message.sentAt);
    } catch {
      return null;
    }
  }
  return null;
}

function rowsFrom(messages: DmMessage[], ownerInboxId: string, hint: ChatRow[] = []): ChatRow[] {
  const next: ChatRow[] = [];
  const times: (bigint | null)[] = [];
  for (const message of messages) {
    const line = textOf(message.content);
    if (!line) continue;
    next.push({ id: message.id, role: message.senderInboxId === ownerInboxId ? "owner" : "agent", text: line });
    times.push(sentNs(message));
  }
  if (next.length > 1 && times.every((time) => time != null)) {
    const ordered = next.map((row, index) => ({ row, time: times[index] as bigint }));
    ordered.sort((left, right) => (left.time < right.time ? -1 : left.time > right.time ? 1 : 0));
    return ordered.map((item) => item.row);
  }
  return oldestFirst(next, hint);
}

function sameRows(left: ChatRow[], right: ChatRow[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => row.id === right[index]?.id && row.text === right[index]?.text);
}

function emitRows(agentId: string, rows: ChatRow[]) {
  for (const listener of rowListeners) listener(agentId, rows);
}

function broadcastRows(agentId: string, rows: ChatRow[]) {
  emitRows(agentId, rows);
  channel?.postMessage({ type: "update", agentId, rows } satisfies HubMessage);
}

async function commitRows(session: ChatSession): Promise<ChatRow[]> {
  const fetched = rowsFrom(await listMessages(session.dm), session.ownerInboxId, session.rows);
  const rows = mergeChatRows(session.rows, fetched);
  if (rows.length === 0 && session.rows.length > 0) return session.rows;
  if (!sameRows(session.rows, rows)) {
    session.rows = rows;
    broadcastRows(session.agentId, rows);
  }
  return session.rows;
}

async function writeTurn(session: ChatSession, ownerText: string, agentText: string): Promise<ChatRow[]> {
  await session.dm.sendText(ownerText);
  try {
    await session.agent.conversations.sync();
    const peer: Peer = { identifier: session.ownerAddress, kind: "ethereum" };
    const agentDm = (await session.agent.conversations.getDmByIdentity(peer)) ?? (await session.agent.conversations.createDm(peer));
    await agentDm.sendText(agentText);
    await session.dm.sync();
    return commitRows(session);
  } catch (cause) {
    await session.dm.sync().catch(() => undefined);
    await commitRows(session).catch(() => undefined);
    throw cause;
  }
}

function introOf(agentId: string, intro: ChatIntro): ChatIntro {
  const backendUrl = intro.backendUrl.trim().replace(/\/$/, "");
  if (!backendUrl || !intro.ownerAddress || !intro.agentWallet) throw new Error("Set XMTP_BACKEND_URL.");
  if (!agentId) throw new Error("Agent not found.");
  return { backendUrl, ownerAddress: intro.ownerAddress, agentWallet: intro.agentWallet };
}

export function openChat(agentId: string, intro: ChatIntro, onStatus: (line: string) => void): Promise<ChatSession> {
  if (role !== "leader") return Promise.reject(new Error("This tab is using the conversation open in the other tab."));
  return ensureSession(agentId, intro, onStatus);
}

function ensureSession(agentId: string, raw: ChatIntro, onStatus: (line: string) => void): Promise<ChatSession> {
  const intro = introOf(agentId, raw);
  const known = sessions.get(agentId);
  if (known) {
    const same = known.ownerAddress.toLowerCase() === intro.ownerAddress.toLowerCase()
      && known.agentWallet.toLowerCase() === intro.agentWallet.toLowerCase()
      && known.backendUrl === intro.backendUrl;
    if (same) return Promise.resolve(known);
    dropChat(agentId);
  }
  const pendingOpen = opening.get(agentId);
  if (pendingOpen) return pendingOpen;
  const promise = afterXmtp(() => actuallyOpen(agentId, intro, onStatus)).catch((cause: unknown) => {
    opening.delete(agentId);
    throw cause;
  });
  opening.set(agentId, promise);
  return promise;
}

async function actuallyOpen(agentId: string, intro: ChatIntro, onStatus: (line: string) => void): Promise<ChatSession> {
  const { Client } = await loadXmtp();
  const backend = { url: intro.backendUrl, appVersion: "muselancer/1.0" };
  const [agent, owner] = await Promise.all([
    connectWallet(Client, intro.agentWallet, backend, () => onStatus("Registering the agent on XMTP")),
    connectWallet(Client, intro.ownerAddress, backend, () => onStatus("Registering the owner on XMTP")),
  ]);
  await owner.conversations.sync().catch(() => undefined);
  const dm = await connectDm(owner, intro.agentWallet);
  await dm.sync();
  const session: ChatSession = {
    agentId,
    owner,
    agent,
    dm,
    ownerInboxId: owner.inboxId,
    ownerAddress: intro.ownerAddress,
    agentWallet: intro.agentWallet,
    backendUrl: intro.backendUrl,
    rows: rowsFrom(await listMessages(dm), owner.inboxId),
  };
  sessions.set(agentId, session);
  opening.delete(agentId);
  ensureSync();
  void dm.sync().then(() => commitRows(session)).catch(() => undefined);
  return session;
}

export async function loadChat(agentId: string, intro: ChatIntro, onStatus: (line: string) => void): Promise<ChatRow[]> {
  await startHub();
  if (role === "leader") return (await openChat(agentId, intro, onStatus)).rows;
  return requestRows({ type: "ask", agentId, intro: introOf(agentId, intro) }, 60_000);
}

export async function publishTurn(agentId: string, intro: ChatIntro, ownerText: string, agentText: string): Promise<ChatRow[]> {
  await startHub();
  if (role === "leader") {
    const session = await ensureSession(agentId, intro, () => undefined);
    return writeTurn(session, ownerText, agentText);
  }
  return requestRows({ type: "publish", agentId, intro: introOf(agentId, intro), ownerText, agentText }, 60_000);
}

function requestRows(message: Omit<Extract<HubMessage, { type: "ask" | "publish" }>, "requestId">, timeoutMs: number): Promise<ChatRow[]> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const send = () => channel?.postMessage({ ...message, requestId });
    send();
    const retry = message.type === "ask" ? window.setInterval(send, 2000) : null;
    const timer = window.setTimeout(() => {
      if (retry !== null) window.clearInterval(retry);
      pending.delete(requestId);
      reject(new Error("The other tab did not answer. Reload this page."));
    }, timeoutMs);
    pending.set(requestId, {
      resolve: (rows) => {
        if (retry !== null) window.clearInterval(retry);
        window.clearTimeout(timer);
        resolve(rows);
      },
      reject: (error) => {
        if (retry !== null) window.clearInterval(retry);
        window.clearTimeout(timer);
        reject(error);
      },
    });
  });
}

function isIntro(value: unknown): value is ChatIntro {
  if (!value || typeof value !== "object") return false;
  const intro = value as ChatIntro;
  return typeof intro.backendUrl === "string" && typeof intro.ownerAddress === "string" && typeof intro.agentWallet === "string";
}

function reply(type: "rows" | "published", requestId: string, agentId: string, rows: ChatRow[], error?: string) {
  channel?.postMessage({ type, requestId, agentId, rows, error } satisfies HubMessage);
}

async function onMessage(data: unknown) {
  if (!data || typeof data !== "object") return;
  const message = data as HubMessage;
  if ((message.type === "rows" || message.type === "published") && typeof message.requestId === "string") {
    const waiter = pending.get(message.requestId);
    if (!waiter) return;
    pending.delete(message.requestId);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(Array.isArray(message.rows) ? message.rows : []);
    return;
  }
  if (message.type === "update" && typeof message.agentId === "string" && Array.isArray(message.rows)) {
    const known = sessions.get(message.agentId);
    if (known) known.rows = message.rows;
    emitRows(message.agentId, message.rows);
    return;
  }
  if (role !== "leader") return;
  if ((message.type !== "ask" && message.type !== "publish") || typeof message.requestId !== "string" || typeof message.agentId !== "string" || !isIntro(message.intro)) return;
  if (serving.has(message.requestId)) return;
  serving.add(message.requestId);
  const responseType = message.type === "ask" ? "rows" : "published";
  try {
    const session = await ensureSession(message.agentId, message.intro, () => undefined);
    if (message.type === "publish") {
      if (typeof message.ownerText !== "string" || typeof message.agentText !== "string") throw new Error("Say what to send.");
      await writeTurn(session, message.ownerText, message.agentText);
    } else {
      await session.dm.sync();
      await commitRows(session);
    }
    reply(responseType, message.requestId, message.agentId, session.rows);
  } catch (cause) {
    reply(responseType, message.requestId, message.agentId, [], connectionError(cause));
  } finally {
    serving.delete(message.requestId);
  }
}

function ensureSync() {
  if (syncTimer !== null) return;
  syncTimer = window.setInterval(() => {
    void syncOpenChats();
  }, 4000);
}

async function syncOpenChats() {
  if (role !== "leader") return;
  for (const session of sessions.values()) {
    try {
      await session.dm.sync();
      await commitRows(session);
    } catch {
      // The last saved messages stay until the next sync.
    }
  }
}

async function shutdownClients() {
  if (syncTimer !== null) window.clearInterval(syncTimer);
  syncTimer = null;
  const pendingClients = [...clientPromises.values()];
  clientPromises.clear();
  dmPromises.clear();
  sessions.clear();
  opening.clear();
  const opened = await Promise.allSettled(pendingClients);
  for (const result of opened) {
    if (result.status === "fulfilled") await result.value.end().catch(() => undefined);
  }
}

function releaseLeader() {
  releaseHold?.();
  releaseHold = null;
}

function holdLeadership(become: HubRole) {
  role = become;
  if (become === "leader") ensureSync();
  return new Promise<void>((done) => {
    releaseHold = done;
  });
}

async function elect(): Promise<HubRole> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    role = "leader";
    return "leader";
  }
  channel = new BroadcastChannel("muselancer-xmtp");
  channel.onmessage = (event) => {
    void onMessage(event.data);
  };
  window.addEventListener("pagehide", releaseLeader);
  const initial = await new Promise<HubRole>((resolve) => {
    void navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        resolve("follower");
        return;
      }
      resolve("leader");
      await holdLeadership("leader");
      await shutdownClients();
    });
  });
  role = initial;
  if (initial === "follower") {
    void navigator.locks.request(LOCK, async () => {
      const held = holdLeadership("leader");
      for (const listener of roleListeners) listener("leader");
      await held;
      await shutdownClients();
    });
  }
  return initial;
}
