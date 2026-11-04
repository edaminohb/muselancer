"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/toaster";

export function WebAccess({ agentId }: { agentId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch(`/api/agents/${agentId}/web`)
      .then((response) => response.json())
      .then((body: { enabled?: boolean }) => {
        if (live) setEnabled(body.enabled === true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, [agentId]);

  async function choose(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    try {
      const response = await fetch(`/api/agents/${agentId}/web`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body = (await response.json()) as { enabled?: boolean; error?: string };
      if (!response.ok) {
        setEnabled(previous);
        toast("error", body.error ?? "Could not update web access.");
        return;
      }
      setEnabled(body.enabled === true);
    } catch {
      setEnabled(previous);
      toast("error", "Could not update web access.");
    }
  }

  return (
    <button
      className={`web-toggle shrink-0${enabled ? " is-on" : ""}`}
      type="button"
      aria-pressed={enabled}
      aria-label={enabled ? "Web search is on" : "Web search is off"}
      title={enabled ? "Web search is on" : "Web search is off"}
      disabled={!ready}
      onClick={() => void choose(!enabled)}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3a14 14 0 0 1 0 18" />
        <path d="M12 3a14 14 0 0 0 0 18" />
      </svg>
      <span className="sr-only">{enabled ? "Turn web search off" : "Turn web search on"}</span>
    </button>
  );
}
