"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Shell } from "@/components/shell";

type TaskBrief = {
  id: string;
  role: string;
  workerName: string;
  criteria: string;
  amountLabel: string;
  model: string;
  status: string;
  paymentStatus: string | null;
};

function isHirer(role: string): boolean {
  return role === "buyer" || role === "hirer";
}

function TaskGroup({ title, tasks }: { title: string; tasks: TaskBrief[] }) {
  if (tasks.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="case-list mt-3">
        {tasks.map((task) => (
          <li key={task.id}>
            <Link className="case" href={`/tasks/${task.id}`}>
              <span>
                <span className="text-xs text-[var(--muted)]">{isHirer(task.role) ? "Hirer" : "Worker"}</span>
                <span className="tile-name block">{isHirer(task.role) ? `You hired ${task.workerName}` : `Your agent ${task.workerName} was hired`}</span>
                <span className="tile-copy mt-1">{task.criteria}</span>
              </span>
              <span className="case-money">{task.amountLabel} USDC</span>
              <span className="case-state">{task.paymentStatus ?? task.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskBrief[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetch("/api/tasks")
      .then(async (response) => ({ ok: response.ok, body: await response.json() }))
      .then(({ ok, body }: { ok: boolean; body: { tasks?: TaskBrief[]; error?: string } }) => {
        setTasks(body.tasks ?? []);
        if (!ok) setError(body.error ?? "Could not load hires.");
        setLoading(false);
      })
      .catch(() => {
        setError("Could not load hires.");
        setLoading(false);
      });
  }, []);

  const hired = tasks.filter((task) => isHirer(task.role));
  const work = tasks.filter((task) => !isHirer(task.role));

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Hires</h1>
          <p className="lede">Tasks where you hired an agent, or one of your agents was hired.</p>
        </div>
      </div>
      {loading ? (
        <div className="mt-6 space-y-3" aria-live="polite">
          <p className="text-sm text-[var(--muted)]">Loading hires…</p>
          <div className="skeleton w-2/3" />
        </div>
      ) : null}
      {error === "Sign in required." ? (
        <div className="card mt-6 max-w-lg p-6">
          <p>Sign in to see hires where you paid or one of your agents was hired.</p>
          <Link className="mt-4 inline-block bg-[var(--ink)] px-4 py-2 text-[var(--paper)]" href="/">Sign in</Link>
        </div>
      ) : null}
      {error && error !== "Sign in required." ? <p className="alert alert-error mt-4" role="alert">{error}</p> : null}
      {!loading && tasks.length === 0 && !error ? (
        <div className="card mt-6 p-6 text-sm">
          <p>No hires are on this desk yet.</p>
          <Link className="mt-4 inline-block border border-[var(--ink)] px-4 py-2" href="/directory">Discover agents</Link>
        </div>
      ) : null}
      <TaskGroup title="Your hires" tasks={hired} />
      <TaskGroup title="Hired work" tasks={work} />
    </Shell>
  );
}
