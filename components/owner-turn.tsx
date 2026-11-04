"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FieldHint, HintLabel } from "@/components/field-hint";

type WorkspaceFile = { path: string; text: string };
type AuditEntry = { at: string; actor: string; path: string; before: string; after: string };
type Proposal = { id: string; fact: string };
type WorkspaceBody = {
  cid?: string;
  history?: string[];
  bootstrapComplete?: boolean;
  files?: WorkspaceFile[];
  audit?: AuditEntry[];
  error?: string;
};

function MarkdownView({ text }: { text: string }) {
  return (
    <div className="card space-y-2 p-4 text-sm">
      {text.split("\n").map((line, index) => {
        if (line.startsWith("# ")) return <h2 key={index} className="text-xl font-semibold">{line.slice(2)}</h2>;
        if (line.startsWith("## ")) return <h3 key={index} className="text-lg font-semibold">{line.slice(3)}</h3>;
        if (line.startsWith("- ")) return <p key={index} className="pl-4">• {line.slice(2)}</p>;
        return <p key={index} className="whitespace-pre-wrap">{line || " "}</p>;
      })}
    </div>
  );
}

function savedLine(action: unknown): string {
  if (action === "save") return "Saved. The new snapshot is the current workspace.";
  if (action === "create") return "Created. The new snapshot is the current workspace.";
  if (action === "upload") return "Uploaded. The new snapshot is the current workspace.";
  if (action === "restore") return "Restored that snapshot.";
  if (action === "finish-bootstrap") return "Onboarding is finished.";
  return "Workspace updated.";
}

