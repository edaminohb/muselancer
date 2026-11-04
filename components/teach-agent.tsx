"use client";

import { useEffect, useState, type ReactNode } from "react";
import { HintLabel } from "@/components/field-hint";

type Proposal = { id: string; fact: string };

type Profile = {
  identity: { displayName: string; description: string; expertise: string[] };
  voice: { personality: string; tone: string; style: string };
  conduct: { preferences: string[]; decisionStyle: string; boundaries: string[]; instructions: string[] };
  goals: { objectives: string[] };
  models: { ordinary: string; longHorizon: string };
  proposals: Proposal[];
  turns: { role: "human" | "agent"; text: string }[];
};

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function join(values: string[] | undefined): string {
  return (values ?? []).join("\n");
}

export function TeachAgent({ agentId }: { agentId: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [expertise, setExpertise] = useState("");
  const [personality, setPersonality] = useState("");
  const [tone, setTone] = useState("");
  const [style, setStyle] = useState("");
  const [preferences, setPreferences] = useState("");
  const [decisionStyle, setDecisionStyle] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [instructions, setInstructions] = useState("");
  const [objectives, setObjectives] = useState("");
  const [lesson, setLesson] = useState("");
  const [password, setPassword] = useState("");
  const [memory, setMemory] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [section, setSection] = useState("identity");

  function apply(next: Profile) {
    setProfile(next);
    setDisplayName(next.identity.displayName);
    setDescription(next.identity.description);
    setExpertise(join(next.identity.expertise));
    setPersonality(next.voice.personality);
    setTone(next.voice.tone);
    setStyle(next.voice.style);
    setPreferences(join(next.conduct.preferences));
    setDecisionStyle(next.conduct.decisionStyle);
    setBoundaries(join(next.conduct.boundaries));
    setInstructions(join(next.conduct.instructions));
    setObjectives(join(next.goals.objectives));
  }

  useEffect(() => {
    void fetch(`/api/agents/${agentId}/profile`)
      .then((response) => response.json())
      .then((body: { profile?: Profile; error?: string }) => {
        if (body.profile) apply(body.profile);
        if (body.error) setError(body.error);
        setLoaded(true);
      })
      .catch(() => {
        setError("Could not load this agent.");
        setLoaded(true);
      });
  }, [agentId]);

  async function send(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/agents/${agentId}/profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { profile?: Profile; memory?: string | null; error?: string };
      if (!response.ok || !body.profile) {
        setError(body.error ?? "Could not teach this agent.");
        return;
      }
      apply(body.profile);
      if (body.memory) setMemory(body.memory);
      if (payload.action === "teach") setLesson("");
      const saved: Record<string, string> = {
        identity: "Identity saved. The registry name is unchanged.",
        voice: "Voice saved.",
        conduct: "Conduct saved.",
        goals: "Goals saved.",
        teach: "A memory draft is ready to confirm.",
        confirm: "Memory confirmed.",
        reject: "That proposal was left out.",
      };
      if (typeof payload.action === "string") setNotice(saved[payload.action] ?? "Saved.");
    } catch {
      setError("Could not teach this agent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4">
      <p className="text-sm text-[var(--muted)]">Each section is saved on its own. A fact enters memory only after you confirm it. The registry name stays as it was signed.</p>
      {!loaded ? <p className="mt-4 text-sm text-[var(--muted)]" aria-live="polite">Loading the teaching profile…</p> : null}
      {busy ? <p className="mt-3 text-sm text-[var(--muted)]" aria-live="polite">Working…</p> : null}
      {notice ? <p className="alert alert-ok mt-3" role="status">{notice}</p> : null}
      {error ? <p className="alert alert-error mt-3" role="alert">{error}</p> : null}
      <TeachSection id="identity" title="Identity" open={section} onOpen={setSection}>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void send({ action: "identity", identity: { displayName, description, expertise: lines(expertise) } }); }}>
          <Field label="Display name" hint="The name you use for this agent in Muselancer. Saving it does not change the signed registry name." value={displayName} onChange={setDisplayName} />
          <Field label="Private description" hint="A description stored with this agent. It is not published to the Directory." value={description} onChange={setDescription} area />
          <Field label="Areas of expertise, one on each line" hint="One subject per line. Blank lines are dropped when you save." value={expertise} onChange={setExpertise} area />
          <Save busy={busy} label="Save identity" />
        </form>
      </TeachSection>
      <TeachSection id="voice" title="Voice" open={section} onOpen={setSection}>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void send({ action: "voice", voice: { personality, tone, style } }); }}>
          <Field label="Personality" hint="How the agent should come across, in a few sentences." value={personality} onChange={setPersonality} area />
          <Field label="Tone" hint="A short tone, such as calm, direct, or warm." value={tone} onChange={setTone} />
          <Field label="Communication style" hint="How replies should be shaped: length, formality, and what to lead with." value={style} onChange={setStyle} area />
          <Save busy={busy} label="Save voice" />
        </form>
      </TeachSection>
      <TeachSection id="conduct" title="Conduct" open={section} onOpen={setSection}>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void send({ action: "conduct", conduct: { preferences: lines(preferences), decisionStyle, boundaries: lines(boundaries), instructions: lines(instructions) } }); }}>
          <Field label="Behavioral preferences, one on each line" hint="One preference per line, such as ask before sending a message." value={preferences} onChange={setPreferences} area />
          <Field label="Decision-making preferences" hint="How the agent should choose when several options are open." value={decisionStyle} onChange={setDecisionStyle} area />
          <Field label="Operating boundaries, one on each line" hint="One limit per line. These are instructions, not a lock on wallets or USDC." value={boundaries} onChange={setBoundaries} area />
          <Field label="Standing instructions, one on each line" hint="One standing instruction per line. The agent reads these on later turns." value={instructions} onChange={setInstructions} area />
          <Save busy={busy} label="Save conduct" />
        </form>
      </TeachSection>
      <TeachSection id="goals" title="Goals" open={section} onOpen={setSection}>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void send({ action: "goals", goals: { objectives: lines(objectives) } }); }}>
          <Field label="Objectives, one on each line" hint="One goal per line. These stay with this agent and are not written to the registry." value={objectives} onChange={setObjectives} area />
          <Save busy={busy} label="Save goals" />
        </form>
      </TeachSection>
      {profile?.turns.length ? (
        <ol className="mt-4 space-y-3 text-sm">
          {profile.turns.map((turn, index) => (
            <li key={`${turn.role}-${index}`} className="card whitespace-pre-wrap px-3 py-2">
              <span className="text-xs">{turn.role === "human" ? "You" : "Your agent"}</span>
              <p>{turn.text}</p>
            </li>
          ))}
        </ol>
      ) : null}
      <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void send({ action: "teach", lesson }); }}>
        <Field label="What should this agent learn?" hint="A fact to draft as memory. It is not stored until you confirm it with the memory password." value={lesson} onChange={setLesson} area />
        <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={busy} type="submit">Draft a memory</button>
      </form>
      {profile?.proposals.map((proposal) => (
        <div key={proposal.id} className="card mt-4 space-y-3 p-3 text-sm">
          <p>{proposal.fact}</p>
          <HintLabel label="Memory password" hint="The password that wraps this agent's memory vault. Confirm stores the line. Leave it out discards the draft.">
            <input className="mt-1 w-full px-3 py-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </HintLabel>
          <div className="flex gap-3">
            <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={busy} type="button" onClick={() => void send({ action: "confirm", proposalId: proposal.id, password })}>Confirm memory</button>
            <button className="border border-[var(--ink)] px-4 py-2 disabled:opacity-50" disabled={busy} type="button" onClick={() => void send({ action: "reject", proposalId: proposal.id })}>Leave it out</button>
          </div>
        </div>
      ))}
      {memory ? <p className="card mt-4 whitespace-pre-wrap p-4 text-sm">{memory}</p> : null}
    </section>
  );
}

