import { decodeText, encodeText, unwrapKey, wrapKey, type PasswordWrap } from "../crypto/aes";
import { readDocument, writeDocument } from "../db";
import { acceptMcpText, assertServerName, serversForTurn, type McpConnection } from "../mcp/bridge";
import { callMcpTool, listMcpTools } from "../mcp/client";
import type { ValidSkill } from "../skills/package";
import { appSecret } from "./app-secret";
import { ownedAgent } from "./register";

const SEALED = "enc:v1:";

export class ConnectionError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type ConnectionView = {
  name: string;
  url: string;
  enabled: boolean;
  headerNames: string[];
  tools: { name: string; description: string }[];
};

function key(agentId: string): string {
  return `mcp:${agentId}`;
}

async function requireOwned(owner: string, agentId: string): Promise<void> {
  if (!/^\d+$/.test(agentId) || agentId === "0") throw new ConnectionError("Agent id must be a positive integer.", 400);
  const agent = await ownedAgent(owner, agentId);
  if (!agent) throw new ConnectionError("Agent not found.", 404);
}

export async function sealHeader(value: string): Promise<string> {
  if (value.startsWith(SEALED)) return value;
  const wrapped = await wrapKey(encodeText(value), appSecret());
  return SEALED + JSON.stringify(wrapped);
}

async function openHeader(value: string): Promise<string> {
  if (!value.startsWith(SEALED)) return value;
  const wrapped = JSON.parse(value.slice(SEALED.length)) as PasswordWrap;
  return decodeText(await unwrapKey(wrapped, appSecret()));
}

async function sealServers(servers: McpConnection[]): Promise<McpConnection[]> {
  const sealed: McpConnection[] = [];
  for (const server of servers) {
    const headers = [];
    for (const header of server.headers) headers.push({ name: header.name, value: await sealHeader(header.value) });
    sealed.push({ ...server, headers });
  }
  return sealed;
}

async function headerMap(headers: { name: string; value: string }[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const header of headers) out[header.name] = await openHeader(header.value);
  return out;
}

export async function readConnections(agentId: string): Promise<McpConnection[]> {
  const raw = await readDocument(key(agentId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { servers?: unknown };
    if (!Array.isArray(parsed.servers)) return [];
    return parsed.servers.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const server = item as McpConnection;
      if (typeof server.name !== "string" || typeof server.url !== "string") return [];
      return [{
        name: server.name,
        url: server.url,
        enabled: server.enabled === true,
        headers: Array.isArray(server.headers) ? server.headers.filter((header) => header && typeof header.name === "string" && typeof header.value === "string") : [],
        tools: Array.isArray(server.tools) ? server.tools : [],
      }];
    });
  } catch {
    return [];
  }
}

export function connectionView(server: McpConnection): ConnectionView {
  return {
    name: server.name,
    url: server.url,
    enabled: server.enabled,
    headerNames: server.headers.map((header) => header.name),
    tools: server.tools.map((tool) => ({ name: tool.name, description: tool.description })),
  };
}

export async function listConnections(owner: string, agentId: string): Promise<ConnectionView[]> {
  await requireOwned(owner, agentId);
  const servers = await readConnections(agentId);
  return servers.map(connectionView);
}

export function connectionsForSkills(servers: McpConnection[], skills: ValidSkill[]): McpConnection[] {
  return serversForTurn(servers, skills.flatMap((skill) => skill.manifest.requests.mcp));
}

export async function handleConnection(owner: string, agentId: string, body: unknown): Promise<ConnectionView[]> {
  await requireOwned(owner, agentId);
  const command = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const action = typeof command.action === "string" ? command.action : "";
  const name = assertServerName(typeof command.name === "string" ? command.name : "");
  const servers = await readConnections(agentId);
  if (action === "remove") {
    await writeDocument(key(agentId), JSON.stringify({ servers: await sealServers(servers.filter((server) => server.name !== name)) }));
    return (await readConnections(agentId)).map(connectionView);
  }
  if (action === "enable") {
    const existing = servers.find((server) => server.name === name);
    if (!existing) throw new ConnectionError("That server is not connected.", 404);
    existing.enabled = true;
    await writeDocument(key(agentId), JSON.stringify({ servers: await sealServers(servers) }));
    return servers.map(connectionView);
  }
  if (action !== "add") throw new ConnectionError("Choose add, enable, or remove.", 400);
  if (servers.some((server) => server.name === name)) throw new ConnectionError("That server name is already connected.", 409);
  const url = typeof command.url === "string" ? command.url : "";
  const headers = headerList(command.headers);
  let tools;
  try {
    tools = await listMcpTools({ url, headers: await headerMap(headers) });
  } catch (error) {
    throw new ConnectionError(error instanceof Error ? error.message : "The server did not list its tools.", 502);
  }
  if (tools.length === 0) throw new ConnectionError("The server did not list its tools.", 502);
  servers.push({ name, url, enabled: false, headers, tools: tools.slice(0, 24) });
  await writeDocument(key(agentId), JSON.stringify({ servers: await sealServers(servers) }));
  return servers.map(connectionView);
}

export async function callConnectedTool(agentId: string, namespace: string, name: string, args: Record<string, unknown>): Promise<string> {
  const server = (await readConnections(agentId)).find((item) => item.name === namespace && item.enabled);
  if (!server || !server.tools.some((tool) => tool.name === name)) return "That server is not connected.";
  try {
    const result = await callMcpTool({
      url: server.url,
      headers: await headerMap(server.headers),
      name,
      arguments: args,
    });
    return acceptMcpText(result.text, result.failed);
  } catch (error) {
    return error instanceof Error ? error.message : "The server did not answer.";
  }
}

function headerList(value: unknown): { name: string; value: string }[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ConnectionError("A header needs a name and a value.", 400);
  if (value.length > 4) throw new ConnectionError("A server can take four headers.", 400);
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new ConnectionError("A header needs a name and a value.", 400);
    const header = item as { name?: unknown; value?: unknown };
    const name = typeof header.name === "string" ? header.name.trim() : "";
    const headerValue = typeof header.value === "string" ? header.value.trim() : "";
    if (!/^[A-Za-z0-9-]{1,40}$/.test(name) || !headerValue || headerValue.length > 512) {
      throw new ConnectionError("A header needs a name and a value.", 400);
    }
    return { name, value: headerValue };
  });
}

export function connectionFailure(error: unknown): { message: string; status: number } {
  if (error instanceof ConnectionError) return { message: error.message, status: error.status };
  const message = error instanceof Error ? error.message : "Could not update the connection.";
  return { message, status: 400 };
}
