"use client";

/** One live phase while the reply is still being written. The M walks on its two legs. */
export function ThinkMark({ phase = "Thinking" }: { phase?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--muted)]" aria-live="polite">
      <span className="muse-walk-stage" aria-hidden="true">
        <img className="muse-walk" src="/muselancer.png" alt="" />
      </span>
      <span>{phase}</span>
    </div>
  );
}
