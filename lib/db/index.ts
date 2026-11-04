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

function openDb() {
  const file = process.env.MUSELANCER_DB ?? path.join(process.cwd(), "data", "muselancer.db");
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const url = file === ":memory:" ? "file::memory:" : `file:${file.replace(/\\/g, "/")}`;
  const client = createClient({ url });
  const db = drizzle(client);
  return { client, db };
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
  const file = process.env.MUSELANCER_DB ?? path.join(process.cwd(), "data", "muselancer.db");
  const { client } = database();
  if (file !== ":memory:") await client.execute("PRAGMA journal_mode = WAL");
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
