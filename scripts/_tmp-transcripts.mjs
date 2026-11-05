import { createClient } from "@libsql/client";

const client = createClient({ url: "file:data/muselancer.db" });
const rows = await client.execute("select key, value from documents where key like 'chat-transcript:%'");
for (const row of rows.rows) {
  const turns = JSON.parse(String(row.value));
  const roles = Array.isArray(turns) ? turns.map((turn) => turn?.role).join(",") : "not-array";
  console.log(`${row.key} turns=${Array.isArray(turns) ? turns.length : 0} roles=${roles}`);
}
