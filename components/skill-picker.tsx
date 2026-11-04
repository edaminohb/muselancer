"use client";

import { useMemo, useState } from "react";
import { FieldHint } from "@/components/field-hint";
import { MAX_OASF_SKILLS, type SkillChoice } from "@/lib/protocol/skills";

type SkillPickerProps = {
  skills: SkillChoice[];
  label: string;
  hint?: string;
} & (
  | { multiple?: false; skillId: number | null; onChange: (id: number) => void }
  | { multiple: true; skillIds: number[]; onChange: (ids: number[]) => void }
);

export function SkillPicker(props: SkillPickerProps) {
  const { skills, label, hint } = props;
  const selectedIds = props.multiple ? props.skillIds : props.skillId === null ? [] : [props.skillId];
  const [query, setQuery] = useState("");
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => `${skill.caption} ${skill.category}`.toLowerCase().includes(needle));
  }, [query, skills]);
  const groups = useMemo(() => {
    const grouped: { category: string; skills: SkillChoice[] }[] = [];
    for (const skill of filtered) {
      const current = grouped[grouped.length - 1];
      if (current?.category === skill.category) current.skills.push(skill);
      else grouped.push({ category: skill.category, skills: [skill] });
    }
    return grouped;
  }, [filtered]);
  const selected = skills.filter((skill) => selectedIds.includes(skill.id));

  function choose(id: number) {
    if (!props.multiple) {
      props.onChange(id);
      return;
    }
    if (props.skillIds.includes(id)) {
      props.onChange(props.skillIds.filter((item) => item !== id));
      return;
    }
    if (props.skillIds.length >= MAX_OASF_SKILLS) return;
    props.onChange([...props.skillIds, id]);
  }

  return (
    <fieldset className="block text-sm">
      <legend className="inline-flex items-center">{label}{hint ? <FieldHint text={hint} /> : null}</legend>
      <input
        className="mt-1 w-full px-3 py-2"
        value={query}
        placeholder="Filter by skill name"
        onChange={(event) => setQuery(event.target.value)}
      />
      {selected.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Selected skills">
          {selected.map((skill) => (
            <li key={skill.id} className="flex items-center gap-2 bg-[var(--sunken)] px-2 py-1 text-xs">
              <span>{skill.caption}</span>
              {props.multiple ? (
                <button className="underline" type="button" onClick={() => choose(skill.id)}>Remove</button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {props.multiple && selectedIds.length >= MAX_OASF_SKILLS ? <p className="mt-2 text-xs text-[var(--muted)]">5 skills selected. Remove one to choose another.</p> : null}
      <div className="mt-2 max-h-72 overflow-y-auto border-t border-[var(--line)]">
        {groups.map((group) => {
          const expanded = Boolean(query.trim()) || openCategory === group.category || group.skills.some((skill) => selectedIds.includes(skill.id));
          return (
            <div key={group.category}>
              <button className="flex w-full items-center justify-between bg-[var(--bg)] px-3 py-2 text-left text-xs font-semibold text-[var(--muted)]" type="button" aria-expanded={expanded} onClick={() => setOpenCategory(expanded && openCategory === group.category ? null : group.category)}>
                {group.category}
                <span>{expanded ? "Hide" : `${group.skills.length}`}</span>
              </button>
              {expanded ? group.skills.map((skill) => {
                const on = selectedIds.includes(skill.id);
                return (
                  <button
                    key={skill.id}
                    className={`block w-full px-3 py-2 text-left ${on ? "nav-on" : "text-[var(--ink)]"}`}
                    type="button"
                    aria-pressed={on}
                    onClick={() => choose(skill.id)}
                  >
                    {skill.caption}
                  </button>
                );
              }) : null}
            </div>
          );
        })}
        {skills.length > 0 && filtered.length === 0 ? <p className="px-3 py-2 text-sm">No skill matches that name.</p> : null}
      </div>
    </fieldset>
  );
}
