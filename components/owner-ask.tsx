"use client";

import { useState } from "react";
import { ownerAnswer, type OwnerAsk } from "@/lib/chat/ask";

/** Buttons and a text field for the question the agent is waiting on. */
export function OwnerAskBar({
  ask,
  disabled,
  onSend,
}: {
  ask: OwnerAsk;
  disabled: boolean;
  onSend: (message: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [otherOn, setOtherOn] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [typed, setTyped] = useState("");
  const needsField = ask.inputLabel.length > 0;
  const needsChoice = ask.choices.length > 0;
  const message = ownerAnswer({ picked, other: otherOn ? otherText : "", typed });
  const ready = (!needsChoice || picked.length > 0 || (otherOn && otherText.trim().length > 0))
    && (!otherOn || otherText.trim().length > 0)
    && (!needsField || typed.trim().length > 0);

  function choose(label: string) {
    if (!ask.multiple && !needsField) {
      onSend(label);
      return;
    }
    if (!ask.multiple) setOtherOn(false);
    setPicked((current) => {
      if (ask.multiple) return current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
      return current[0] === label ? [] : [label];
    });
  }

  function chooseOther() {
    if (!ask.multiple) setPicked([]);
    setOtherOn((current) => !current);
  }

  return (
    <div className="mb-3 space-y-2">
      <p className="text-sm">{ask.prompt}</p>
      {needsChoice ? (
        <div className="flex flex-wrap gap-2">
          {ask.choices.map((label) => {
            const on = picked.includes(label);
            return (
              <button
                key={label}
                className={`border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50 ${on ? "bg-[var(--ink)] text-[var(--paper)]" : ""}`}
                disabled={disabled}
                type="button"
                aria-pressed={ask.multiple || needsField ? on : undefined}
                onClick={() => choose(label)}
              >
                {label}
              </button>
            );
          })}
          <button
            className={`border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50 ${otherOn ? "bg-[var(--ink)] text-[var(--paper)]" : ""}`}
            disabled={disabled}
            type="button"
            aria-pressed={otherOn}
            onClick={chooseOther}
          >
            Other
          </button>
        </div>
      ) : null}
      {needsField || ask.multiple || otherOn ? (
        <div className="flex flex-wrap items-end gap-2">
          {otherOn ? (
            <label className="min-w-0 flex-1 text-xs text-[var(--muted)]">
              Other
              <input className="mt-1 w-full px-3 py-2 text-sm text-[var(--ink)]" value={otherText} disabled={disabled} onChange={(event) => setOtherText(event.target.value)} />
            </label>
          ) : null}
          {needsField ? (
            <label className="min-w-0 flex-1 text-xs text-[var(--muted)]">
              {ask.inputLabel}
              <input className="mt-1 w-full px-3 py-2 text-sm text-[var(--ink)]" value={typed} disabled={disabled} onChange={(event) => setTyped(event.target.value)} />
            </label>
          ) : null}
          <button className="border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50" disabled={disabled || !ready} type="button" onClick={() => onSend(message)}>
            Send
          </button>
        </div>
      ) : null}
    </div>
  );
}
