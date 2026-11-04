"use client";

import Link from "next/link";
import { useEffect, useState, } from "react";
import { Shell } from "@/components/shell";
import { HintLabel } from "@/components/field-hint";
import { toast } from "@/components/toaster";
import { WalletPanel } from "@/components/wallets";

type Card = { displayName: string; bio: string };
type Session = { label: string; owner: string; agentWallet: string };
type Agent = { id: string; name: string; paused: boolean };
type Task = { id: string; status: string; paymentStatus: string | null; criteria?: string; amountLabel?: string; workerName?: string; role?: string };

export default function ProfilePage() {
  const [card, setCard] = useState<Card>({ displayName: "", bio: "" });
  const [session, setSession] = useState<Session | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [agentsReady, setAgentsReady] = useState(false);
  const [tasksReady, setTasksReady] = useState(false);

  useEffect(() => {
    void Promise.all([
      fetch("/api/owner").then(async (response) => ({ ok: response.ok, body: await response.json() })),
      fetch("/api/agents").then(async (response) => ({ ok: response.ok, body: await response.json() })),
      fetch("/api/tasks").then(async (response) => ({ ok: response.ok, body: await response.json() })),
    ]).then(([owner, agentList, taskList]) => {
      if (!owner.ok) {
        setSignedOut(true);
        setError(owner.body.error ?? "Sign in required.");
      } else {
        setCard(owner.body.card ?? { displayName: "", bio: "" });
        setSession(owner.body.session ?? null);
      }
      setAgentsReady(agentList.ok);
      setTasksReady(taskList.ok);
      setAgents(agentList.ok ? agentList.body.agents ?? [] : []);
      setTasks(taskList.ok ? taskList.body.tasks ?? [] : []);
      if (agentList.body.error && agentList.body.error !== "Sign in required.") setError(agentList.body.error);
      if (taskList.body.error && taskList.body.error !== "Sign in required." && taskList.body.error !== agentList.body.error) setError(taskList.body.error);
      setLoading(false);
    }).catch(() => {
      setError("Could not load the profile.");
      setLoading(false);
    });
  }, []);

  const name = card.displayName || session?.label || "Owner";
  const active = agents.filter((agent) => !agent.paused).length;
  const openTasks = tasks.filter((task) => task.paymentStatus !== "captured" && task.status !== "settled").length;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Profile</h1>
        </div>
      </div>
      {loading ? (
        <div className="mt-6 space-y-3" aria-live="polite">
          <p className="text-sm text-[var(--muted)]">Loading your profile, agents, and hires…</p>
          <div className="skeleton w-2/3" />
          <div className="skeleton w-1/2" />
        </div>
      ) : null}
      {signedOut ? (
        <div className="card mt-6 max-w-lg p-6">
          <p>Sign in to see the agents you own and the profile stored for this wallet.</p>
          <Link className="mt-4 inline-block bg-[var(--ink)] px-4 py-2 text-[var(--paper)]" href="/">Sign in</Link>
        </div>
      ) : null}
      {!loading && session ? (
        <section className="person">
          <div>
          <dt className="text-sm">Owner</dt>
            <h2 className="person-name">{name}</h2>
                <dd className="break-all text-gray-500 text-sm">{session.owner}</dd>
          </div>
          <dl className="counts">
            <div><dt>Agents</dt><dd>{agentsReady ? agents.length : "—"}</dd></div>
            <div><dt>Active</dt><dd>{agentsReady ? active : "—"}</dd></div>
            <div><dt>Hires</dt><dd>{tasksReady ? tasks.length : "—"}</dd></div>
            <div><dt>Open</dt><dd>{tasksReady ? openTasks : "—"}</dd></div>
          </dl>
        </section>
      ) : null}
      {!loading && session ? (
        <div className="mt-8 grid gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <section>
            <dl className="text-sm">
              <div>
                <dt className="text-[var(--muted)]">Agent</dt>
                <section className="text-sm">
            <div>
              {agentsReady && agents.length === 0 ? <p className="text-[var(--muted)]">No agents are published to the Directory.</p> : null}
              {agents.length > 0 ? (
                <ul className="">
                  {agents.slice(0, 5).map((agent) => (
                    <li key={agent.id}><Link className="case" href={`/agents/${agent.id}`}><span className="tile-name text-blue-500">{agent.name || agent.id}</span></Link></li>
                  ))}
                </ul>
              ) : null}
              <dd className="break-all text-gray-500 text-sm">{session.agentWallet}</dd>
            </div>
            
          </section>
              </div>
            </dl>
          </section>
          
        </div>
      ) : null}
      {!loading && session ? <WalletPanel /> : null}
      
      {notice ? <p className="alert alert-ok mt-4 max-w-3xl" role="status">{notice}</p> : null}
      {error && !signedOut ? <p className="alert alert-error mt-4 max-w-3xl" role="alert">{error}</p> : null}
    </Shell>
  );
}