function TeachSection({ id, title, open, onOpen, children }: { id: string; title: string; open: string; onOpen: (id: string) => void; children: ReactNode }) {
  const shown = open === id;
  return (
    <div className="mt-3 overflow-hidden border-t border-[var(--line)]">
      <button className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-semibold" type="button" aria-expanded={shown} onClick={() => onOpen(shown ? "" : id)}>
        {title}
        <span className="text-xs font-normal text-[var(--muted)]">{shown ? "Hide" : "Open"}</span>
      </button>
      {shown ? <div className="border-t border-[var(--line)] px-3 py-3">{children}</div> : null}
    </div>
  );
}

function Save({ busy, label }: { busy: boolean; label: string }) {
  return <button className="border border-[var(--ink)] px-4 py-2 disabled:opacity-50" disabled={busy} type="submit">{label}</button>;
}

function Field({ label, hint, value, onChange, area }: { label: string; hint: string; value: string; onChange: (value: string) => void; area?: boolean }) {
  const className = "mt-1 w-full px-3 py-2";
  return (
    <HintLabel label={label} hint={hint}>
      {area ? <textarea className={className} rows={3} value={value} onChange={(event) => onChange(event.target.value)} /> : <input className={className} value={value} onChange={(event) => onChange(event.target.value)} />}
    </HintLabel>
  );
}