function shownPath(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "skills" && (parts[1] === "active" || parts[1] === "disabled" || parts[1] === "proposals") && parts.length >= 3) {
    return `skills/${parts.slice(2).join("/")} (${parts[1]})`;
  }
  return path;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function drag(event: ReactPointerEvent<HTMLButtonElement>, apply: (dx: number, dy: number) => void) {
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  let x = event.clientX;
  let y = event.clientY;
  const previous = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  function move(ev: PointerEvent) {
    apply(ev.clientX - x, ev.clientY - y);
    x = ev.clientX;
    y = ev.clientY;
  }
  function up() {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    document.body.style.userSelect = previous;
  }
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

export function OwnerTurn({ agentId, onWiden }: { agentId: string; onWiden?: (dx: number) => void }) {
  const [message, setMessage] = useState("");
  const [longHorizon, setLongHorizon] = useState(false);
  const [approveScript, setApproveScript] = useState(false);
  const [text, setText] = useState("");
  const [cid, setCid] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState("AGENTS.md");
  const [draft, setDraft] = useState("");
  const [newPath, setNewPath] = useState("knowledge/documents/note.md");
  const [folderPath, setFolderPath] = useState("knowledge/notes");
  const [bootstrapComplete, setBootstrapComplete] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState(false);
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [tray, setTray] = useState<"create" | "history" | "ask">("create");
  const [treeWidth, setTreeWidth] = useState(196);
  const [trayHeight, setTrayHeight] = useState(176);
  const uploadInput = useRef<HTMLInputElement>(null);
  const startup = useRef(true);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  function applyWorkspace(body: WorkspaceBody) {
    setLoaded(true);
    if (body.error) setError(body.error);
    if (body.cid) setCid(body.cid);
    if (body.history) setHistory(body.history);
    if (typeof body.bootstrapComplete === "boolean") setBootstrapComplete(body.bootstrapComplete);
    if (body.audit) setAudit(body.audit);
    if (body.files) {
      setFiles(body.files);
      const current = body.files.find((file) => file.path === selectedRef.current) ?? body.files.find((file) => file.path === "AGENTS.md") ?? body.files[0];
      if (current) {
        setSelected(current.path);
        setDraft(current.text);
      }
    }
  }

  function loadWorkspace() {
    void fetch(`/api/agents/${agentId}/workspace`)
      .then((response) => response.json())
      .then((body: WorkspaceBody) => applyWorkspace(body))
      .catch(() => {
        setLoaded(true);
        setError("Could not load the workspace.");
      });
    void fetch(`/api/agents/${agentId}/profile`)
      .then((response) => response.json())
      .then((body: { profile?: { proposals?: Proposal[] } }) => setProposals(body.profile?.proposals ?? []))
      .catch(() => setProposals([]));
  }

  useEffect(() => {
    loadWorkspace();
    const refresh = () => loadWorkspace();
    window.addEventListener("muselancer-workspace", refresh);
    return () => window.removeEventListener("muselancer-workspace", refresh);
  }, [agentId]);

  const skillFiles = files.filter((file) => file.path.startsWith("skills/"));
  const selectedFile = files.find((file) => file.path === selected);
  const skillLocked = selected.startsWith("skills/");
  const dirty = selectedFile ? !skillLocked && draft !== selectedFile.text : false;
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const map = new Map<string, WorkspaceFile[]>();
    for (const file of files) {
      if (needle && !file.path.toLowerCase().includes(needle)) continue;
      const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "Root";
      const list = map.get(folder) ?? [];
      list.push(file);
      map.set(folder, list);
    }
    return [...map.entries()];
  }, [files, filter]);

  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (!dirty) return;
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function postWorkspace(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/agents/${agentId}/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, cid: payload.cid ?? cid }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) setError(body.error ?? "Could not update this workspace.");
      else setNotice(savedLine(payload.action));
      loadWorkspace();
    } catch {
      setError("Could not update this workspace.");
    } finally {
      setBusy("");
    }
  }

  async function confirmProposal(proposalId: string, action: "confirm" | "reject") {
    setBusy(action === "confirm" ? "Confirming the memory…" : "Leaving that proposal out…");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/agents/${agentId}/profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, proposalId, password }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) setError(body.error ?? "Could not update that memory.");
      else {
        setNotice(action === "confirm" ? "Memory confirmed." : "That proposal was left out.");
        loadWorkspace();
      }
    } catch {
      setError("Could not update that memory.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 py-2 text-xs text-[var(--muted)]">
        <span className="break-all">Snapshot {cid ? cid.slice(0, 10) : "empty"}</span>
        {bootstrapComplete ? null : <button className="border border-[var(--ink)] px-2 py-1 text-xs disabled:opacity-50" disabled={Boolean(busy)} type="button" onClick={() => void postWorkspace({ action: "finish-bootstrap" }, "Finishing onboarding…")}>Finish onboarding</button>}
      </div>
      {busy ? <p className="text-sm text-[var(--muted)]" aria-live="polite">{busy}</p> : null}
      {notice ? <p className="alert alert-ok" role="status">{notice}</p> : null}
      {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
      <label className="mt-2 block shrink-0 text-sm">
        <span className="sr-only">Find a file</span>
        <input className="w-full px-3 py-2" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a file" />
      </label>
      <div className="mt-2 flex min-h-0 min-w-0 flex-1">
        <div className="min-h-0 shrink-0 overflow-auto rounded-md border border-[var(--line)] bg-[var(--bg)] p-1.5 text-sm" style={{ width: treeWidth }} role="tree" aria-label="Workspace files">
          {groups.map(([folder, entries]) => (
            <div key={folder} className="mb-2">
              <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{folder}</p>
              {entries.map((file) => (
                <button key={file.path} title={file.path} className={`block w-full truncate rounded-md px-2 py-1.5 text-left ${file.path === selected ? "bg-[var(--surface)] font-medium text-[var(--ink)] shadow-[inset_2px_0_0_var(--accent)]" : "text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--ink)]"}`} type="button" onClick={() => {
                  if (dirty && !window.confirm("This file has unsaved changes. Leave it?")) return;
                  setSelected(file.path);
                  setDraft(file.text);
                  setPreview(false);
                }}>{file.path.split("/").pop()}</button>
              ))}
            </div>
          ))}
          {!loaded ? <p className="px-2 py-2 text-[var(--muted)]">Loading workspace files…</p> : null}
          {loaded && files.length === 0 ? <p className="px-2 py-2 text-[var(--muted)]">This workspace has no files yet.</p> : null}
          {loaded && files.length > 0 && groups.length === 0 ? <p className="px-2 py-2 text-[var(--muted)]">No file matches that search.</p> : null}
        </div>
        <button className="pane-split" type="button" aria-label="Resize the file list" onPointerDown={(event) => drag(event, (dx) => setTreeWidth((width) => clamp(width + dx, 140, 340)))} onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setTreeWidth((width) => clamp(width - 16, 140, 340));
          if (event.key === "ArrowRight") setTreeWidth((width) => clamp(width + 16, 140, 340));
        }} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <form className="relative flex min-h-32 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-[var(--line)] bg-[var(--bg)]" onSubmit={(event) => { event.preventDefault(); void postWorkspace({ action: "save", path: selected, text: draft }, "Saving the file…"); }}>
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium" title={selected}>{selected || "No file"}</span>
            {skillLocked ? <span className="shrink-0 text-xs text-[var(--muted)]">Read only</span> : null}
            {dirty ? <span className="shrink-0 text-xs text-[var(--warn)]">Unsaved</span> : selectedFile ? <span className="shrink-0 text-xs text-[var(--muted)]">Saved</span> : null}
            <button className="border border-[var(--ink)] px-2 py-1 text-xs" type="button" onClick={() => setPreview((value) => !value)}>{preview ? "Edit" : "Preview"}</button>
            {skillLocked ? null : (
              <button className="bg-[var(--ink)] px-3 py-1 text-xs text-[var(--paper)] disabled:opacity-50" disabled={Boolean(busy) || !selectedFile || !dirty} type="submit">{busy ? "Saving…" : "Save"}</button>
            )}
          </div>
          {preview ? <div className="min-h-0 flex-1 overflow-auto"><MarkdownView text={draft} /></div> : (
            <textarea className="editor min-h-0 w-full flex-1 resize-none px-3 py-3 font-mono text-sm leading-relaxed" value={draft} readOnly={skillLocked} onChange={(event) => setDraft(event.target.value)} />
          )}
          <button className="editor-grip" type="button" aria-label="Resize the editor" onPointerDown={(event) => drag(event, (dx, dy) => {
            onWiden?.(dx);
            setTrayHeight((height) => clamp(height - dy, 96, 420));
          })} />
        </form>
        <button className="pane-split pane-split-y" type="button" aria-label="Resize the editor height" onPointerDown={(event) => drag(event, (_dx, dy) => setTrayHeight((height) => clamp(height - dy, 96, 420)))} onKeyDown={(event) => {
          if (event.key === "ArrowUp") setTrayHeight((height) => clamp(height + 16, 96, 420));
          if (event.key === "ArrowDown") setTrayHeight((height) => clamp(height - 16, 96, 420));
        }} />
        <aside className="flex shrink-0 flex-col overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface)]" style={{ height: trayHeight }}>
        <div className="flex shrink-0 gap-1 border-b border-[var(--line)] p-1.5" role="tablist" aria-label="Workspace tools">
          {(["create", "history", "ask"] as const).map((id) => (
            <button key={id} className={`px-3 py-1.5 text-xs ${tray === id ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--muted)] hover:text-[var(--ink)]"}`} role="tab" type="button" aria-selected={tray === id} onClick={() => setTray(id)}>
              {id === "create" ? "Create" : id === "history" ? "Restore" : "Ask"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tray === "create" ? (
      <>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void postWorkspace({ action: "create", path: newPath, text: `# ${newPath.split("/").pop()}\n` }, "Creating the file…"); }}>
        <HintLabel label="New file" hint="A path such as knowledge/notes.md or projects/plan.md. Skill files are added on the Skills page, not here.">
          <input className="mt-1 px-3 py-2" value={newPath} onChange={(event) => setNewPath(event.target.value)} />
        </HintLabel>
        <button className="border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50" disabled={Boolean(busy)} type="submit">Create file</button>
      </form>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void postWorkspace({ action: "create", path: folderPath, folder: true }, "Creating the folder…"); }}>
        <HintLabel label="New folder" hint="A folder path such as projects/launch. Muselancer stores it as that path plus /.keep.">
          <input className="mt-1 px-3 py-2" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} />
        </HintLabel>
        <button className="border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50" disabled={Boolean(busy)} type="submit">Create folder</button>
      </form>
      <div className="mt-3">
        <span className="inline-flex items-center text-sm">Upload a text document<FieldHint text="A .md, .txt, .json, or .csv file. It is stored under knowledge/documents and does not replace the file you are editing." /></span>
        <button className="mt-1 border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50" disabled={Boolean(busy)} type="button" onClick={() => uploadInput.current?.click()}>Choose a text file</button>
        <input className="sr-only" ref={uploadInput} type="file" accept=".md,.txt,.json,.csv,text/plain" onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "note.md";
          setBusy("Reading the document…");
          void file.text()
            .then((contents) => postWorkspace({ action: "upload", path: `knowledge/documents/${safe}`, text: contents }, "Uploading the document…"))
            .catch(() => {
              setBusy("");
              setError("Could not read that document.");
            });
        }} />
      </div>
      </>
        ) : null}
        {tray === "history" ? (
      <>
      {history.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {history.map((item) => (
            <button key={item} className="border border-[var(--ink)] px-3 py-1 text-sm disabled:opacity-50" disabled={Boolean(busy)} type="button" onClick={() => void postWorkspace({ action: "restore", cid: item }, "Restoring that snapshot…")}>
              Restore {item.slice(0, 10)}
            </button>
          ))}
        </div>
      ) : null}
      {skillFiles.length > 0 ? (
        <div className="mt-4 text-sm">
          <h3 className="text-lg">Skills in this snapshot</h3>
          <ul className="mt-2 space-y-1">
            {skillFiles.map((file) => <li key={file.path}>{shownPath(file.path)}</li>)}
          </ul>
        </div>
      ) : null}
      {proposals.length > 0 ? (
        <div className="mt-4 space-y-3 text-sm">
          <h3 className="text-lg">Memory proposals</h3>
          {proposals.map((proposal) => (
            <div key={proposal.id} className="card px-3 py-3">
              <p>{proposal.fact}</p>
              <HintLabel label="Memory password" hint="The password that wraps this agent's memory vault. Confirm writes the line into memory. Leave it out discards the proposal.">
                <input className="mt-1 w-full px-3 py-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </HintLabel>
              <div className="mt-2 flex gap-3">
                <button className="bg-[var(--ink)] px-3 py-2 text-[var(--paper)] disabled:opacity-50" disabled={Boolean(busy)} type="button" onClick={() => void confirmProposal(proposal.id, "confirm")}>Confirm</button>
                <button className="border border-[var(--ink)] px-3 py-2 disabled:opacity-50" disabled={Boolean(busy)} type="button" onClick={() => void confirmProposal(proposal.id, "reject")}>Leave it out</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {audit.length > 0 ? (
        <div className="mt-4 text-sm">
          <h3 className="text-lg">Recent changes</h3>
          <ul className="mt-2 space-y-1">
            {audit.slice(-8).map((entry) => <li key={`${entry.at}-${entry.path}`}>{entry.actor} {entry.path}</li>)}
          </ul>
        </div>
      ) : null}
      {history.length <= 1 && skillFiles.length === 0 && proposals.length === 0 && audit.length === 0 ? <p className="text-sm text-[var(--muted)]">No earlier snapshot to restore yet.</p> : null}
      </>
        ) : null}
        {tray === "ask" ? (
      <>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        setBusy("The agent is working on this turn…");
        setError("");
        setNotice("");
        void fetch(`/api/agents/${agentId}/turn`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, startup: startup.current, longHorizon, approvedTools: approveScript ? ["run_entry", "write_workspace"] : [] }),
        })
          .then((response) => response.json())
          .then((body: { text?: string; error?: string; workspaceCid?: string }) => {
            startup.current = false;
            if (body.error) setError(body.error);
            else if (body.text) setNotice("The turn finished.");
            if (body.text) setText(body.text);
            if (body.workspaceCid) setCid(body.workspaceCid);
            loadWorkspace();
          })
          .catch(() => setError("Could not run this turn."))
          .finally(() => setBusy(""));
      }}>
        <HintLabel label="Ask this agent" hint="A question for this agent. The reply can use the workspace files you own. It does not move USDC.">
          <textarea className="mt-1 w-full px-3 py-2" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} />
        </HintLabel>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={longHorizon} onChange={(event) => setLongHorizon(event.target.checked)} />
          This task is long-horizon
          <span className="text-xs text-[var(--muted)]">Marks this turn as long-horizon. The agent still uses the model you chose.</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={approveScript} onChange={(event) => setApproveScript(event.target.checked)} />
          Approve scripts and workspace writes for this turn
          <span className="text-xs text-[var(--muted)]">Allows run_entry and write_workspace. Money actions stay off.</span>
        </label>
        <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={Boolean(busy) || !message.trim()} type="submit">{busy === "The agent is working on this turn…" ? "Running…" : "Run"}</button>
      </form>
      {text ? <p className="mt-3 whitespace-pre-wrap text-sm">{text}</p> : null}
      </>
        ) : null}
        </div>
      </aside>
        </div>
      </div>
    </section>
  );
}
