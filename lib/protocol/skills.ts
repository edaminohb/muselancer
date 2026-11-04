const TAXONOMY_URL = "https://schema.oasf.outshift.com/api/1.0.0/skill_categories";

export const MAX_OASF_SKILLS = 5;

export function assertRegistrationSkills(skillIds: number[]): void {
  if (skillIds.length < 1 || skillIds.length > MAX_OASF_SKILLS || skillIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("Choose 1 to 5 OASF skills.");
  }
  if (new Set(skillIds).size !== skillIds.length) throw new Error("Choose each skill once.");
}

export class SkillUnknownError extends Error {
  constructor(id: number) {
    super(`Skill id ${id} is not in the OASF taxonomy.`);
  }
}

export type SkillChoice = {
  id: number;
  name: string;
  caption: string;
  description: string;
  category: string;
};

type SkillNode = {
  id?: unknown;
  name?: unknown;
  caption?: unknown;
  description?: unknown;
  category?: unknown;
  classes?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type SkillTaxonomy = {
  choices: SkillChoice[];
  categories: { id: number; caption: string }[];
};

/** Flattens the OASF 1.0.0 skill_categories document. Category headings are not selectable skills. */
export function readSkillTaxonomy(tree: unknown): SkillTaxonomy {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new Error("Could not read the OASF skill taxonomy.");
  }
  const choices: SkillChoice[] = [];
  const categories: { id: number; caption: string }[] = [];
  const seen = new Set<number>();
  const walk = (node: SkillNode, category: string) => {
    const caption = text(node.caption);
    const name = text(node.name);
    const description = text(node.description);
    const nextCategory = node.category === true && caption ? caption : category;
    const id = node.id;
    const hasId = typeof id === "number" && Number.isInteger(id) && id > 0;
    if (hasId && node.category === true) {
      if (seen.has(id)) throw new Error("OASF taxonomy has a duplicate skill id.");
      seen.add(id);
      categories.push({ id, caption: caption || name || `Category ${id}` });
    } else if (caption && name && hasId) {
      if (seen.has(id)) throw new Error("OASF taxonomy has a duplicate skill id.");
      seen.add(id);
      choices.push({ id, name, caption, description, category: nextCategory || caption });
    }
    if (!node.classes || typeof node.classes !== "object" || Array.isArray(node.classes)) return;
    for (const child of Object.values(node.classes)) {
      if (child && typeof child === "object" && !Array.isArray(child)) walk(child as SkillNode, nextCategory);
    }
  };
  for (const node of Object.values(tree as Record<string, unknown>)) {
    if (node && typeof node === "object" && !Array.isArray(node)) walk(node as SkillNode, "");
  }
  if (choices.length === 0) throw new Error("Could not read the OASF skill taxonomy.");
  return { choices, categories };
}

/** Flattens the OASF 1.0.0 skill_categories document into captioned skills. */
export function skillChoicesFromTaxonomy(tree: unknown): SkillChoice[] {
  return readSkillTaxonomy(tree).choices;
}

let catalogTask: Promise<SkillChoice[]> | null = null;
const names = new Map<number, string>();
const categoryCaptions = new Map<number, string>();

export function loadSkillCatalog(): Promise<SkillChoice[]> {
  if (!catalogTask) {
    catalogTask = fetch(TAXONOMY_URL, { signal: AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not read the OASF skill taxonomy.");
        const read = readSkillTaxonomy(await response.json());
        categoryCaptions.clear();
        for (const category of read.categories) categoryCaptions.set(category.id, category.caption);
        return read.choices;
      })
      .catch((error: unknown) => {
        catalogTask = null;
        throw error instanceof Error ? error : new Error("Could not read the OASF skill taxonomy.");
      });
  }
  return catalogTask;
}

export async function categoryCaption(id: number): Promise<string | null> {
  await loadSkillCatalog();
  return categoryCaptions.get(id) ?? null;
}

export async function resolveSkillName(id: number): Promise<string> {
  const cached = names.get(id);
  if (cached) return cached;
  await loadSkillCatalog();
  const category = categoryCaptions.get(id);
  if (category) throw new Error(`${category} is a category. Choose a skill inside it.`);
  const skill = (await loadSkillCatalog()).find((item) => item.id === id);
  if (!skill) throw new SkillUnknownError(id);
  names.set(id, skill.name);
  return skill.name;
}

export async function resolveSkillNames(ids: number[]): Promise<Map<number, string>> {
  const taxonomy = new Map<number, string>();
  for (const id of ids) taxonomy.set(id, await resolveSkillName(id));
  return taxonomy;
}
