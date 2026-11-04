"use client";

import { useSendTransaction, useSignMessage } from "@privy-io/react-auth";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { IDENTITY_CHAIN_ID, IDENTITY_REGISTRY } from "@/lib/chain/constants";
import { setAgentUriCall, setMetadataCall } from "@/lib/identity/registry";
import { AgentChat } from "@/components/agent-chat";
import { OwnerTurn } from "@/components/owner-turn";
import { McpConnections } from "@/components/mcp-connections";
import { SkillInstalls } from "@/components/skill-installs";
import { TeachAgent } from "@/components/teach-agent";
import { Shell } from "@/components/shell";
import { HintLabel } from "@/components/field-hint";
import { toast } from "@/components/toaster";

type Agent = {
  id: string;
  name: string;
  description: string;
  owner: string;
  agentWallet: string;
  skillIds: number[];
  paused: boolean;
  memoryHead: string;
  agentUri: string;
  oasfCid: string;
  identity: string;
  hirePrice: string;
  allowedActions: string[];
};

type TaskRow = { id: string; role: string; criteria: string; amountLabel: string; model: string; paymentStatus: string | null; payer: string | null; deadline?: string | null };

const dock = [
  { group: "Shape", items: [["workspace", "Workspace"], ["skills", "Skills"], ["teach", "Teach"], ["memory", "Memory"]] },
  { group: "Run", items: [["activity", "Activity"]] },
  { group: "Network", items: [["identity", "Identity"], ["settings", "Hire"]] },
] as const;
type Panel = (typeof dock)[number]["items"][number][0];

function isPanel(value: string | null): value is Panel {
  return dock.some((group) => group.items.some(([id]) => id === value));
}

function panelLabel(id: Panel): string {
  for (const group of dock) {
    const found = group.items.find(([item]) => item === id);
    if (found) return found[1];
  }
  return id;
}

