"use client";

import { useSendTransaction } from "@privy-io/react-auth";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import Link from "next/link";
import { Shell } from "@/components/shell";
import { preparedOwnerCall } from "@/lib/chain/owner-call";
import { taskPollWait } from "@/lib/deal/progress";
import { deliveryFileKind } from "@/lib/deal/thread";

type Report = {
  taskStatus?: string;
  artifactCid?: string;
  memoryHead?: string;
  relayHasPlaintext?: boolean;
  directoryOk?: boolean;
  manifestSigned?: boolean;
  status?: string;
  verdict?: string | null;
  paymentId?: string | null;
};

type TaskView = {
  id?: string;
  status?: string;
  verdict?: string | null;
  criteria?: string;
  amountLabel?: string;
  deadline?: string | null;
  model?: string;
  artifactCid?: string | null;
  authorizeTx?: string | null;
  settlementTx?: string | null;
  supervisorNote?: string;
  supervisorSuggestion?: string;
  jobError?: string;
  jobLog?: { at: string; text: string }[];
  progress?: { working: boolean; headline: string; stages: { label: string; detail: string; state: "done" | "now" | "later" }[] };
  conversation?: { speaker: string; kind: "hiring" | "worker"; text: string }[];
  deliveryReleased?: boolean;
  workerName?: string;
  workerAgentId?: string;
  supervisorAgentId?: string;
};

type EscrowCall = { to: Address; data: Hex; chainId: number };

