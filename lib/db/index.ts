import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "fs";
import path from "path";
import { documents } from "./schema";

const globalStore = globalThis as unknown as {
  muselancerDb?: ReturnType<typeof openDb>;
  muselancerSchema?: Promise<void>;
};

function configuredDb(): string {
  const value = process.env.MUSELANCER_DB?.trim();
  return value ? value : path.join(process.cwd(), "data", "muselancer.db");
}

function isRemote(location: string): boolean {
  return /^(https?|wss?|libsql):\/\//i.test(location);
}

function openDb() {
  const location = configuredDb();
  if (location === ":memory:") {
    const client = createClient({ url: "file::memory:" });
    return { client, db: drizzle(client), remote: false };
  }
  if (isRemote(location)) {
    const authToken = process.env.MUSELANCER_DB_TOKEN?.trim() ?? "";
    const client = createClient(authToken ? { url: location, authToken } : { url: location });
    return { client, db: drizzle(client), remote: true };
  }
  mkdirSync(path.dirname(location), { recursive: true });
  const client = createClient({ url: `file:${location.replace(/\\/g, "/")}` });
  return { client, db: drizzle(client), remote: false };
}

export function database() {
  if (!globalStore.muselancerDb) globalStore.muselancerDb = openDb();
  return globalStore.muselancerDb;
}

export function ensureSchema(): Promise<void> {
  if (!globalStore.muselancerSchema) {
    globalStore.muselancerSchema = initSchema().catch((error: unknown) => {
      globalStore.muselancerSchema = undefined;
      throw error;
    });
  }
  return globalStore.muselancerSchema;
}

async function initSchema(): Promise<void> {
  const location = configuredDb();
  const { client, remote } = database();
  if (!remote && location !== ":memory:") await client.execute("PRAGMA journal_mode = WAL");
  await client.execute(`
    CREATE TABLE IF NOT EXISTS documents (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await client.execute({ sql: `DELETE FROM documents WHERE key = ?`, args: ["dev-keys"] });
}

export async function readDocument(key: string): Promise<string | null> {
  await ensureSchema();
  const rows = await database().db.select().from(documents).where(eq(documents.key, key));
  return rows[0]?.value ?? null;
}

export async function writeDocument(key: string, value: string): Promise<void> {
  if (key === "dev-keys") throw new Error("Private keys are not stored.");
  await ensureSchema();
  const updatedAt = Date.now();
  await database().client.execute({
    sql: `INSERT INTO documents (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, updatedAt],
  });
}

export async function deleteDocument(key: string): Promise<void> {
  await ensureSchema();
  await database().client.execute({ sql: `DELETE FROM documents WHERE key = ?`, args: [key] });
}
