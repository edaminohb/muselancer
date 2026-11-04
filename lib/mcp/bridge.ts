import { scanUntrusted } from "../gateway/firewall";
import { moneyTool } from "../tools/catalog";
import type { McpTool } from "./client";

export type McpConnection = {
  name: string;
  url: string;
  enabled: boolean;
  headers: { name: string; value: string }[];
  tools: McpTool[];
};

const SERVER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;

export function assertServerName(value: string): string {
  const name = value.trim();
  if (!SERVER_NAME.test(name) || name.includes(".")) throw new Error("The server name is lowercase letters, numbers, and hyphens.");
  return name;
}

export function usableMcpToolName(name: string): boolean {
  return TOOL_NAME.test(name) && !moneyTool(name);
}

/** Enabled servers. A skill request keeps only names the owner already enabled. */
export function serversForTurn(servers: McpConnection[], requested: string[]): McpConnection[] {
  const enabled = servers.filter((server) => server.enabled);
  const asked = requested.map((name) => name.trim()).filter(Boolean);
  if (asked.length === 0) return enabled;
  const wanted = new Set(asked);
  return enabled.filter((server) => wanted.has(server.name));
}

export function namespaceTools(servers: McpConnection[]): Record<string, unknown>[] {
  const namespaces: Record<string, unknown>[] = [];
  for (const server of servers) {
    const tools = server.tools.flatMap((tool) => {
      if (!usableMcpToolName(tool.name)) return [];
      const description = scanUntrusted(tool.description).allow ? tool.description.slice(0, 400) : tool.name;
      return [{
        type: "function",
        name: tool.name,
        description,
        defer_loading: true,
        parameters: parametersOf(tool.inputSchema),
      }];
    });
    if (tools.length === 0) continue;
    namespaces.push({
      type: "namespace",
      name: server.name,
      description: `Plugin ${server.name}. Tools from the server the owner connected.`,
      tools,
    });
  }
  return namespaces;
}

export function acceptMcpText(text: string, failed: boolean): string {
  const body = text.trim();
  const scan = scanUntrusted(body);
  if (!scan.allow) return scan.reason;
  const spoken = body || (failed ? "The tool failed." : "The tool returned no text.");
  const clipped = spoken.length > 4000 ? `${spoken.slice(0, 4000)}\n[truncated]` : spoken;
  return failed && body ? `The tool failed. ${clipped}` : clipped;
}

function parametersOf(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
