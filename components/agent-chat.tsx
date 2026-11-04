"use client";

import { useSignMessage } from "@privy-io/react-auth";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { hexToBytes, type Hex } from "viem";
import { DealLockButton } from "@/components/deal-lock";
import { OwnerAskBar } from "@/components/owner-ask";
import { ThinkMark } from "@/components/think-mark";
import { WebAccess } from "@/components/web-access";
import { ownerAskId, type OwnerAsk } from "@/lib/chat/ask";
import { appendChatTurn, mergeChatRows } from "@/lib/chat/rows";
import { controlIdentity, ownerControls } from "@/lib/deal/actions";
import type { Address } from "viem";
import { attachmentKind, attachmentName, MAX_ATTACHMENTS } from "@/lib/gateway/attachment-kind";
import { scanUntrusted } from "@/lib/gateway/firewall";
import { encodeWav } from "@/lib/gateway/wav";
import {
  bindSigner,
  cachedSession,
  connectionError,
  dropChat,
  hubRole,
  loadChat,
  onHubRole,
  onHubRows,
  openChat,
  publishTurn,
  refreshChat,
  startHub,
  type ChatIntro,
  type ChatRow,
} from "@/components/xmtp-hub";

type Row = ChatRow;
type DraftAttachment =
  | { id: string; kind: "text"; name: string; text: string }
  | { id: string; kind: "image"; name: string; dataUrl: string }
  | { id: string; kind: "voice"; name: string; url: string; base64: string };

let draftSeq = 0;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function MessageBody({ text, onDark, agentId }: { text: string; onDark: boolean; agentId: string }) {
  const pieces = text.split(/(\[\[image:[a-f0-9]+\]\])/);
  return (
    <div className="space-y-2">
      {pieces.map((piece, index) => {
        const image = /^\[\[image:([a-f0-9]+)\]\]$/.exec(piece);
        if (image) {
          return <img key={index} src={`/api/agents/${agentId}/media/${image[1]}`} alt="Attached image" className="max-h-64 max-w-full rounded-md" />;
        }
        return piece.trim() ? <MessageText key={index} text={piece} onDark={onDark} /> : null;
      })}
    </div>
  );
}
const startupSent = new Set<string>();
const quietSign = { uiOptions: { showWalletUIs: false } };

function MessageText({ text, onDark }: { text: string; onDark: boolean }) {
  const chunks = text.split("```");
  return (
    <div className="space-y-2">
      {chunks.map((chunk, index) => {
        if (index % 2 === 0) return chunk ? <p key={index} className="whitespace-pre-wrap">{chunk}</p> : null;
        const breakAt = chunk.indexOf("\n");
        const code = (breakAt === -1 ? chunk : chunk.slice(breakAt + 1)).replace(/\n$/, "");
        return (
          <pre key={index} className={`overflow-auto rounded-lg p-3 text-xs ${onDark ? "bg-white/10" : "bg-[var(--bg)]"}`}>
            <code>{code}</code>
          </pre>
        );
      })}
    </div>
  );
}

type ChatReplyBody = { text?: string; ownerText?: string; ask?: OwnerAsk | null; error?: string };

async function readChatReply(response: Response, onPhase: (phase: string) => void): Promise<ChatReplyBody | null> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("ndjson")) return (await response.json().catch(() => null)) as ChatReplyBody | null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: ChatReplyBody | null = null;
  const take = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as ChatReplyBody & { phase?: string };
    if (event.phase) onPhase(event.phase);
    if (event.text || event.error) final = event;
  };
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) take(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) take(buffer);
  return final;
}

function savedRows(turns: { role?: string; text?: string }[]): Row[] {
  return turns.flatMap((turn, index) => {
    if ((turn.role !== "owner" && turn.role !== "agent") || typeof turn.text !== "string" || !turn.text.trim()) return [];
    return [{ id: `saved-${index}-${turn.role}`, role: turn.role, text: turn.text }];
  });
}

function initialOf(name: string): string {
  const letter = name.trim().slice(0, 1).toUpperCase();
  return letter || "A";
}

