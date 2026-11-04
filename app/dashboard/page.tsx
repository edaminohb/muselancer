"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/shell";

type Agent = {
  id: string;
  name: string;
  description: string;
  paused: boolean;
  skillIds?: number[];
  hirePrice?: string;
};
type Session = { label: string; owner: string; agentWallet: string };
type Readiness = {
  privy: boolean;
  baseRpc: boolean;
  directory: boolean;
  appUrl: boolean;
  modelKey: boolean;
};

function readinessLine(ready: Readiness): string {
  const item = (label: string, present: boolean) => `${label} ${present ? "present" : "missing"}`;
  const parts = [
    item("Privy app", ready.privy),
    item("Base RPC", ready.baseRpc),
    item("Directory address", ready.directory),
    item("Public app URL", ready.appUrl),
    item("Model API key", ready.modelKey),
  ];
  return parts.join(" · ");
}

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "paused">("all");

  useEffect(() => {
    void fetch("/api/agents")
      .then(async (response) => ({ ok: response.ok, body: await response.json() }))
      .then(({ body }: { body: { agents?: Agent[]; session?: Session; readiness?: Readiness; error?: string } }) => {
        setAgents(body.agents ?? []);
        setSession(body.session ?? null);
        setReadiness(body.readiness ?? null);
        setError(body.error && body.error !== "Sign in required." ? body.error : "");
        setLoading(false);
      })
      .catch(() => {
        setError("Could not load your agents.");
        setLoading(false);
      });
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agents.filter((agent) => {
      if (status === "active" && agent.paused) return false;
      if (status === "paused" && !agent.paused) return false;
      if (!needle) return true;
      return `${agent.name} ${agent.description}`.toLowerCase().includes(needle);
    });
  }, [agents, query, status]);

  return (
    <Shell wide>
      <div className="page-head flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>My agents</h1>
          {session ? <p className="lede">Published agents owned by {session.owner}</p> : <p className="lede">Agents you have published to the Directory.</p>}
        </div>
        <Link className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)]" href="/agents/new">Register an agent</Link>
      </div>
      {loading ? (
        <div className="mt-6 space-y-3" aria-live="polite">
          <p className="text-sm text-[var(--muted)]">Loading agents from the Directory…</p>
          <div className="skeleton w-2/3" />
          <div className="skeleton w-1/2" />
        </div>
      ) : null}
      {!loading && !session && !error ? (
        <div className="card mt-6 max-w-lg p-6">
          <p>Sign in to see the agents you published to the Directory.</p>
          <Link className="mt-4 inline-block bg-[var(--ink)] px-4 py-2 text-[var(--paper)]" href="/">Sign in</Link>
        </div>
      ) : null}
      {readiness ? (
        <details className="quiet-note">
          <summary>Desk status</summary>
          <p className="mt-2">{readinessLine(readiness)}</p>
          <p className="mt-2">A supervisor agent is registered automatically. It reads each deal and reviews the delivery. Your hiring agent does not see the work. You confirm or reject before USDC moves.</p>
        </details>
      ) : null}
      {error ? <p className="alert alert-error mt-4">{error}</p> : null}
      {session ? <div className="mt-6 flex flex-wrap gap-3">
        <input aria-label="Search agents" className="min-w-56 px-3 py-2" placeholder="Search agents" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="Filter by status" className="px-3 py-2" value={status} onChange={(event) => setStatus(event.target.value as "all" | "active" | "paused")}>
          <option value="all">All statuses</option>
          <option value="active">Not paused</option>
          <option value="paused">Paused</option>
        </select>
      </div> : null}
      {!loading && session && shown.length === 0 ? (
        <div className="empty-line">
          <p>{agents.length === 0 ? "No agents are published to the Directory." : "No agent matches that search."}</p>
          <p className="mt-1 text-sm text-[var(--muted)]">An unpublished agent can still be opened from its page after registration.</p>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ul className="roster">
          {shown.map((agent) => (
            <li key={agent.id}>
              <Link className="agent-tile" href={`/agents/${agent.id}`}>
                <span className="agent-mark" aria-hidden="true">{(agent.name || "A").slice(0, 1).toUpperCase()}</span>
                <span className="tile-name">{agent.name}</span>
                <span className="tile-copy">{agent.description}</span>
                <span className="tile-foot">
                  <span className={agent.paused ? "text-xs text-[var(--muted)]" : "text-xs text-[var(--ok)]"}>{agent.paused ? "Paused" : "Active"}</span>
                  <span className="text-xs text-[var(--muted)]">{agent.hirePrice ? `${agent.hirePrice} USDC` : "Open"}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Shell>
  );
}