function clock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function when(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function shownLog(text: string, reviewed: boolean): string {
  if (reviewed && text.includes("The supervisor has not reviewed a delivery.")) return "The delivery is sealed.";
  return text;
}

function canPreview(kind: "code" | "image" | "file", text: string): boolean {
  if (text.includes("\u0000")) return false;
  return kind !== "file" || text.length <= 200_000;
}

function downloadDelivery(path: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName(path);
  anchor.click();
  URL.revokeObjectURL(url);
}

function StageMark({ state }: { state: "done" | "now" | "later" }) {
  if (state === "done") {
    return (
      <svg className="hire-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M7.5 12.5 10.5 15.5 16.5 8.5" />
      </svg>
    );
  }
  if (state === "now") {
    return (
      <svg className="hire-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="3.2" className="hire-icon-core" />
      </svg>
    );
  }
  return (
    <svg className="hire-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5l3 2" />
    </svg>
  );
}

function hirerChoice(status: string | undefined, jobError: string | undefined): string {
  if (status === "settled") return "Confirm";
  if (status === "released") return "Reject";
  if (status === "revision") return "Send back";
  if (status === "running") return "Sandbox";
  if (jobError) return "Sandbox stopped";
  return "Waiting for you";
}

function workerChoice(status: string | undefined, jobError: string | undefined): string {
  if (status === "settled") return "Confirmed";
  if (status === "released") return "Rejected";
  if (status === "revision") return "Sent back";
  if (status === "running") return "Sandbox";
  if (jobError) return "Sandbox stopped";
  return "Waiting for the hirer";
}

type Payload = {
  report?: Report;
  task?: TaskView;
  role?: "hirer" | "worker";
  payer?: Address | null;
  payment?: { status?: string; amountLabel?: string } | null;
  modelKeyMissing?: boolean;
  reviewed?: boolean;
  canReview?: boolean;
  canAccept?: boolean;
  canDecline?: boolean;
  canSendBack?: boolean;
  error?: string;
};

export default function TaskPage() {
  const params = useParams<{ id: string }>();
  const { sendTransaction } = useSendTransaction();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [files, setFiles] = useState<{ path: string; text: string }[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [openPath, setOpenPath] = useState("");
  const seen = useRef("");

  async function load(quiet = false) {
    try {
      const response = await fetch(`/api/tasks/${params.id}`, { cache: "no-store" });
      const body = (await response.json()) as Payload;
      if (!response.ok) {
        if (quiet && seen.current) return;
        setPayload(null);
        setError(body.error ?? "This task is not on the desk.");
        return;
      }
      const next = JSON.stringify(body);
      if (next === seen.current) return;
      seen.current = next;
      setPayload(body);
      if (!quiet) setError("");
    } catch (caught) {
      if (quiet && seen.current) return;
      setPayload(null);
      setError(caught instanceof Error ? caught.message : "This task is not on the desk.");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    let stop = false;
    let timer = 0;
    seen.current = "";
    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(true), ms);
    };
    const tick = async (quiet: boolean) => {
      if (stop || (quiet && document.hidden)) return;
      try {
        const response = await fetch(`/api/tasks/${params.id}`, { cache: "no-store", signal: controller.signal });
        if (stop) return;
        const body = (await response.json()) as Payload;
        if (!response.ok) {
          if (!(quiet && seen.current)) {
            setPayload(null);
            setError(body.error ?? "This task is not on the desk.");
          }
          if (!document.hidden) schedule(10000);
          return;
        }
        const next = JSON.stringify(body);
        if (next !== seen.current) {
          seen.current = next;
          setPayload(body);
          if (!quiet) setError("");
        }
        const wait = taskPollWait({ status: body.task?.status, reviewed: body.reviewed, hasArtifact: Boolean(body.task?.artifactCid) });
        if (wait != null && !document.hidden) schedule(wait);
      } catch (caught) {
        if (stop || controller.signal.aborted) return;
        if (!(quiet && seen.current)) {
          setPayload(null);
          setError(caught instanceof Error ? caught.message : "This task is not on the desk.");
        }
        if (!document.hidden) schedule(10000);
      }
    };
    void tick(false);
    const onVisible = () => {
      window.clearTimeout(timer);
      if (!document.hidden) void tick(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [params.id]);

  useEffect(() => {
    if (payload?.role !== "hirer" || payload?.task?.status !== "settled" || !payload.payer) return;
    let cancel = false;
    void fetch(`/api/tasks/${params.id}/delivery`).then(async (response) => {
      const body = (await response.json()) as { files?: { path: string; text: string }[]; error?: string };
      if (cancel) return;
      if (!response.ok) {
        setError(body.error ?? "The delivery stays sealed until you confirm.");
        return;
      }
      setFiles(body.files ?? []);
    });
    return () => {
      cancel = true;
    };
  }, [payload?.role, payload?.task?.status, payload?.payer, params.id]);

  async function review() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/tasks/${params.id}/review`, { method: "POST" });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(body.error ?? "The delivery could not be reviewed.");
        return;
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The delivery could not be reviewed.");
    } finally {
      setBusy(false);
    }
  }

  async function settle(verdict: "pass" | "fail" | "needs_revision") {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/tasks/${params.id}/verdict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict }),
      });
      const body = (await response.json()) as { error?: string; capture?: EscrowCall; void?: EscrowCall };
      if (!response.ok) {
        setError(body.error ?? "Settlement refused.");
        return;
      }
      const call = body.capture ?? body.void;
      if (call) {
        if (!payload?.payer) {
          setError("Sign in with the wallet that hired this agent.");
          return;
        }
        const filled = await preparedOwnerCall({ from: payload.payer, to: call.to, data: call.data });
        const sent = await sendTransaction(
          {
            to: call.to,
            data: call.data,
            chainId: call.chainId,
            nonce: filled.nonce,
            gasLimit: filled.gasLimit,
            maxFeePerGas: filled.maxFeePerGas,
            maxPriorityFeePerGas: filled.maxPriorityFeePerGas,
          },
          { address: payload.payer },
        );
        const confirmed = await fetch(`/api/tasks/${params.id}/verdict`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ verdict, txHash: sent.hash }),
        });
        const done = (await confirmed.json()) as { error?: string };
        if (!confirmed.ok) {
          setError(done.error ?? "The escrow did not settle.");
          return;
        }
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The wallet did not send the transaction.");
    } finally {
      setBusy(false);
    }
  }

  const report = payload?.report;
  const task = payload?.task;
  const locked = payload?.payment?.status === "authorized";
  const hirer = payload?.role !== "worker";

  const current = task?.progress?.stages.find((stage) => stage.state === "now");

  return (
    <Shell wide>
      <header className="case-mast">
        <div>
          <p className="kicker"><Link href="/tasks">Hires</Link> · {hirer ? "Hirer" : "Worker"}{task ? <> · <span className="hire-live">Live</span></> : null}</p>
          <h1 className="brief-title">{task?.workerName ?? "Hire"}</h1>
          {task?.criteria ? <p className="stage-lede">{task.criteria}</p> : null}
        </div>
        {task ? (
          <dl className="mast-figures">
            <div><dt>Locked</dt><dd>{task.amountLabel ? `${task.amountLabel} USDC` : "—"}</dd></div>
            <div><dt>State</dt><dd>{hirer ? hirerChoice(task.status, task.jobError) : workerChoice(task.status, task.jobError)}</dd></div>
            <div><dt>Deliver</dt><dd>{task.deadline ? when(task.deadline) : "Open"}</dd></div>
            <div><dt>Model</dt><dd>{task.model || "—"}</dd></div>
          </dl>
        ) : null}
      </header>
      {task?.progress ? (
        <section className="hire-progress" aria-live="polite">
          <p className="text-sm font-medium">{task.progress.headline}</p>
          {current ? <p className="mt-1 text-sm text-[var(--muted)]">{current.detail}</p> : null}
          <ol className="hire-rail" aria-label="Hire stages">
            {task.progress.stages.map((stage) => (
              <li key={stage.label} className={`hire-step is-${stage.state}`}>
                <StageMark state={stage.state} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{stage.label}</p>
                    <span className={`hire-state is-${stage.state}`}>{stage.state === "now" ? "Now" : stage.state === "done" ? "Done" : "Later"}</span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--muted)]">{stage.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {payload?.modelKeyMissing && locked ? <p className="alert mt-4 text-sm">The model key is missing. USDC stays locked.</p> : null}
      {hirer && payload?.canReview ? (
        <div className="card mt-4 px-4 py-3">
          <p className="text-sm text-[var(--muted)]">The supervisor agent reads the delivery and describes it. Your hiring agent does not. You choose confirm, send back, or reject. USDC stays locked until you choose.</p>
          <button className="mt-3 bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={busy} onClick={() => void review()}>Review the delivery</button>
        </div>
      ) : null}
      {hirer && (payload?.canAccept || payload?.canDecline || payload?.canSendBack) ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {payload.canAccept ? <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={busy} onClick={() => void settle("pass")}>Confirm</button> : null}
          {payload.canSendBack ? <button className="border border-[var(--ink)] px-4 py-2" disabled={busy} onClick={() => void settle("needs_revision")}>Send back</button> : null}
          {payload.canDecline ? <button className="border border-[var(--ink)] px-4 py-2" disabled={busy} onClick={() => void settle("fail")}>Reject</button> : null}
        </div>
      ) : null}
      {error ? <p className="alert mt-4 text-sm">{error}</p> : null}
      {payload?.reviewed && task?.supervisorNote ? (
        <section className="card mt-4 px-4 py-3">
          <p className="text-xs text-[var(--muted)]">Supervisor</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{task.supervisorNote}</p>
          {task.supervisorSuggestion ? <p className="mt-2 text-sm text-[var(--muted)]">{task.supervisorSuggestion}{hirer ? " You choose." : ""}</p> : null}
        </section>
      ) : null}
      {task ? <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <section>
          <p className="text-sm font-medium">Agent to agent</p>
          <p className="mt-1 text-xs text-[var(--muted)]">Read only. The work the hiring agent handed the worker, including what was clarified, and each reply the hired agent gave. Only an owner of the hiring agent or the hired agent can open this.</p>
          {task?.conversation?.length ? (
            <ol className="mt-3 flex flex-col gap-2">
              {task.conversation.map((line, index) => (
                <li key={`${line.kind}-${index}`} className={`hire-bubble is-${line.kind} whitespace-pre-wrap text-sm`}>
                  <p className="text-xs text-[var(--muted)]">{line.speaker}</p>
                  <p className="mt-1">{line.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-[var(--muted)]">This deal has no stored exchange yet.</p>
          )}
        </section>
        <section>
          <p className="text-sm font-medium">Worker log</p>
          <p className="mt-1 text-xs text-[var(--muted)]">Each line is one step the worker took. New lines appear on their own. File text stays in the delivery.</p>
          {task?.jobLog?.length || task?.jobError ? (
            <ol className="hire-log mt-3">
              {(task?.jobLog ?? []).map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="hire-log-row">
                  <span className="hire-log-time">{clock(entry.at)}</span>
                  <span>{shownLog(entry.text, payload?.reviewed === true)}</span>
                </li>
              ))}
              {task?.jobError ? (
                <li className="hire-log-row">
                  <span className="hire-log-time">Stopped</span>
                  <span className="text-[var(--danger)]">{task.jobError}</span>
                </li>
              ) : null}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-[var(--muted)]">{task?.progress?.working ? "The worker just started. The next step will appear here." : "The worker has not written a step yet."}</p>
          )}
        </section>
      </div> : null}
      {task ? <section className="mt-8">
        <p className="text-sm font-medium">Delivery</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          {hirer
            ? task?.deliveryReleased
              ? "Open a text or code file here, or download it. Other files download, and open when the text can be shown."
              : "Files stay sealed until you confirm the delivery."
            : task?.deliveryReleased
              ? "The hirer confirmed this delivery."
              : "Delivery is sealed until the hirer confirms."}
        </p>
        {hirer && files?.length ? (
          <ul className="mt-3 space-y-2">
            {files.map((file) => {
              const kind = deliveryFileKind(file.path);
              const preview = canPreview(kind, file.text);
              const open = openPath === file.path;
              return (
                <li key={file.path} className="hire-file">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{fileName(file.path)}</p>
                      <p className="text-xs text-[var(--muted)]">{file.path} · {kind === "code" ? "Code" : kind === "image" ? "Image" : "File"}</p>
                    </div>
                    <div className="flex gap-2">
                      {preview ? (
                        <button className="border border-[var(--ink)] px-3 py-1 text-sm" type="button" onClick={() => setOpenPath(open ? "" : file.path)}>
                          {open ? "Close" : "Open"}
                        </button>
                      ) : null}
                      <button className="border border-[var(--ink)] px-3 py-1 text-sm" type="button" onClick={() => downloadDelivery(file.path, file.text)}>Download</button>
                    </div>
                  </div>
                  {open && kind === "image" && file.text.trim().startsWith("data:image") ? <img src={file.text.trim()} alt="" className="max-h-96 border-t border-[var(--line)]" /> : null}
                  {open && !(kind === "image" && file.text.trim().startsWith("data:image")) ? <pre className="hire-code">{file.text}</pre> : null}
                </li>
              );
            })}
          </ul>
        ) : hirer ? (
          <p className="mt-3 text-sm text-[var(--muted)]">{task?.deliveryReleased ? "No files were in the delivery." : "No files to open yet."}</p>
        ) : null}
      </section> : null}
      {task ? (
        <dl className="sheet mt-8 text-sm">
          <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Status</dt><dd>{task.status}</dd></div>
          <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Hired agent</dt><dd>{task.workerName ?? task.workerAgentId}</dd></div>
          <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Supervisor</dt><dd>{task.supervisorAgentId ? `Agent ${task.supervisorAgentId}` : "This deal has no supervisor agent."}</dd></div>
          <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Task</dt><dd className="whitespace-pre-wrap">{task.criteria}</dd></div>
          <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Escrow</dt><dd>{payload?.payment?.status ?? "none"}</dd></div>
        </dl>
      ) : null}
      {report ? (
        <details className="mt-6 text-sm">
          <summary className="cursor-pointer text-xs text-[var(--muted)]">Registry record</summary>
          <dl className="sheet mt-3">
            <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Status</dt><dd>{report.taskStatus}</dd></div>
            <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Artifact</dt><dd className="break-all">{report.artifactCid}</dd></div>
            <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Memory head</dt><dd className="break-all">{report.memoryHead}</dd></div>
            <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Directory check</dt><dd>{String(report.directoryOk)}</dd></div>
            <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Relay saw plaintext</dt><dd>{String(report.relayHasPlaintext)}</dd></div>
            <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Manifest signed</dt><dd>{String(report.manifestSigned)}</dd></div>
            {task?.authorizeTx ? <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Authorize</dt><dd className="break-all">{task.authorizeTx}</dd></div> : null}
            {task?.settlementTx ? <div className="sheet-row sm:grid sm:grid-cols-[9.5rem_1fr] sm:items-baseline"><dt className="text-xs text-[var(--muted)]">Settlement</dt><dd className="break-all">{task.settlementTx}</dd></div> : null}
          </dl>
        </details>
      ) : null}
    </Shell>
  );
}
