import { sha256, toBytes } from "viem";
import { scanSkillText } from "../gateway/firewall";

export type SkillFile = { path: string; text: string; hash: string };

export type SkillRisk = "low" | "medium" | "high";

export type SkillDependency = { name: string; range: string };

export type SkillWorkflowStep = {
  id: string;
  tool: string;
  script?: string;
  read?: string;
  after: string[];
  when: string;
};

export type SkillManifest = {
  formatVersion: 1;
  version: string;
  depends: SkillDependency[];
  requests: { tools: string[]; mcp: string[]; network: "none" | string[]; secrets: string[] };
  risk: SkillRisk;
  entry: string[];
  workflow: SkillWorkflowStep[];
  advertise: number[];
};

export type ValidSkill = {
  name: string;
  description: string;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
  allowedToolsHint: string[];
  body: string;
  manifest: SkillManifest;
  files: SkillFile[];
  revisionId: string;
};

const COMMERCE = new Set(["discover", "message", "hire", "deliver", "pay", "authorize", "capture", "void", "transfer"]);
const EXECUTABLE = /\.(py|sh|bash|js|mjs|cjs)$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const RANGE = /^(?:\^|~)?\d+\.\d+\.\d+$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function contentHash(text: string): string {
  return sha256(toBytes(text)).slice(2);
}

export function revisionId(files: { path: string; text: string }[]): string {
  const sorted = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const payload = sorted.map((file) => `${file.path}\n${file.text.length}\n${file.text}`).join("\n");
  return sha256(toBytes(payload)).slice(2);
}

function fail(message: string): never {
  throw new Error(message);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(markdown: string): { data: Record<string, unknown>; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) fail("SKILL.md needs frontmatter.");
  const end = normalized.search(/\r?\n---\r?\n|\r?\n---$/);
  if (end < 0) fail("SKILL.md frontmatter is not closed.");
  const raw = normalized.slice(normalized.indexOf("\n") + 1, end);
  const body = normalized.slice(end).replace(/^\r?\n---\r?\n?/, "");
  return { data: parseYamlMap(raw), body };
}

function parseYamlMap(raw: string): Record<string, unknown> {
  const lines = raw.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) fail("SKILL.md frontmatter is invalid.");
    const key = match[1] ?? "";
    const rest = match[2] ?? "";
    if (rest === "") {
      const nested: Record<string, string> = {};
      index += 1;
      while (index < lines.length && /^\s+\S/.test(lines[index] ?? "")) {
        const child = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index] ?? "");
        if (!child) fail("SKILL.md frontmatter is invalid.");
        nested[child[1] ?? ""] = unquote(child[2] ?? "");
        index += 1;
      }
      root[key] = nested;
      continue;
    }
    if (rest === "|" || rest === ">") {
      const block: string[] = [];
      index += 1;
      while (index < lines.length && (/^\s+\S/.test(lines[index] ?? "") || (lines[index] ?? "") === "")) {
        block.push((lines[index] ?? "").replace(/^\s{2}/, ""));
        index += 1;
      }
      root[key] = block.join("\n").trim();
      continue;
    }
    root[key] = unquote(rest);
    index += 1;
  }
  return root;
}

