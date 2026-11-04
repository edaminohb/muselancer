"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { SkillPicker } from "@/components/skill-picker";
import type { SkillChoice } from "@/lib/protocol/skills";

type Hit = {
  id: string;
  displayName: string;
  description: string;
  skillIds: number[];
  registry: string;
  agentId: string;
  owner: string;
  agentWallet: string;
  hirePrice: string | null;
};

export default function DirectoryPage() {
  const [skills, setSkills] = useState<SkillChoice[]>([]);
  const [skillId, setSkillId] = useState<number | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [rejected, setRejected] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function load(id: number | null) {
    const query = id === null ? "" : `?skill=${encodeURIComponent(String(id))}`;
    const response = await fetch(`/api/directory${query}`);
    const body = (await response.json().catch(() => ({}))) as { error?: string; hits?: Hit[]; rejected?: number; note?: string };
    setLoaded(true);
    if (!response.ok) {
      setHits([]);
      setRejected(0);
      setNote("");
      setError(body.error ?? "Directory search failed.");
      return;
    }
    setError("");
    setHits(body.hits ?? []);
    setRejected(body.rejected ?? 0);
    setNote(body.note ?? "");
  }

  useEffect(() => {
    void fetch("/api/skills")
      .then((response) => response.json())
      .then((body: { skills?: SkillChoice[]; error?: string }) => {
        if (body.error || !body.skills?.length) {
          setError(body.error ?? "Could not read the OASF skill taxonomy.");
          return;
        }
        setSkills(body.skills);
      })
      .catch(() => setError("Could not read the OASF skill taxonomy."));
    void load(null);
  }, []);

  return (
    <Shell wide>
      <div className="page-head">
        <div>
          <h1>Discover agents</h1>
          <p className="lede">{note || "Available agents are the Directory records the identity registry confirms."}</p>
        </div>
      </div>
      {error ? <p className="alert alert-error mt-4" role="alert">{error}</p> : null}
      <div className="catalog-layout">
        <aside>
          <p className="text-sm font-semibold">Skill</p>
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void load(skillId);
            }}
          >
            <SkillPicker
              label="Filter"
              skills={skills}
              skillId={skillId}
              onChange={(id) => {
                setSkillId(id);
                void load(id);
              }}
            />
            <button className="mt-3 border border-[var(--ink)] px-4 py-2" type="button" onClick={() => { setSkillId(null); void load(null); }}>
              All agents
            </button>
            {rejected > 0 ? <p className="mt-3 text-sm text-[var(--muted)]">Left out {rejected} records the identity registry did not confirm.</p> : null}
          </form>
        </aside>
        <div>
          {!loaded ? (
            <div className="space-y-3" aria-live="polite">
              <p className="text-sm text-[var(--muted)]">Searching the Directory…</p>
              <div className="skeleton w-2/3" />
              <div className="skeleton w-1/2" />
            </div>
          ) : null}
          {hits.length > 0 ? (
            <ul className="catalog">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <article className="catalog-tile">
                    <p className="tile-name">{hit.displayName}</p>
                    <p className="tile-copy">{hit.description}</p>
                    <p className="text-xs text-[var(--muted)]">Skills {hit.skillIds.join(", ")}</p>
                    <div className="tile-foot">
                      <p className="price-figure">{hit.hirePrice ? `${hit.hirePrice}` : "—"} <span className="text-xs font-medium text-[var(--muted)]">USDC</span></p>
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          ) : null}
          {loaded && hits.length === 0 && !error ? <p className="text-sm text-[var(--muted)]">No available agents.</p> : null}
        </div>
      </div>
    </Shell>
  );
}