function clip(value: string): string {
  if (value.length <= 18) return value || "None";
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function ToolIcon({ id }: { id: Panel }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (id === "workspace") return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h5l1.5 2H20v9.5H4z" {...common} /></svg>;
  if (id === "skills") return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8l4-4 4 4-4 4zM4 16l4-4 4 4-4 4zM12 16l4-4 4 4-4 4" {...common} /></svg>;
  if (id === "teach") return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h7.5v12H6.5A2.5 2.5 0 0 1 4 16zM20 6.5h-7.5v12h5A2.5 2.5 0 0 0 20 16z" {...common} /></svg>;
  if (id === "memory") return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10v15l-5-3-5 3z" {...common} /></svg>;
  if (id === "activity") return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2.5-6 4 12L16 12h5" {...common} /></svg>;
  if (id === "identity") return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" {...common} /><path d="M8 10h4M8 14h8" {...common} /></svg>;
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5v15M8 8.5c0-2 1.8-3.2 4-3.2s4 1.2 4 3.2-1.6 2.8-4 2.8-4 1.2-4 3.2 1.8 3.2 4 3.2 4-1.2 4-3.2" {...common} /></svg>;
}

function ToolDock({ panel, layout, onPick }: { panel: Panel | null; layout: "rail" | "bar"; onPick: (id: Panel) => void }) {
  const rail = layout === "rail";
  return (
    <nav className={rail ? "tool-rail hidden w-44 shrink-0 flex-col py-2 lg:order-1 lg:flex" : "tool-bar flex h-12 shrink-0 items-center gap-1 overflow-x-auto px-2 lg:hidden"} aria-label="Agent tools">
      {dock.map((group) => (
        <div key={group.group} className={rail ? "tool-group px-2 py-1" : "flex shrink-0 items-center"}>
          {rail ? <p className="tool-kicker">{group.group}</p> : null}
          {group.items.map(([id, label]) => {
            const selected = panel === id;
            return (
              <button
                key={id}
                className={`tool-item flex items-center gap-2 rounded-md text-left text-[13px] ${rail ? "h-8 w-full px-2" : "h-9 shrink-0 px-3"} ${selected ? "tool-on" : ""}`}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => onPick(id)}
              >
                <ToolIcon id={id} />
                {label}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export default function AgentPage() {
  const params = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [hirePrice, setHirePrice] = useState("");
  const [password, setPassword] = useState("");
  const [memory, setMemory] = useState("");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(640);
  const [seen, setSeen] = useState<Panel[]>([]);
  const { signMessage } = useSignMessage();
  const { sendTransaction } = useSendTransaction();

  function choosePanel(next: Panel | null) {
    setPanel(next);
    if (next) setSeen((current) => (current.includes(next) ? current : [...current, next]));
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("panel", next);
    else url.searchParams.delete("panel");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  function pick(id: Panel) {
    choosePanel(panel === id ? null : id);
  }

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast("ok", "Copied.");
    } catch {
      toast("error", "Could not copy that.");
    }
  }

  useEffect(() => {
    setLoading(true);
    void fetch(`/api/agents/${params.id}`)
      .then(async (response) => ({ ok: response.ok, body: await response.json() }))
      .then(({ ok, body }: { ok: boolean; body: { agent?: Agent; error?: string } }) => {
        setAgent(ok ? body.agent ?? null : null);
        if (!ok) setError(body.error ?? "Could not load this agent.");
        setLoading(false);
      })
      .catch(() => {
        setError("Could not load this agent.");
        setLoading(false);
      });
    void fetch(`/api/tasks?agentId=${encodeURIComponent(params.id)}`)
      .then((response) => response.json())
      .then((body: { tasks?: TaskRow[] }) => setTasks(body.tasks ?? []));
  }, [params.id]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("panel");
    if (!isPanel(requested)) return;
    setPanel(requested);
    setSeen((current) => (current.includes(requested) ? current : [...current, requested]));
  }, []);

  useEffect(() => {
    const stored = sessionStorage.getItem("muselancer-directory-notice");
    if (!stored) return;
    sessionStorage.removeItem("muselancer-directory-notice");
    setDirectoryNotice(stored);
  }, []);

  useEffect(() => {
    if (!agent) return;
    setHirePrice(agent.hirePrice);
  }, [agent]);

  async function publish() {
    if (!agent) return;
    setBusy("Publishing to the Directory…");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/agents/${agent.id}/directory`, { method: "POST" });
      const body = (await response.json()) as {
        error?: string;
        agent?: Agent;
        correction?: { oasfMessage: string; agentUri: string; agentWallet: string; removed?: string[] };
      };
      if (response.status === 409 && body.correction?.oasfMessage && body.correction.agentUri && body.correction.agentWallet) {
        const removed = body.correction.removed?.filter(Boolean).join(", ") || "A selected heading";
        setBusy(`${removed} is a category. Updating the registration.`);
        const signed = await signMessage(
          { message: body.correction.oasfMessage },
          { address: body.correction.agentWallet, uiOptions: { showWalletUIs: false } },
        );
        setBusy("Writing the registration file");
        const uriTx = await sendTransaction(
          { to: IDENTITY_REGISTRY, chainId: IDENTITY_CHAIN_ID, data: setAgentUriCall(BigInt(agent.id), body.correction.agentUri) },
          { address: agent.owner },
        );
        setBusy("Writing the record signature");
        const signatureTx = await sendTransaction(
          {
            to: IDENTITY_REGISTRY,
            chainId: IDENTITY_CHAIN_ID,
            data: setMetadataCall(BigInt(agent.id), "oasfSignature", signed.signature as Hex),
          },
          { address: agent.owner },
        );
        setBusy("Publishing to the Directory…");
        const again = await fetch(`/api/agents/${agent.id}/directory`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uriTxHash: uriTx.hash, signatureTxHash: signatureTx.hash, oasfSignature: signed.signature }),
        });
        const published = (await again.json()) as { error?: string; agent?: Agent };
        setBusy("");
        if (!again.ok) {
          const message = published.error ?? "Directory push failed.";
          setError(message);
          toast("error", message);
          return;
        }
        setAgent(published.agent ?? null);
        setNotice("Published to the Directory.");
        toast("ok", "Published to the Directory.");
        return;
      }
      setBusy("");
      if (!response.ok) {
        const message = body.error ?? "Directory push failed.";
        setError(message);
        toast("error", message);
        return;
      }
      setAgent(body.agent ?? null);
      setNotice("Published to the Directory.");
      toast("ok", "Published to the Directory.");
    } catch (caught) {
      setBusy("");
      const message = caught instanceof Error ? caught.message : "The wallet did not update the registration.";
      setError(message);
      toast("error", message);
    }
  }

  async function pause(paused: boolean) {
    setBusy(paused ? "Pausing the agent…" : "Resuming the agent…");
    setError("");
    setNotice("");
    const response = await fetch(`/api/agents/${params.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused }),
    });
    const body = await response.json();
    setBusy("");
    if (!response.ok) {
      const message = body.error ?? "Could not update the agent.";
      setError(message);
      toast("error", message);
      return;
    }
    setAgent(body.agent);
    const message = paused ? "Agent paused." : "Agent resumed.";
    setNotice(message);
    toast("ok", message);
  }

  async function saveTerms() {
    setBusy("Saving hire terms…");
    setError("");
    setNotice("");
    const response = await fetch(`/api/agents/${params.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hirePrice }),
    });
    const body = await response.json();
    setBusy("");
    if (!response.ok) {
      const message = body.error ?? "Could not save the hire terms.";
      setError(message);
      toast("error", message);
      return;
    }
    setAgent(body.agent);
    setNotice("Hire terms saved.");
    toast("ok", "Hire terms saved.");
  }

  async function openMemory() {
    setBusy("Opening memory…");
    setError("");
    const response = await fetch(`/api/agents/${params.id}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = await response.json();
    setBusy("");
    if (!response.ok) {
      const message = body.error ?? "Could not open memory.";
      setError(message);
      toast("error", message);
      return;
    }
    setMemory(body.memory ?? "");
    setNotice("Memory opened on this device.");
    toast("ok", "Memory opened on this device.");
  }

  return (
    <Shell fill>
      {loading ? (
        <div className="space-y-3 p-8" aria-live="polite">
          <p className="text-sm text-[var(--muted)]">Loading this agent from the identity registry…</p>
          <div className="skeleton w-1/2" />
          <div className="skeleton w-2/3" />
        </div>
      ) : null}
      {!loading && !agent ? (
        <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]">
          <header className="flex shrink-0 items-center gap-4 border-b border-[var(--line)] px-5 py-3">
            <div className="min-w-0 flex-1">
              <Link className="text-xs text-[var(--muted)]" href="/dashboard">My agents</Link>
              <h1 className="chat-title">Agent</h1>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
            <div className="card max-w-md p-6 text-center" role="alert">
              <p className="font-semibold">{error === "Sign in required." ? "Sign in to open this conversation." : (error || "This agent is not available.")}</p>
              {error === "Sign in required." ? <p className="mt-2 text-sm text-[var(--muted)]">The chat connects to XMTP after the owner wallet is signed in.</p> : null}
              {error === "Sign in required." ? <Link className="mt-4 inline-block bg-[var(--ink)] px-4 py-2 text-[var(--paper)]" href="/">Sign in</Link> : <Link className="mt-4 inline-block border border-[var(--ink)] px-4 py-2" href="/dashboard">My agents</Link>}
            </div>
          </div>
          <div className="border-t border-[var(--line)] bg-[var(--surface)] px-4 py-3">
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <input className="min-h-11 flex-1 px-3 py-2" disabled placeholder="Waiting for XMTP…" />
              <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled type="button">Send</button>
            </div>
          </div>
        </section>
      ) : null}
      {agent ? (
        <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col lg:order-3">
            <AgentChat
              agentId={agent.id}
              name={agent.name}
              description={agent.description}
              paused={agent.paused}
              onManage={() => pick("identity")}
              actions={(
                <div className="hidden items-center gap-2 sm:flex">
                  <button className="border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50" disabled={Boolean(busy)} type="button" onClick={() => void pause(!agent.paused)}>{agent.paused ? "Resume" : "Pause"}</button>
                  {agent.oasfCid ? null : <button className="border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50" disabled={Boolean(busy)} type="button" onClick={() => void publish()}>Publish</button>}
                </div>
              )}
            />
          </div>
          <section
            className={`tool-surface relative z-20 flex min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--surface)] lg:order-2 ${panel ? "absolute inset-x-0 top-0 bottom-12 lg:static lg:bottom-auto lg:border-r lg:border-[var(--line)]" : "pointer-events-none max-lg:hidden lg:border-transparent"} ${panel === "workspace" ? "lg:w-[var(--workspace-width)]" : panel ? "lg:w-[min(34vw,24rem)]" : "lg:w-0"}`}
            style={panel === "workspace" ? { ["--workspace-width" as string]: `${workspaceWidth}px` } : undefined}
            aria-hidden={panel ? undefined : true}
            inert={panel ? undefined : true}
          >
            <div className="flex shrink-0 items-end justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
              <button className="text-sm text-[var(--muted)] lg:hidden" type="button" onClick={() => choosePanel(null)}>Back to chat</button>
              <p className="text-sm font-semibold">{panel ? panelLabel(panel) : ""}</p>
              <button className="text-sm text-[var(--muted)] hover:text-[var(--ink)]" type="button" onClick={() => choosePanel(null)}>Close</button>
              {panel === "workspace" ? (
                <button
                  className="workspace-edge hidden lg:block"
                  type="button"
                  aria-label="Resize the workspace"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    const startX = event.clientX;
                    const startW = workspaceWidth;
                    const handle = event.currentTarget;
                    handle.setPointerCapture(event.pointerId);
                    const move = (ev: PointerEvent) => {
                      const max = Math.max(480, window.innerWidth - 520);
                      setWorkspaceWidth(Math.min(max, Math.max(440, startW + (ev.clientX - startX))));
                    };
                    const up = () => {
                      handle.removeEventListener("pointermove", move);
                      handle.removeEventListener("pointerup", up);
                    };
                    handle.addEventListener("pointermove", move);
                    handle.addEventListener("pointerup", up);
                  }}
                />
              ) : null}
            </div>
            <div className={panel === "workspace" ? "flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-3" : "min-h-0 flex-1 overflow-y-auto px-4 pb-6"}>
              {busy ? <p className="mt-4 text-sm text-[var(--muted)]" aria-live="polite">{busy}</p> : null}
              {notice ? <p className="alert alert-ok mt-4" role="status">{notice}</p> : null}
              {directoryNotice ? <p className="alert alert-error mt-4" role="alert">{directoryNotice}</p> : null}
              {error ? <p className="alert alert-error mt-4" role="alert">{error}</p> : null}
              {panel === "identity" ? (
                <div className="mt-4 space-y-4 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{agent.name}</p>
                      <p className="mt-1 text-[var(--muted)]">{agent.description}</p>
                    </div>
                    <span className={`shrink-0 text-xs ${agent.paused ? "text-[var(--muted)]" : "text-[var(--ok)]"}`}>{agent.paused ? "Paused" : "Active"}</span>
                  </div>
                  <dl className="sheet">
                    <div className="sheet-row flex items-center justify-between gap-3"><dt className="text-xs text-[var(--muted)]">Hire price</dt><dd className="font-semibold">{agent.hirePrice} USDC</dd></div>
                  </dl>
                  <dl className="sheet">
                    <div className="sheet-row flex items-center justify-between gap-3">
                      <div><dt className="text-xs text-[var(--muted)]">Owner wallet</dt><dd title={agent.owner}>{clip(agent.owner)}</dd></div>
                      <span className="flex gap-3"><button className="text-xs underline" type="button" onClick={() => void copyValue(agent.owner)}>Copy</button><Link className="text-xs underline" href="/profile#wallets">Wallet</Link></span>
                    </div>
                    <div className="sheet-row flex items-center justify-between gap-3">
                      <div><dt className="text-xs text-[var(--muted)]">Agent wallet</dt><dd title={agent.agentWallet}>{clip(agent.agentWallet)}</dd></div>
                      <span className="flex gap-3"><button className="text-xs underline" type="button" onClick={() => void copyValue(agent.agentWallet)}>Copy</button><Link className="text-xs underline" href="/profile#wallets">Wallet</Link></span>
                    </div>
                    <div className="sheet-row"><dt className="text-xs text-[var(--muted)]">Directory</dt><dd>{agent.oasfCid ? "Published" : "Unpublished"}</dd></div>
                  </dl>
                  <p className="text-[var(--muted)]">Tool grants are chosen when you activate a skill. Connect a plugin on Skills.</p>
                  <details className="sheet">
                    <summary className="cursor-pointer px-4 py-3 font-medium">Registry record</summary>
                    <div className="space-y-2 border-t border-[var(--line)] px-4 py-3 text-xs text-[var(--muted)]">
                      <p className="break-all">{agent.identity}</p>
                      <p className="break-all">Registration file {agent.agentUri}</p>
                      <p>OASF skills {agent.skillIds.join(", ") || "none"}</p>
                      <p>Allowed actions {agent.allowedActions.join(", ") || "none"}</p>
                    </div>
                  </details>
                  <div className="flex flex-wrap gap-2 sm:hidden">
                    <button className="border border-[var(--ink)] px-3 py-2 disabled:opacity-50" disabled={Boolean(busy)} type="button" onClick={() => void pause(!agent.paused)}>{agent.paused ? "Resume" : "Pause"}</button>
                    {agent.oasfCid ? null : <button className="border border-[var(--ink)] px-3 py-2 disabled:opacity-50" disabled={Boolean(busy)} type="button" onClick={() => void publish()}>Publish</button>}
                  </div>
                </div>
              ) : null}
              {seen.includes("workspace") ? <div className={panel === "workspace" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><OwnerTurn agentId={agent.id} onWiden={(dx) => setWorkspaceWidth((current) => Math.min(Math.max(480, window.innerWidth - 520), Math.max(440, current + dx)))} /></div> : null}
              {seen.includes("skills") ? <div hidden={panel !== "skills"}><McpConnections agentId={agent.id} /><SkillInstalls agentId={agent.id} /></div> : null}
              {seen.includes("teach") ? <div hidden={panel !== "teach"}><TeachAgent agentId={agent.id} /></div> : null}
              {panel === "memory" ? (
                <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void openMemory(); }}>
                  <p className="text-sm text-[var(--muted)]">This opens the vault on this device. Curated lines also appear in MEMORY.md after you confirm a proposal.</p>
                  <HintLabel label="Memory password" hint="The password that wraps this agent's memory vault. Opening it shows the curated lines on this device. It does not change the wallet or the registry.">
                    <input className="mt-1 w-full px-3 py-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
                  </HintLabel>
                  <button className="border border-[var(--ink)] px-4 py-2 disabled:opacity-50" disabled={Boolean(busy)} type="submit">Open memory</button>
                  {memory ? <p className="whitespace-pre-wrap text-sm">{memory}</p> : null}
                </form>
              ) : null}
              {panel === "activity" ? (
                <section className="mt-4">
                  {tasks.length === 0 ? <p className="text-sm text-[var(--muted)]">No one has hired this agent yet. A hire shows the task text, price, and model here.</p> : (
                    <ul className="sheet">
                      {tasks.map((task) => (
                        <li key={task.id} className="sheet-row text-sm">
                          <Link className="font-semibold" href={`/tasks/${task.id}`}>{task.amountLabel} USDC</Link>
                          <p className="mt-1">{task.criteria}</p>
                          {task.deadline ? <p>Deliver by {task.deadline}</p> : null}
                          <p className="mt-2 text-xs text-[var(--muted)]">{task.model} · {task.paymentStatus ?? "unlocked"} · payer {task.payer}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}
              {panel === "settings" ? (
                <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void saveTerms(); }}>
                  <p className="text-sm text-[var(--muted)]">This is the price other owners see. Each hire uses the budget that owner gives in the chat. Saving does not move USDC.</p>
                  <HintLabel label="Hire price (USDC)" hint="The posted price for this agent. The hiring owner names the budget in the chat. Saving does not move USDC.">
                    <input className="mt-1 w-full px-3 py-2" inputMode="decimal" value={hirePrice} onChange={(event) => setHirePrice(event.target.value)} />
                  </HintLabel>
                  <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={Boolean(busy)} type="submit">Save hire terms</button>
                  <p className="break-all text-xs text-[var(--muted)]">Registration file {agent.agentUri}</p>
                  <p className="break-all text-xs text-[var(--muted)]">Memory head {agent.memoryHead || "none"}</p>
                </form>
              ) : null}
            </div>
          </section>
          <ToolDock panel={panel} layout="rail" onPick={pick} />
          <ToolDock panel={panel} layout="bar" onPick={pick} />
        </div>
      ) : null}
    </Shell>
  );
}