function assertRelative(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) fail("A skill path must stay inside the package.");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("A skill path must stay inside the package.");
  if (parts.length > 2) fail("Skill file references stay one level deep.");
  return parts;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be a list.`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) fail(`${label} must be strings.`);
    return item.trim();
  });
}

function parseManifest(text: string, files: Map<string, string>, metadataVersion: string): SkillManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("muselancer.manifest.json is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("muselancer.manifest.json is not an object.");
  const record = parsed as Record<string, unknown>;
  if (record.formatVersion !== 1) fail("Skill manifest formatVersion must be 1.");
  if (typeof record.version !== "string" || !SEMVER.test(record.version)) fail("Skill version must be semver.");
  if (record.version !== metadataVersion) fail("The manifest version must match metadata.version.");
  const dependsRaw = record.depends ?? [];
  if (!Array.isArray(dependsRaw)) fail("Skill dependencies must be a list.");
  const depends = dependsRaw.map((item) => {
    if (!item || typeof item !== "object") fail("A skill dependency is incomplete.");
    const dep = item as Record<string, unknown>;
    const name = typeof dep.name === "string" ? dep.name : "";
    const range = typeof dep.range === "string" ? dep.range : "";
    if (!SKILL_NAME.test(name)) fail("A skill dependency name is invalid.");
    if (!RANGE.test(range)) fail("Activation does not follow a floating tag.");
    return { name, range };
  });
  const requestsRaw = record.requests;
  if (!requestsRaw || typeof requestsRaw !== "object" || Array.isArray(requestsRaw)) fail("Skill requests are missing.");
  const requests = requestsRaw as Record<string, unknown>;
  const tools = stringList(requests.tools ?? [], "Requested tools");
  const mcp = stringList(requests.mcp ?? [], "Requested MCP servers");
  for (const tool of tools) {
    if (COMMERCE.has(tool)) fail("A skill cannot request a commerce action.");
  }
  let network: "none" | string[] = "none";
  if (requests.network !== "none") {
    if (!requests.network || typeof requests.network !== "object" || Array.isArray(requests.network)) fail("Skill network must be none or an allowlist.");
    const allow = stringList((requests.network as Record<string, unknown>).allow ?? [], "Network allowlist");
    if (allow.length > 8 || allow.some((host) => !/^[a-z0-9.-]+$/.test(host))) fail("Skill network allowlist is invalid.");
    network = allow;
  }
  const secrets = stringList(requests.secrets ?? [], "Secret names");
  if (secrets.some((name) => !/^[A-Z0-9_]+$/.test(name))) fail("A secret name is invalid.");
  const risk = record.risk;
  if (risk !== "low" && risk !== "medium" && risk !== "high") fail("Skill risk must be low, medium, or high.");
  const entry = stringList(record.entry ?? [], "Skill entry");
  for (const path of entry) {
    assertRelative(path);
    if (!path.startsWith("scripts/") || !files.has(path)) fail("A skill entry must be a script inside this revision.");
  }
  for (const [path] of files) {
    if (path.startsWith("scripts/") && EXECUTABLE.test(path) && !entry.includes(path)) {
      fail("An executable is outside the entry list.");
    }
  }
  const workflowRaw = record.workflow ?? [];
  if (!Array.isArray(workflowRaw)) fail("Skill workflow must be a list.");
  if (workflowRaw.length > 20) fail("Skill workflow is too long.");
  const workflow: SkillWorkflowStep[] = [];
  const seen = new Set<string>();
  for (const item of workflowRaw) {
    if (!item || typeof item !== "object") fail("A workflow step is incomplete.");
    const step = item as Record<string, unknown>;
    const id = typeof step.id === "string" ? step.id.trim() : "";
    const tool = typeof step.tool === "string" ? step.tool.trim() : "";
    if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) fail("A workflow step id is invalid.");
    seen.add(id);
    if (!tool || COMMERCE.has(tool)) fail("A workflow step cannot use a commerce action.");
    if (tool !== "model" && !tools.includes(tool)) fail("A workflow step tool must be requested by the skill.");
    const script = typeof step.script === "string" ? step.script : undefined;
    const read = typeof step.read === "string" ? step.read : undefined;
    if (tool === "run_entry" && (!script || !entry.includes(script))) fail("A workflow script must be an approved entry.");
    if (read) {
      assertRelative(read);
      if (!files.has(read)) fail("A workflow read must stay inside this revision.");
    }
    const after = stringList(step.after ?? [], "Workflow order");
    if (after.some((ref) => !seen.has(ref) || ref === id)) fail("A workflow step depends on an unknown step.");
    const when = typeof step.when === "string" && step.when.trim() ? step.when.trim() : "always";
    if (when.length > 80) fail("A workflow condition is too long.");
    workflow.push({ id, tool, script, read, after, when });
  }
  const advertiseRaw = record.advertise ?? [];
  if (!Array.isArray(advertiseRaw)) fail("Advertised taxonomy ids must be a list.");
  const advertise = advertiseRaw.map((id) => {
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) fail("An advertised taxonomy id must be a positive integer.");
    return id;
  });
  if (advertise.length > 8) fail("Too many advertised taxonomy ids.");
  return { formatVersion: 1, version: record.version, depends, requests: { tools, mcp, network, secrets }, risk, entry, workflow, advertise };
}

export function validateSkillPackage(files: { path: string; text: string }[], directoryName = ""): ValidSkill {
  if (files.length === 0 || files.length > 32) fail("A skill package needs at least one file.");
  const mapped = new Map<string, string>();
  let total = 0;
  for (const file of files) {
    if (typeof file.text !== "string" || file.text.length > 64_000) fail("A skill file is too large.");
    total += file.text.length;
    const parts = assertRelative(file.path);
    const path = parts.join("/");
    if (mapped.has(path)) fail("A skill package has a duplicate path.");
    const top = parts[0] ?? "";
    const allowedTop = top === "SKILL.md" || top === "muselancer.manifest.json" || top === "scripts" || top === "references" || top === "assets";
    if (!allowedTop) fail("A skill file must be SKILL.md, the manifest, scripts, references, or assets.");
    const scan = scanSkillText(file.text);
    if (!scan.allow) fail(scan.reason);
    mapped.set(path, file.text);
  }
  if (total > 256_000) fail("This skill package is too large.");
  const markdown = mapped.get("SKILL.md");
  const manifestText = mapped.get("muselancer.manifest.json");
  if (markdown === undefined || manifestText === undefined) fail("A skill package needs SKILL.md and muselancer.manifest.json.");
  const front = parseFrontmatter(markdown);
  const name = typeof front.data.name === "string" ? front.data.name : "";
  const description = typeof front.data.description === "string" ? front.data.description.trim() : "";
  if (!SKILL_NAME.test(name) || name.length > 64) fail("The skill name must be lowercase letters, numbers, and hyphens.");
  if (directoryName && directoryName !== name) fail("The skill name must match its directory.");
  if (!description || description.length > 1024) fail("The skill description must say what it does and when to use it.");
  const license = typeof front.data.license === "string" ? front.data.license : "";
  const compatibility = typeof front.data.compatibility === "string" ? front.data.compatibility : "";
  if (license.length > 200) fail("The skill license is too long.");
  if (compatibility.length > 500) fail("The skill compatibility note is too long.");
  const metadataRaw = front.data.metadata ?? {};
  if (!metadataRaw || typeof metadataRaw !== "object" || Array.isArray(metadataRaw)) fail("Skill metadata must be a string map.");
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadataRaw)) {
    if (typeof value !== "string") fail("Skill metadata values must be strings.");
    metadata[key] = value;
  }
  if (!metadata.version) fail("Copy the manifest version into metadata.version.");
  const allowedToolsHint = typeof front.data["allowed-tools"] === "string"
    ? front.data["allowed-tools"].split(/\s+/).filter(Boolean)
    : [];
  const lines = front.body.split(/\r?\n/).length;
  if (lines > 500) fail("SKILL.md must stay under 500 lines.");
  if (front.body.includes("](") && /\]\([^)]+\/[^)]+\/[^)]+\)/.test(front.body)) {
    fail("Skill file references stay one level deep.");
  }
  const manifest = parseManifest(manifestText, mapped, metadata.version);
  if (manifest.depends.some((dep) => dep.name === name)) fail("A skill cannot depend on itself.");
  const stored = [...mapped.entries()].map(([path, text]) => ({ path, text, hash: contentHash(text) }));
  return {
    name,
    description,
    license,
    compatibility,
    metadata,
    allowedToolsHint,
    body: front.body,
    manifest,
    files: stored.sort((left, right) => (left.path < right.path ? -1 : 1)),
    revisionId: revisionId(stored.map(({ path, text }) => ({ path, text }))),
  };
}
