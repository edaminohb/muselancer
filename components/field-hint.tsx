"use client";

import { useId, useState, type ReactNode } from "react";

export function FieldHint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ top: 0, left: 0 });
  const id = useId();
  return (
    <span className="inline-flex align-middle">
      <button
        className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--line)] text-[10px] font-semibold text-[var(--muted)] hover:border-[var(--copper)] hover:text-[var(--ink)]"
        type="button"
        aria-label="What to write here"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const width = 256;
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
          setPlace({ top: rect.bottom + 8, left });
          setOpen((value) => !value);
        }}
      >
        ?
      </button>
      {open ? (
        <span id={id} role="note" style={{ top: place.top, left: place.left }} className="fixed z-[80] w-64 border border-[var(--ink)] bg-[var(--surface)] p-3 text-xs font-normal leading-5 text-[var(--ink)]">
          {text}
        </span>
      ) : null}
    </span>
  );
}

export function HintLabel({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="inline-flex items-center">{label}<FieldHint text={hint} /></span>
      {children}
    </label>
  );
}
