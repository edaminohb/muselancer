import type { WorkspaceFile } from "./snapshot";

const ALWAYS = ["AGENTS.md", "SOUL.md", "IDENTITY.md"] as const;
const OWNER = ["USER.md", "MEMORY.md"] as const;
const SEARCHABLE = /^(memory\/|knowledge\/|projects\/|files\/)/;

export type ContextOptions = {
  startup: boolean;
  bootstrapComplete: boolean;
  query?: string;
};

function clip(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n[truncated]`;
}

function excerpt(text: string, needle: string): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(needle.toLowerCase());
  if (at < 0) return clip(text, 500);
  const start = Math.max(0, at - 80);
  return clip(text.slice(start, start + 500), 500);
}

export function searchWorkspace(files: WorkspaceFile[], query: string): { path: string; excerpt: string }[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  const dated = query.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
  if (terms.length === 0 && !dated) return [];
  const hits: { path: string; excerpt: string; score: number }[] = [];
  for (const file of files) {
    if (!SEARCHABLE.test(file.path)) continue;
    if (dated && file.path === `memory/${dated}.md`) {
      hits.push({ path: file.path, excerpt: excerpt(file.text, dated), score: 100 });
      continue;
    }
    const hay = `${file.path}\n${file.text}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (hay.includes(term) ? 1 : 0), 0);
    if (score === 0) continue;
    hits.push({ path: file.path, excerpt: excerpt(file.text, terms[0] ?? ""), score });
  }
  return hits
    .sort((left, right) => right.score - left.score || (left.path < right.path ? -1 : 1))
    .slice(0, 4)
    .map(({ path, excerpt: text }) => ({ path, excerpt: text }));
}

/** Owner chat and owner turns. Hire workers do not use this loader. */
export function loadOwnerContext(files: WorkspaceFile[], options: ContextOptions): string {
  const sections: string[] = [];
  const used = new Set<string>();
  function add(path: string, max: number) {
    const file = files.find((item) => item.path === path);
    if (!file) return;
    used.add(path);
    sections.push(`# ${path}\n${clip(file.text, max)}`);
  }
  for (const path of ALWAYS) add(path, 1600);
  for (const path of OWNER) add(path, 1200);
  if (options.startup) add("BOOT.md", 800);
  if (!options.bootstrapComplete) add("BOOTSTRAP.md", 1200);
  if (options.query) {
    for (const hit of searchWorkspace(files, options.query)) {
      if (used.has(hit.path)) continue;
      sections.push(`# ${hit.path}\n${clip(hit.excerpt, 600)}`);
      if (sections.join("\n").length > 7000) break;
    }
  }
  const text = sections.join("\n\n");
  return text.length > 8000 ? text.slice(0, 8000) : text;
}
