"use client";

import { MUSE_MODELS } from "@/lib/gateway/models";

export function ModelChoice({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm">Model</legend>
      <p className="mt-1 text-xs text-[var(--muted)]">Every call this agent makes uses this model.</p>
      <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
        {MUSE_MODELS.map((model) => (
          <label key={model.id} className="model-option">
            <span className="flex items-center gap-2">
              <input type="radio" name="agent-model" checked={value === model.id} onChange={() => onChange(model.id)} />
              <span>{model.name}</span>
              <span className="text-xs text-[var(--muted)]">{model.id}</span>
            </span>
            <span className="mt-1 block text-xs text-[var(--muted)]">{model.description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
