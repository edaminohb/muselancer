"use client";

import { useEffect, useState } from "react";
import { HintLabel } from "@/components/field-hint";
import { toast } from "@/components/toaster";

type Connection = {
  name: string;
  url: string;
  enabled: boolean;
  headerNames: string[];
  tools: { name: string; description: string }[];
};

export function McpConnections({ agentId }: { agentId: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch(`/api/agents/${agentId}/connections`)
      .then((response) => response.json())
      .then((body: { connections?: Connection[]; error?: string }) => {
        if (body.connections) setConnections(body.connections);
        if (body.error) setError(body.error);
      })
      .catch(() => setError("Could not load plugins."));
  }, [agentId]);

  async function send(payload: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/agents/${agentId}/connections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { connections?: Connection[]; error?: string };
      if (!response.ok) {
        const message = body.error ?? "Could not update this plugin.";
        setError(message);
        toast("error", message);
        return false;
      }
      setConnections(body.connections ?? []);
      toast("ok", done);
      return true;
    } catch {
      setError("Could not update this plugin.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-8">
      <p className="text-sm font-medium">Plugins</p>
      <p className="mt-1 text-xs text-[var(--muted)]">A plugin is an https MCP server you connect. The agent can call its tools. The server is not sandboxed, and a skill can name only a server you already enabled.</p>
      {connections.length ? (
        <ul className="mt-3 space-y-2">
          {connections.map((connection) => (
            <li key={connection.name} className="card px-3 py-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{connection.name}</p>
                  <p className="truncate text-xs text-[var(--muted)]">{connection.url}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">{connection.enabled ? "Enabled" : "Listed, not enabled"}{connection.headerNames.length ? ` · ${connection.headerNames.length} header` : ""}</p>
                </div>
                <div className="flex gap-2">
                  {connection.enabled ? null : (
                    <button className="border border-[var(--ink)] px-3 py-1 text-sm" disabled={busy} type="button" onClick={() => void send({ action: "enable", name: connection.name }, "Plugin enabled.")}>Enable</button>
                  )}
                  <button className="border border-[var(--ink)] px-3 py-1 text-sm" disabled={busy} type="button" onClick={() => void send({ action: "remove", name: connection.name }, "Plugin removed.")}>Remove</button>
                </div>
              </div>
              {connection.tools.length ? <p className="mt-2 text-xs text-[var(--muted)]">{connection.tools.map((tool) => tool.name).join(", ")}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-[var(--muted)]">No plugin is connected.</p>
      )}
      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const headers = headerName.trim() && headerValue.trim() ? [{ name: headerName.trim(), value: headerValue.trim() }] : [];
          void send({ action: "add", name, url, headers }, "The server listed its tools. Enable it when you want the agent to use them.").then((saved) => {
            if (!saved) return;
            setName("");
            setUrl("");
            setHeaderName("");
            setHeaderValue("");
          });
        }}
      >
        <HintLabel label="Name" hint="A short lowercase name, such as docs. A skill can request this name. It cannot contain a dot.">
          <input className="mt-1 w-full px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} />
        </HintLabel>
        <HintLabel label="Server address" hint="An https URL for one MCP server. Put a token in the header, not in the address.">
          <input className="mt-1 w-full px-3 py-2" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
        </HintLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          <HintLabel label="Header name, optional" hint="The header the server expects, such as Authorization. The value is sent only to that server.">
            <input className="mt-1 w-full px-3 py-2" value={headerName} onChange={(event) => setHeaderName(event.target.value)} />
          </HintLabel>
          <HintLabel label="Header value, optional" hint="The token or secret. It is not shown again and it is not sent to the model.">
            <input className="mt-1 w-full px-3 py-2" type="password" value={headerValue} onChange={(event) => setHeaderValue(event.target.value)} />
          </HintLabel>
        </div>
        <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={busy || !name.trim() || !url.trim()} type="submit">List tools</button>
      </form>
      {error ? <p className="alert mt-3 text-sm">{error}</p> : null}
    </section>
  );
}
