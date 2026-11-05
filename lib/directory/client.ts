import { create, type JsonObject } from "@bufbuild/protobuf";
import { Client, Config, models } from "agntcy-dir";
import { canonicalJson } from "../protocol/oasf";
import { directoryEndpoint } from "./address";

const { core_v1, search_v1 } = models;

const PAGE_SIZE = 50;
const MAX_HITS = 500;

export type DirectoryCandidate = {
  cid: string;
  recordJson: string;
};

function endpoint() {
  return directoryEndpoint(process.env.DIRECTORY_CLIENT_SERVER_ADDRESS);
}

async function openClient(): Promise<Client> {
  const target = endpoint();
  const config = new Config(target.address, "dirctl", "", target.authMode);
  const transport = await Client.createGRPCTransport(config);
  return new Client(config, transport);
}

export const DIRECTORY_TIMEOUT_MS = 15_000;
const DIRECTORY_ATTEMPTS = 2;

function isRetryableDirectoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /timed out|\[unavailable\]|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN/i.test(message);
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Directory request timed out after ${Math.round(ms / 1000)}s.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One deadline per attempt and one retry on a fresh client, so a stuck node fails fast instead of hanging the caller. */
async function withDirectory<T>(run: (client: Client) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DIRECTORY_ATTEMPTS; attempt += 1) {
    try {
      const client = await withDeadline(openClient(), DIRECTORY_TIMEOUT_MS);
      return await withDeadline(run(client), DIRECTORY_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      if (attempt === DIRECTORY_ATTEMPTS - 1 || !isRetryableDirectoryError(error)) throw asDirectoryError(error);
    }
  }
  throw asDirectoryError(lastError);
}

/** Cheap liveness probe for health checks. Never throws. */
export async function probeDirectory(timeoutMs = 5_000): Promise<boolean> {
  try {
    const client = await withDeadline(openClient(), timeoutMs);
    await withDeadline(
      client.searchCIDs(
        create(search_v1.SearchCIDsRequestSchema, {
          queries: [create(search_v1.RecordQuerySchema, { type: search_v1.RecordQueryType.NAME, value: "*" })],
          limit: 1,
          offset: 0,
        }),
      ),
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}

export function directoryRequestError(error: unknown, address = process.env.DIRECTORY_CLIENT_SERVER_ADDRESS): Error {
  if (!(error instanceof Error)) return new Error("Directory request failed.");
  if (error.message.startsWith("Directory request failed")) return error;
  if (
    error.message.startsWith("Set DIRECTORY_CLIENT_SERVER_ADDRESS") ||
    error.message.includes("requires TLS") ||
    error.message.includes("must include a port")
  ) {
    return error;
  }
  if (/timed out/i.test(error.message)) return new Error("Directory request failed: the Directory node did not answer in time.");
  const unreachable = /\[unavailable\]|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|getaddrinfo|connect E/i.test(error.message);
  const tailnet = (address ?? "").toLowerCase().includes(".ts.net");
  if (unreachable && tailnet) {
    return new Error("Directory request failed: the server cannot reach the Directory node.");
  }
  if (unreachable) return new Error("Directory request failed: the Directory node did not accept a connection.");
  return new Error(`Directory request failed: ${error.message}`);
}

function asDirectoryError(error: unknown): Error {
  return directoryRequestError(error);
}

export async function pushDirectoryRecord(recordJson: string): Promise<string> {
  const refs = await withDirectory((client) => {
    const data = JSON.parse(recordJson) as JsonObject;
    return client.push([create(core_v1.RecordSchema, { data })]);
  });
  const cid = refs[0]?.cid;
  if (!cid) throw new Error("Directory did not return a record CID.");
  return cid;
}

export async function deleteDirectoryRecord(cid: string): Promise<void> {
  if (!cid) return;
  await withDirectory((client) => client.delete([create(core_v1.RecordRefSchema, { cid })]));
}

async function searchByQuery(type: (typeof search_v1.RecordQueryType)[keyof typeof search_v1.RecordQueryType], value: string): Promise<DirectoryCandidate[]> {
  return withDirectory(async (client) => {
    const cids: string[] = [];
    for (let offset = 0; offset < MAX_HITS; offset += PAGE_SIZE) {
      const page = await client.searchCIDs(
        create(search_v1.SearchCIDsRequestSchema, {
          queries: [create(search_v1.RecordQuerySchema, { type, value })],
          limit: PAGE_SIZE,
          offset,
        }),
      );
      for (const item of page) {
        if (item.recordCid) cids.push(item.recordCid);
      }
      if (page.length < PAGE_SIZE) break;
    }
    const candidates: DirectoryCandidate[] = [];
    for (const cid of cids) {
      const [record] = await client.pull([create(core_v1.RecordRefSchema, { cid })]);
      if (!record?.data) continue;
      candidates.push({ cid, recordJson: canonicalJson(record.data) });
    }
    return candidates;
  });
}

export async function searchDirectory(skillId: number): Promise<DirectoryCandidate[]> {
  return searchByQuery(search_v1.RecordQueryType.SKILL_ID, String(skillId));
}

export async function searchAllDirectoryRecords(): Promise<DirectoryCandidate[]> {
  return searchByQuery(search_v1.RecordQueryType.NAME, "*");
}