export function AgentChat({
  agentId,
  name,
  description,
  paused,
  onManage,
  actions,
}: {
  agentId: string;
  name: string;
  description: string;
  paused: boolean;
  onManage: () => void;
  actions?: ReactNode;
}) {
  const { signMessage } = useSignMessage();
  const signRef = useRef(signMessage);
  signRef.current = signMessage;
  const introRef = useRef<ChatIntro | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [error, setError] = useState("");
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [phase, setPhase] = useState("Thinking");
  const [ask, setAsk] = useState<OwnerAsk | null>(null);
  const [pendingOwner, setPendingOwner] = useState("");
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [pendingAgent, setPendingAgent] = useState("");
  const [status, setStatus] = useState("Opening the conversation");
  const [ready, setReady] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [hire, setHire] = useState<{
    stage: string;
    taskId?: string | null;
    pendingAsk: { question: string } | null;
    pendingCounter: { priceLabel: string } | null;
    current: { name: string } | null;
    selectedAgentId: string | null;
    budgetLabel: string | null;
    deadline: string | null;
    needsWindow: boolean;
    payer: string;
  } | null>(null);
  const [budgetField, setBudgetField] = useState("");
  const [dayField, setDayField] = useState("");
  const [retiredControl, setRetiredControl] = useState("");
  const [lockBusy, setLockBusy] = useState(false);
  const retiredAsk = useRef("");
  const askEpoch = useRef(0);

  function loadHire() {
    void fetch(`/api/agents/${agentId}/deal`)
      .then((response) => response.json())
      .then((body: { deal?: typeof hire }) => setHire(body.deal ?? null))
      .catch(() => undefined);
  }

  function signer(address: string) {
    return {
      identity: async () => ({ identifier: address, kind: "ethereum" as const }),
      kind: async () => ({ kind: "eoa" as const }),
      sign: async (request: { text: string }) => {
        const signed = await signRef.current({ message: request.text }, { address, ...quietSign });
        return { kind: "ecdsa" as const, value: hexToBytes(signed.signature as Hex) };
      },
    };
  }
  bindSigner(signer);

  useEffect(() => {
    let cancelled = false;
    const stopRows = onHubRows((id, next) => {
      if (!cancelled && id === agentId) setRows((current) => mergeChatRows(current, next));
    });
    const stopRole = onHubRole((next) => {
      if (next === "leader") setConnectionEpoch((epoch) => epoch + 1);
    });
    void (async () => {
      try {
        await startHub();
        if (cancelled) return;
        const epoch = askEpoch.current;
        const introBody = await fetch(`/api/agents/${agentId}/chat`).then((response) => response.json()) as { backendUrl?: string; ownerAddress?: string; agentWallet?: string; transcript?: { role?: string; text?: string }[]; ask?: OwnerAsk | null; error?: string };
        if (!cancelled && epoch === askEpoch.current) {
          const stored = introBody.ask ?? null;
          setAsk(stored && ownerAskId(stored) === retiredAsk.current ? null : stored);
        }
        if (cancelled) return;
        const saved = savedRows(Array.isArray(introBody.transcript) ? introBody.transcript : []);
        if (saved.length > 0) setRows((current) => mergeChatRows(current, saved));
        loadHire();
        if (!introBody.backendUrl || !introBody.ownerAddress || !introBody.agentWallet) {
          throw new Error(introBody.error ?? "Set XMTP_BACKEND_URL.");
        }
        const intro: ChatIntro = {
          backendUrl: String(introBody.backendUrl),
          ownerAddress: String(introBody.ownerAddress),
          agentWallet: String(introBody.agentWallet),
        };
        introRef.current = intro;
        if (hubRole() === "leader") {
          const known = cachedSession(agentId);
          const sameWallet = Boolean(known && known.ownerAddress.toLowerCase() === intro.ownerAddress.toLowerCase() && known.agentWallet.toLowerCase() === intro.agentWallet.toLowerCase());
          if (known && !sameWallet) dropChat(agentId);
          if (known && sameWallet) {
            setError("");
            setStatus("");
            setRows((current) => mergeChatRows(current, known.rows));
            setReady(true);
            const next = await refreshChat(agentId).catch(() => null);
            if (!cancelled && next) setRows((current) => mergeChatRows(current, next));
            return;
          }
          setReady(false);
          setError("");
          setStatus("Opening the conversation");
          const session = await openChat(agentId, intro, (line) => {
            if (!cancelled) setStatus(line);
          });
          if (cancelled) return;
          setRows((current) => mergeChatRows(current, session.rows));
          setStatus("");
          setReady(true);
          return;
        }
        setReady(false);
        setError("");
        setStatus("Opening the conversation");
        const next = await loadChat(agentId, intro, (line) => {
          if (!cancelled) setStatus(line);
        });
        if (cancelled) return;
        setRows((current) => mergeChatRows(current, next));
        setStatus("");
        setReady(true);
      } catch (cause) {
        if (!cancelled) {
          setError(connectionError(cause));
          setStatus("");
          setReady(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      stopRows();
      stopRole();
    };
    // The signer is read from a ref. The effect follows the agent id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, connectionEpoch]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [rows, pendingOwner, pendingAgent, awaitingReply, ready]);

  function removeDraft(id: string) {
    setDrafts((current) => {
      const found = current.find((item) => item.id === id);
      if (found?.kind === "voice") URL.revokeObjectURL(found.url);
      return current.filter((item) => item.id !== id);
    });
  }

  function clearDrafts() {
    setDrafts((current) => {
      for (const item of current) {
        if (item.kind === "voice") URL.revokeObjectURL(item.url);
      }
      return [];
    });
  }

  async function takeFiles(list: FileList | null) {
    const files = list ? [...list] : [];
    if (files.length === 0) return;
    setUploadError("");
    const next: DraftAttachment[] = [];
    let skipped = "";
    for (const file of files) {
      const name = attachmentName(file.name);
      const kind = attachmentKind(name);
      if (!kind) {
        skipped = "Attach a .md, .txt, .csv, image, or voice file.";
        continue;
      }
      const id = `file-${draftSeq += 1}`;
      if (kind === "text") {
        const contents = await file.text().catch(() => "");
        if (!contents.trim()) {
          skipped = "That file is empty.";
          continue;
        }
        if (contents.length > 64_000) {
          skipped = "That file is too large.";
          continue;
        }
        const scan = scanUntrusted(contents);
        if (!scan.allow) {
          skipped = scan.reason;
          continue;
        }
        next.push({ id, kind, name, text: contents });
      } else if (kind === "image") {
        if (file.size > 3_500_000) {
          skipped = "That image is too large.";
          continue;
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ""));
          reader.onerror = () => reject(new Error("Could not read that image."));
          reader.readAsDataURL(file);
        }).catch(() => "");
        if (!dataUrl.startsWith("data:image/")) {
          skipped = "Could not read that image.";
          continue;
        }
        next.push({ id, kind, name, dataUrl });
      } else {
        try {
          const context = new AudioContext();
          const decoded = await context.decodeAudioData(await file.arrayBuffer());
          const wav = encodeWav(decoded.getChannelData(0), decoded.sampleRate);
          await context.close();
          if (wav.length > 2_500_000) {
            skipped = "That voice file is too large.";
            continue;
          }
          const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
          next.push({ id, kind, name, url, base64: bytesToBase64(wav) });
        } catch {
          skipped = "This browser could not read that voice file.";
        }
      }
    }
    setDrafts((current) => {
      const room = MAX_ATTACHMENTS - current.length;
      if (room <= 0 || next.length > room) skipped = "Attach up to 8 files.";
      return [...current, ...next.slice(0, Math.max(0, room))];
    });
    if (skipped) setUploadError(skipped);
  }

  async function send(override?: string, source?: "hire") {
    setError("");
    const intro = introRef.current;
    if (!intro || !ready) {
      setError(status || "XMTP is not connected.");
      return;
    }
    const typed = (override ?? text).trim();
    if (!typed && drafts.length === 0) return;
    if (typed) {
      const scan = scanUntrusted(typed);
      if (!scan.allow) {
        setError(scan.reason);
        return;
      }
    }
    const snapshot = drafts;
    const attachments = snapshot.map((item) => item.kind === "text"
      ? { kind: "text" as const, name: item.name, text: item.text }
      : item.kind === "image"
        ? { kind: "image" as const, name: item.name, dataUrl: item.dataUrl }
        : { kind: "voice" as const, name: item.name, wavBase64: item.base64 });
    const shown = [typed, ...snapshot.map((item) => item.kind === "text" ? `# ${item.name}\n${item.text}` : item.name)].filter(Boolean).join("\n\n") || "Attached files.";
    if (!override) setText("");
    setDrafts([]);
    setPendingOwner(shown);
    setPendingImages(snapshot.flatMap((item) => item.kind === "image" ? [item.dataUrl] : []));
    setPendingAgent("");
    const previousAsk = ask;
    const previousControl = retiredControl;
    askEpoch.current += 1;
    if (ask) retiredAsk.current = ownerAskId(ask);
    const liveControls = ownerControls(hire);
    const answeredHire = source === "hire" || Boolean(liveControls?.choices.some((choice) => choice.message.toLowerCase() === typed.toLowerCase()));
    if (answeredHire) setRetiredControl(controlIdentity(hire));
    setAsk(null);
    setPhase("Thinking");
    setAwaitingReply(true);
    let replyText = "";
    try {
      const response = await fetch(`/api/agents/${agentId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: typed,
          startup: !startupSent.has(agentId),
          history: rows.slice(-16).map((row) => ({ role: row.role, text: row.text })),
          attachments,
        }),
      });
      const body = await readChatReply(response, setPhase);
      if (!response.ok || !body?.text) {
        setAwaitingReply(false);
        setPendingOwner("");
        setPendingImages([]);
        setPendingAgent("");
        retiredAsk.current = "";
        setRetiredControl(previousControl);
        setAsk(previousAsk);
        setText(typed);
        setDrafts(snapshot);
        setError(body?.error ?? "The model returned no reply.");
        return;
      }
      replyText = body.text;
      const nextAsk = body.ask ?? null;
      setAsk(nextAsk && ownerAskId(nextAsk) === retiredAsk.current ? null : nextAsk);
      retiredAsk.current = "";
      if (source === "hire") {
        setBudgetField("");
        setDayField("");
      }
      setAwaitingReply(false);
      setPendingAgent(body.text);
      const ownerText = body.ownerText?.trim() || shown;
      const next = await publishTurn(agentId, intro, ownerText, replyText);
      startupSent.add(agentId);
      for (const item of snapshot) {
        if (item.kind === "voice") URL.revokeObjectURL(item.url);
      }
      const stamp = Date.now();
      setRows((current) => appendChatTurn(mergeChatRows(current, next), { id: `local-owner-${stamp}`, role: "owner", text: ownerText }, { id: `local-agent-${stamp}`, role: "agent", text: replyText }));
      setPendingOwner("");
      setPendingImages([]);
      setPendingAgent("");
      loadHire();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send.");
      setAwaitingReply(false);
      if (!replyText) {
        retiredAsk.current = "";
        setRetiredControl(previousControl);
        setAsk(previousAsk);
        setPendingOwner("");
        setPendingImages([]);
        setPendingAgent("");
        setText(typed);
        setDrafts(snapshot);
      }
    }
  }

  const initial = initialOf(name);
  const presence = !ready ? (status || "Not connected") : paused ? "Paused · Connected" : "Active · Connected";

  const canSend = ready && !awaitingReply && (text.trim().length > 0 || drafts.length > 0);
  const controls = ownerControls(hire);
  const controlKey = controlIdentity(hire);
  const showControls = Boolean(controls) && !awaitingReply && controlKey !== retiredControl;

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--bg)] px-4">
        <Link className="shrink-0 text-xs text-[var(--muted)] lg:hidden" href="/dashboard">Agents</Link>
        <span className="agent-mark" aria-hidden="true">{initial}</span>
        <h1 className="chat-title min-w-0 flex-1 truncate">{name}</h1>
        <p className="max-w-[9rem] shrink-0 truncate text-xs text-[var(--muted)] sm:max-w-none" aria-live="polite">{presence}</p>
        {actions}
        <button className="shrink-0 border border-[var(--ink)] px-3 py-2 text-sm lg:hidden" type="button" onClick={onManage}>Manage</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3">
          {!ready && !error && rows.length === 0 ? (
            <div className="flex flex-1 flex-col justify-end py-8" aria-live="polite">
              <p className="chat-empty">{name}</p>
              <p className="mt-2 max-w-sm text-sm text-[var(--muted)]">{status.startsWith("Registering") ? "This browser registers on XMTP once. The next visit opens the saved connection." : "Opening the saved XMTP connection."}</p>
            </div>
          ) : null}
          {error && rows.length === 0 && !ready ? (
            <div className="card mx-auto my-6 max-w-md p-6 text-center" role="alert">
              <p className="font-semibold">The conversation did not open.</p>
              <p className="mt-2 text-sm text-[var(--danger)]">{error}</p>
              {error === "Sign in required." ? <Link className="mt-4 inline-block bg-[var(--ink)] px-4 py-2 text-[var(--paper)]" href="/">Sign in</Link> : <p className="mt-3 text-sm text-[var(--muted)]">Reload this agent to try the connection again.</p>}
            </div>
          ) : null}
          {rows.length > 0 || pendingOwner || awaitingReply ? <div className="min-h-0 flex-1" /> : null}
          {ready && rows.length === 0 && !pendingOwner && !awaitingReply ? (
            <div className="flex flex-1 flex-col justify-end pb-6">
              <p className="chat-empty">{name}</p>
              {description ? <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--muted)]">{description}</p> : null}
              <p className="mt-6 text-sm">Send the first message.</p>
            </div>
          ) : null}
          {rows.map((message) => {
            const mine = message.role === "owner";
            return (
              <article key={message.id} className={`flex max-w-[min(40rem,92%)] flex-col gap-1 ${mine ? "ml-auto items-end" : "mr-auto items-start"}`}>
                <div className="flex items-center gap-2 px-1 text-xs text-[var(--muted)]">
                  <span>{mine ? "You" : name}</span>
                  <button
                    className="underline"
                    type="button"
                    aria-label={mine ? "Copy your message" : "Copy the agent message"}
                    onClick={() => {
                      void navigator.clipboard.writeText(message.text).catch(() => setError("Could not copy that message."));
                    }}
                  >
                    Copy
                  </button>
                </div>
                <div className={`px-3.5 py-2.5 text-sm leading-relaxed ${mine ? "bubble-mine" : "bubble-agent border border-[var(--line)] bg-[var(--surface)]"}`}>
                  <MessageBody text={message.text} onDark={mine} agentId={agentId} />
                </div>
              </article>
            );
          })}
          {pendingOwner ? (
            <article className="ml-auto flex max-w-[min(40rem,92%)] flex-col items-end gap-1">
              <div className="px-1 text-xs text-[var(--muted)]">You</div>
              <div className="bubble-mine rounded-lg px-3 py-2 text-sm">
                <MessageBody text={pendingOwner} onDark agentId={agentId} />
                {pendingImages.map((src) => <img key={src.slice(0, 48)} src={src} alt="" className="mt-2 max-h-64 max-w-full rounded-md" />)}
              </div>
            </article>
          ) : null}
          {awaitingReply ? (
            <article className="mr-auto flex max-w-md flex-col gap-1" aria-live="polite">
              <span className="px-1 text-xs text-[var(--muted)]">{name}</span>
              <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2">
                <ThinkMark phase={phase} />
              </div>
            </article>
          ) : null}
          {pendingAgent ? (
            <article className="mr-auto flex max-w-[min(40rem,92%)] flex-col items-start gap-1">
              <div className="px-1 text-xs text-[var(--muted)]">{name}</div>
              <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm">
                <MessageBody text={pendingAgent} onDark={false} agentId={agentId} />
              </div>
            </article>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      <form
        className="composer shrink-0 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) void send();
        }}
      >
        <div className="mx-auto w-full max-w-3xl">
          {hire?.stage === "locked" && hire.taskId ? (
            <p className="mb-3 text-sm">
              <Link href={`/tasks/${hire.taskId}`}>Follow the worker, the agent exchange, and the log</Link>
            </p>
          ) : null}
          {ask && !awaitingReply ? <OwnerAskBar key={`${ask.prompt}|${ask.inputLabel}|${ask.choices.join("|")}`} ask={ask} disabled={!ready} onSend={(message) => void send(message)} /> : null}
          {controls && (showControls || lockBusy) ? (
            <div className={showControls ? "mb-3 space-y-2" : "sr-only"}>
              {showControls ? <p className="text-sm">{controls.note}</p> : null}
              {showControls && controls.form ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-xs text-[var(--muted)]">
                    Budget in USDC
                    <input className="mt-1 w-28 px-3 py-2 text-sm" inputMode="decimal" value={budgetField} onChange={(event) => setBudgetField(event.target.value)} />
                  </label>
                  <label className="text-xs text-[var(--muted)]">
                    Delivery day
                    <input className="mt-1 px-3 py-2 text-sm" type="date" value={dayField} onChange={(event) => setDayField(event.target.value)} />
                  </label>
                  <button
                    className="border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50"
                    disabled={!ready || (!budgetField.trim() && !dayField)}
                    type="button"
                    onClick={() => {
                      const parts = [
                        budgetField.trim() ? `My budget is ${budgetField.trim()} USDC` : "",
                        dayField ? `Delivery day ${dayField}` : "",
                      ].filter(Boolean);
                      if (parts.length > 0) void send(parts.join(". "), "hire");
                    }}
                  >
                    Set budget and day
                  </button>
                </div>
              ) : null}
              {showControls && controls.choices.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {controls.choices.map((choice) => (
                    <button key={choice.label} className="border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50" disabled={!ready} type="button" onClick={() => void send(choice.message, "hire")}>
                      {choice.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {controls.lock && hire?.payer ? (
                <DealLockButton
                  agentId={agentId}
                  payer={hire.payer as Address}
                  onError={setError}
                  onEngage={() => {
                    setRetiredControl(controlKey);
                    setLockBusy(true);
                  }}
                  onDone={(ok) => {
                    setLockBusy(false);
                    if (!ok) setRetiredControl("");
                  }}
                />
              ) : null}
            </div>
          ) : null}
          {drafts.length > 0 ? (
            <ul className="mb-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto" aria-label="Attached files">
              {drafts.map((item) => (
                <li key={item.id} className="flex max-w-full items-center gap-2 rounded-md bg-[var(--sunken)] px-2 py-1 text-xs">
                  {item.kind === "image" ? <img src={item.dataUrl} alt="" className="h-8 w-8 rounded object-cover" /> : null}
                  <span className="max-w-[12rem] truncate">{item.name}</span>
                  <button className="shrink-0 underline" type="button" onClick={() => removeDraft(item.id)}>Remove</button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="composer-bar">
            <WebAccess agentId={agentId} />
            <button className="shrink-0 gap-2 border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50" disabled={!ready || awaitingReply} type="button" aria-label="Attach files" onClick={() => uploadInput.current?.click()}>
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 12.5l6.2-6.2a3 3 0 0 1 4.2 4.2l-7.4 7.5a4.2 4.2 0 0 1-6-6l6.8-6.8" /></svg>
              Attach
            </button>
            <input
              className="sr-only"
              ref={uploadInput}
              type="file"
              multiple
              accept=".md,.txt,.csv,.png,.jpg,.jpeg,.webp,.gif,.wav,.mp3,.m4a,.ogg,.webm,image/*,audio/*"
              aria-label="Attach files"
              onChange={(event) => {
                const chosen = event.target.files;
                event.target.value = "";
                void takeFiles(chosen);
              }}
            />
            <label className="min-w-0 flex-1">
              <span className="sr-only">Message {name}</span>
              <textarea
                className="max-h-32 min-h-11 w-full resize-none px-3 py-2"
                rows={1}
                value={text}
                disabled={!ready || awaitingReply}
                placeholder={ready ? `Message ${name}` : "Waiting for XMTP…"}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (canSend) void send();
                  }
                }}
              />
            </label>
            <button className="shrink-0 bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={!canSend} type="submit">
              Send
            </button>
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">Choose .md, .txt, .csv, images, or voice files. They go with this message and are not saved in the workspace.</p>
          {uploadError ? <p className="alert alert-error mt-2" role="alert">{uploadError}</p> : null}
          {error && (ready || rows.length > 0) ? (
            <p className="alert alert-error mt-2" role="alert">{error}{text.trim() ? " You can edit the message and send it again." : ""}</p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
