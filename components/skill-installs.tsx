"use client";

import { useEffect, useRef, useState } from "react";
import { FieldHint, HintLabel } from "@/components/field-hint";
import { toast } from "@/components/toaster";

type Install = {
  name: string;
  version: string;
  state: string;
  revisionId: string;
  pendingRevisionId: string | null;
  requests: string[];
  grants: string[];
  history: string[];
  source: string;
};

type Revision = { name: string; description: string; files: { path: string; text: string }[]; manifest: { requests: { tools: string[] } } };

export function SkillInstalls({ agentId }: { agentId: string }) {
  const folderInput = useRef<HTMLInputElement>(null);
  const [installs, setInstalls] = useState<Install[]>([]);
  const [revisions, setRevisions] = useState<Record<string, Revision>>({});
  const [skillText, setSkillText] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [grants, setGrants] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState<Record<string, boolean>>({});

  function apply(body: { installs?: Install[]; revisions?: Record<string, Revision>; error?: string }) {
    if (body.installs) setInstalls(body.installs);
    if (body.revisions) setRevisions(body.revisions);
    if (body.error) setError(body.error);
  }

  useEffect(() => {
    void fetch(`/api/agents/${agentId}/skills`)
      .then((response) => response.json())
      .then((body) => {
        apply(body);
        setLoaded(true);
      })
      .catch(() => {
        setError("Could not load skills.");
        setLoaded(true);
      });
  }, [agentId]);

  async function send(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/agents/${agentId}/skills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { installs?: Install[]; revisions?: Record<string, Revision>; error?: string };
      if (!response.ok) {
        const message = body.error ?? "Could not update this skill.";
        setError(message);
        toast("error", message);
        return;
      }
      apply(body);
      const saved: Record<string, string> = {
        propose: "Skill proposed. It stays inactive until you activate it.",
        activate: "Skill activated.",
        disable: "Skill disabled.",
        remove: "Skill removed.",
        rollback: "Rolled back to that revision.",
      };
      if (!body.error && typeof payload.action === "string") {
        const message = saved[payload.action] ?? "Skill updated.";
        setNotice(message);
        toast("ok", message);
      }
    } catch {
      setError("Could not update this skill.");
      toast("error", "Could not update this skill.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const raw = await Promise.all([...files].map(async (file) => ({ path: (file.webkitRelativePath || file.name).replace(/\\/g, "/"), text: await file.text() })));
    const root = raw[0]?.path.split("/")[0] ?? "";
    const nested = root && raw.every((file) => file.path.startsWith(`${root}/`));
    const packed = nested ? raw.map((file) => ({ ...file, path: file.path.slice(root.length + 1) })) : raw;
    await send({ action: "propose", source: "upload", directoryName: nested ? root : "", files: packed });
  }

  return (
    <section className="mt-4">
      <p className="text-sm text-[var(--muted)]">An active skill is on. A proposed skill waits until you activate it. Open a skill to read its instructions.</p>
      {!loaded ? <p className="mt-4 text-sm text-[var(--muted)]" aria-live="polite">Loading installed skills…</p> : null}
      {loaded && installs.length === 0 && !error ? <p className="mt-4 text-sm text-[var(--muted)]">No skills are installed yet.</p> : null}
      {busy ? <p className="mt-3 text-sm text-[var(--muted)]" aria-live="polite">Updating skills…</p> : null}
      {notice ? <p className="alert alert-ok mt-3" role="status">{notice}</p> : null}
      {error ? <p className="alert alert-error mt-3" role="alert">{error}</p> : null}
      {installs.map((install) => {
        const revision = revisions[install.pendingRevisionId || install.revisionId];
        const choices = revision?.manifest.requests.tools ?? install.requests;
        const selected = grants[install.name] ?? install.grants;
        const pending = Boolean(install.pendingRevisionId);
        const state = skillState(install.state);
        const readable = (revision?.files ?? []).filter((file) => file.text.trim());
        return (
          <article key={install.name} className="card mt-4 space-y-3 p-4 text-sm">
            <div className="flex items-start justify-between gap-3">
              <p className="text-base font-semibold">{install.name}</p>
              <span className={`skill-state shrink-0 ${state.tone}`}>{state.label}</span>
            </div>
            <p className="text-xs text-[var(--muted)]">{install.version} · {install.source}</p>
            <p>{state.detail}</p>
            {revision?.description ? <p>{revision.description}</p> : null}
            {readable.length > 0 ? (
              <div className="space-y-2">
                {readable.map((file) => {
                  const open = reading[`${install.name}:${file.path}`] === true;
                  return (
                    <div key={file.path} className="overflow-hidden rounded-lg border border-[var(--line)]">
                      <button
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm"
                        type="button"
                        aria-expanded={open}
                        onClick={() => setReading((current) => ({ ...current, [`${install.name}:${file.path}`]: !open }))}
                      >
                        <span>{file.path === "SKILL.md" ? "Read the skill" : file.path}</span>
                        <span className="text-xs text-[var(--muted)]">{open ? "Close" : "Open"}</span>
                      </button>
                      {open ? <pre className="hire-code skill-text">{file.text}</pre> : null}
                    </div>
                  );
                })}
              </div>
            ) : <p className="text-[var(--muted)]">The skill text could not be read.</p>}
            {choices.length > 0 ? (
              <p className="text-xs text-[var(--muted)]">
                Check the tools you will allow when you activate. Money tools are never listed. A check does nothing until you press Activate.
                <FieldHint text="These names come from the skill's requests.tools. Grants are stored with the install. The model cannot change them by writing that it did." />
              </p>
            ) : null}
            {choices.map((tool) => (
              <label key={tool} className="mr-3 inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.includes(tool)}
                  onChange={(event) => {
                    const next = event.target.checked ? [...selected, tool] : selected.filter((item) => item !== tool);
                    setGrants({ ...grants, [install.name]: next });
                  }}
                />
                {tool}
              </label>
            ))}
            <div className="flex flex-wrap gap-3">
              {install.state !== "active" || pending ? (
                <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={busy} type="button" onClick={() => void send({ action: "activate", name: install.name, grants: selected, revisionId: install.pendingRevisionId || install.revisionId })}>
                  {pending ? "Activate the new text" : "Activate"}
                </button>
              ) : null}
              {install.state === "active" ? <button className="border border-[var(--ink)] px-4 py-2 disabled:opacity-50" disabled={busy} type="button" onClick={() => void send({ action: "disable", name: install.name })}>Disable</button> : null}
              {install.state !== "removed" ? <button className="border border-[var(--ink)] px-4 py-2 disabled:opacity-50" disabled={busy} type="button" onClick={() => { if (!window.confirm(`Remove ${install.name}? It will no longer be available to this agent.`)) return; void send({ action: "remove", name: install.name }); }}>Remove</button> : null}
            </div>
            {install.history.length > 1 ? (
              <HintLabel label="Rollback to a revision" hint="Restores an earlier package of this skill and keeps the grants you have checked. The current revision stays in history.">
                <select className="mt-1 w-full px-3 py-2" onChange={(event) => { if (event.target.value) void send({ action: "rollback", name: install.name, revisionId: event.target.value, grants: selected }); }}>
                  <option value="">Choose a revision</option>
                  {install.history.map((revisionId) => <option key={revisionId} value={revisionId}>{revisionId.slice(0, 12)}</option>)}
                </select>
              </HintLabel>
            ) : null}
          </article>
        );
      })}
      <div className="card mt-4 space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold">Add a skill</h3>
          <button className="bg-[var(--ink)] px-4 py-2 text-sm text-[var(--paper)] disabled:opacity-50" disabled={busy} type="button" onClick={() => folderInput.current?.click()}>
            Upload a skill folder
          </button>
        </div>
        <p className="text-sm text-[var(--muted)]">
          Choose the folder that contains SKILL.md and muselancer.manifest.json.
          <FieldHint text="The folder is proposed as-is and stays inactive until you activate it. Paths stay one folder deep. Allowed tops are SKILL.md, muselancer.manifest.json, scripts, references, and assets." />
        </p>
        <input
          className="sr-only"
          multiple
          type="file"
          ref={(node) => {
            folderInput.current = node;
            node?.setAttribute("webkitdirectory", "");
            node?.setAttribute("directory", "");
          }}
          onChange={(event) => {
            void upload(event.target.files);
            event.target.value = "";
          }}
        />
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          const files = [
            { path: "SKILL.md", text: skillText },
            { path: "muselancer.manifest.json", text: manifestText },
          ];
          if (scriptText.trim()) files.push({ path: "scripts/main.py", text: scriptText });
          void send({ action: "propose", source: "authored", files });
        }}>
          <Area label="SKILL.md" hint="Start with a --- frontmatter block and close it with ---. Include name, description, and metadata.version, then the instructions the agent reads. Keep it under 500 lines. allowed-tools in the file does not grant anything." value={skillText} onChange={setSkillText} />
          <Area label="muselancer.manifest.json" hint="JSON. formatVersion must be 1. version is semver and must match metadata.version. depends is a list of name and range. requests.tools, requests.mcp, and requests.secrets are string lists. requests.network is none or an allow list of hosts. risk is low, medium, or high. entry lists scripts in this package. advertise is up to 8 OASF skill ids. Commerce tool names are rejected." value={manifestText} onChange={setManifestText} />
          <Area label="scripts/main.py, optional" hint="Leave this empty if the skill has no script. If you write one, list scripts/main.py in the manifest entry. Executable scripts must be in entry." value={scriptText} onChange={setScriptText} />
          <button className="border border-[var(--ink)] px-4 py-2 disabled:opacity-50" disabled={busy} type="submit">Propose skill</button>
        </form>
      </div>
    </section>
  );
}

function skillState(state: string): { label: string; detail: string; tone: string } {
  if (state === "active") return { label: "Active", detail: "This skill is on. The agent can read it.", tone: "is-active" };
  if (state === "proposed") return { label: "Proposed", detail: "This skill is waiting. Activate it to turn it on.", tone: "is-proposed" };
  if (state === "disabled") return { label: "Disabled", detail: "This skill is off.", tone: "is-disabled" };
  if (state === "removed") return { label: "Removed", detail: "This skill is removed.", tone: "is-removed" };
  return { label: "Unknown", detail: "This skill has no state.", tone: "is-disabled" };
}

function Area({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (value: string) => void }) {
  return (
    <HintLabel label={label} hint={hint}>
      <textarea className="mt-1 w-full px-3 py-2" rows={4} value={value} onChange={(event) => onChange(event.target.value)} />
    </HintLabel>
  );
}
