import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const PROTOCOL = "2025-11-25";
const BODY_CAP = 262144;

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpExchange = {
  status: number;
  contentType: string;
  text: string;
  sessionId: string;
};

export type McpPost = (input: { body: unknown; headers: Record<string, string> }) => Promise<McpExchange>;

const BLOCKED_HEADERS = new Set(["accept", "content-type", "content-length", "host", "connection", "transfer-encoding"]);

/** An https address with the credential kept out of the URL. */
export function assertMcpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("The server address must be an https URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("The server address must be an https URL.");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Put the credential in a header, not the address.");
  }
  if (!parsed.hostname) throw new Error("The server address must be an https URL.");
  return parsed.toString();
}

function blockedAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (ip.startsWith("::ffff:")) return blockedAddress(ip.slice("::ffff:".length));
  if (ip === "::1" || ip === "0.0.0.0" || ip === "::") return true;
  if (ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part)) && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

/** Refuse loopback, private, link-local, and metadata addresses before this server calls the plugin. */
export async function assertPublicMcpUrl(value: string): Promise<string> {
  const url = assertMcpUrl(value);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("The server address must be a public https URL.");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((record) => record.address);
  if (addresses.length === 0 || addresses.some((address) => blockedAddress(address))) {
    throw new Error("The server address must be a public https URL.");
  }
  return url;
}

export function safeMcpHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.trim();
    if (!/^[A-Za-z0-9-]{1,40}$/.test(key) || BLOCKED_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 512) continue;
    next[key] = value.trim();
  }
  return next;
}

export function parseMcpMessage(exchange: McpExchange, id: number | null): unknown {
  if (exchange.status >= 300 && exchange.status < 400) throw new Error("The server address must not redirect.");
  if (id === null) {
    if (exchange.status === 202 || exchange.status === 200 || exchange.status === 204) return null;
    throw new Error("The server did not accept the session.");
  }
  if (exchange.status < 200 || exchange.status >= 300) throw new Error("The server did not answer.");
  const messages = exchange.contentType.includes("text/event-stream") ? sseMessages(exchange.text) : [readJson(exchange.text)];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { id?: unknown; result?: unknown; error?: { message?: unknown } };
    if (record.id !== id) continue;
    if (record.error) {
      const detail = typeof record.error.message === "string" ? record.error.message.trim().slice(0, 180) : "";
      throw new Error(detail || "The server refused the request.");
    }
    return record.result ?? null;
  }
  throw new Error("The server did not answer.");
}

export function toolsFromList(result: unknown): { tools: McpTool[]; cursor: string } {
  if (!result || typeof result !== "object") return { tools: [], cursor: "" };
  const record = result as { tools?: unknown; nextCursor?: unknown };
  const tools: McpTool[] = [];
  if (Array.isArray(record.tools)) {
    for (const item of record.tools) {
      if (!item || typeof item !== "object") continue;
      const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
      if (typeof tool.name !== "string" || !tool.name.trim()) continue;
      const schema = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {}, required: [], additionalProperties: false };
      tools.push({
        name: tool.name.trim(),
        description: typeof tool.description === "string" ? tool.description.trim() : "",
        inputSchema: schema,
      });
    }
  }
  return { tools, cursor: typeof record.nextCursor === "string" ? record.nextCursor : "" };
}

export function textFromCall(result: unknown): { text: string; failed: boolean } {
  if (!result || typeof result !== "object") return { text: "", failed: false };
  const record = result as { content?: unknown; isError?: unknown };
  const parts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (!item || typeof item !== "object") continue;
      const block = item as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return { text: parts.join("\n"), failed: record.isError === true };
}

export async function listMcpTools(input: { url: string; headers?: Record<string, string>; post?: McpPost }): Promise<McpTool[]> {
  const url = assertMcpUrl(input.url);
  const headers = safeMcpHeaders(input.headers ?? {});
  const post = input.post ?? ((request) => postMcp(url, request));
  const session = await openSession(post, headers);
  const tools: McpTool[] = [];
  let cursor = "";
  for (let page = 0; page < 4; page += 1) {
    const listed = await rpc(post, "tools/list", cursor ? { cursor } : {}, headers, session, page + 2);
    const parsed = toolsFromList(listed.result);
    tools.push(...parsed.tools);
    session.id = listed.sessionId || session.id;
    if (!parsed.cursor || parsed.cursor === cursor) break;
    cursor = parsed.cursor;
  }
  return tools;
}

export async function callMcpTool(input: {
  url: string;
  headers?: Record<string, string>;
  name: string;
  arguments: Record<string, unknown>;
  post?: McpPost;
}): Promise<{ text: string; failed: boolean }> {
  const url = assertMcpUrl(input.url);
  const headers = safeMcpHeaders(input.headers ?? {});
  const post = input.post ?? ((request) => postMcp(url, request));
  const session = await openSession(post, headers);
  const called = await rpc(post, "tools/call", { name: input.name, arguments: input.arguments }, headers, session, 2);
  return textFromCall(called.result);
}

async function openSession(post: McpPost, headers: Record<string, string>): Promise<{ id: string }> {
  const started = await rpc(post, "initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "muselancer", version: "1.0" },
  }, headers, { id: "" }, 1);
  const session = { id: started.sessionId };
  const noted = await post({
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
    headers: sessionHeaders(headers, session.id),
  });
  parseMcpMessage(noted, null);
  if (noted.sessionId) session.id = noted.sessionId;
  return session;
}

async function rpc(
  post: McpPost,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string>,
  session: { id: string },
  id: number,
): Promise<{ result: unknown; sessionId: string }> {
  const exchange = await post({
    body: { jsonrpc: "2.0", id, method, params },
    headers: sessionHeaders(headers, session.id),
  });
  return { result: parseMcpMessage(exchange, id), sessionId: exchange.sessionId || session.id };
}

function sessionHeaders(headers: Record<string, string>, sessionId: string): Record<string, string> {
  return sessionId ? { ...headers, "mcp-session-id": sessionId } : headers;
}

async function postMcp(url: string, input: { body: unknown; headers: Record<string, string> }): Promise<McpExchange> {
  await assertPublicMcpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...input.headers,
      },
      body: JSON.stringify(input.body),
    });
    const text = await response.text();
    if (text.length > BODY_CAP) throw new Error("The server answer is too large.");
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
      sessionId: response.headers.get("mcp-session-id") ?? "",
    };
  } catch (error) {
    if (error instanceof Error && error.message === "The server answer is too large.") throw error;
    throw new Error("The server did not answer.");
  } finally {
    clearTimeout(timer);
  }
}

function sseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    messages.push(readJson(data));
  }
  return messages;
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("The server did not answer.");
  }
}
