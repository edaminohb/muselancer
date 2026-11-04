import { getAddress } from "viem";
import { readDocument, writeDocument } from "../db";
import {
  activateInstall,
  disableInstall,
  proposeInstall,
  removeInstall,
  rollbackInstall,
  type SkillInstall,
  type SkillSource,
} from "../skills/install";
import { validateSkillPackage, type ValidSkill } from "../skills/package";
import { guidanceSkillFiles } from "../skills/guidance";
import { grantsForActiveSkills, type ToolGrant } from "../tools/catalog";
import { placeSkillTree } from "../workspace/snapshot";
import { ownedAgent } from "./register";
import { commitWorkspace } from "./workspace";

export class SkillError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const SOURCES = new Set<SkillSource>(["upload", "authored", "generated", "imported"]);

function installKey(agentId: string, name: string): string {
  return `skill-install:${agentId}:${name}`;
}

function revisionKey(revisionId: string): string {
  return `skill-revision:${revisionId}`;
}

function namesKey(agentId: string): string {
  return `skill-names:${agentId}`;
}

async function requireOwned(owner: string, agentId: string): Promise<void> {
  if (!/^\d+$/.test(agentId) || agentId === "0") throw new SkillError("Agent id must be a positive integer.", 400);
  const agent = await ownedAgent(owner, agentId);
  if (!agent) throw new SkillError("Agent not found.", 404);
}

async function readNames(agentId: string): Promise<string[]> {
  const raw = await readDocument(namesKey(agentId));
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

async function readInstall(agentId: string, name: string): Promise<SkillInstall | null> {
  const raw = await readDocument(installKey(agentId, name));
  if (!raw) return null;
  return JSON.parse(raw) as SkillInstall;
}

async function writeInstall(install: SkillInstall): Promise<void> {
  await writeDocument(installKey(install.agentId, install.name), JSON.stringify(install));
  const names = await readNames(install.agentId);
  if (!names.includes(install.name)) await writeDocument(namesKey(install.agentId), JSON.stringify([...names, install.name]));
}

async function storeRevision(skill: ValidSkill): Promise<void> {
  await writeDocument(revisionKey(skill.revisionId), JSON.stringify(skill));
}

export async function readRevision(revisionId: string): Promise<ValidSkill | null> {
  const raw = await readDocument(revisionKey(revisionId));
  if (!raw) return null;
  return JSON.parse(raw) as ValidSkill;
}

async function syncInstalledFiles(agentId: string, installs: SkillInstall[]): Promise<void> {
  const placed: { folder: "active" | "disabled" | "proposals"; name: string; files: { path: string; text: string }[] }[] = [];
  for (const install of installs) {
    const folders: { folder: "active" | "disabled" | "proposals"; revisionId: string }[] = [];
    if (install.state === "active") folders.push({ folder: "active", revisionId: install.revisionId });
    if (install.state === "disabled") folders.push({ folder: "disabled", revisionId: install.revisionId });
    if (install.state === "proposed") folders.push({ folder: "proposals", revisionId: install.revisionId });
    if (install.pendingRevisionId) folders.push({ folder: "proposals", revisionId: install.pendingRevisionId });
    for (const folder of folders) {
      const revision = await readRevision(folder.revisionId);
      if (!revision) continue;
      placed.push({ folder: folder.folder, name: install.name, files: revision.files.map(({ path, text }) => ({ path, text })) });
    }
  }
  await commitWorkspace(agentId, (current) => placeSkillTree(current, placed, installs.map((install) => install.name)), "owner");
}

function filesFrom(command: Record<string, unknown>): { path: string; text: string }[] {
  if (!Array.isArray(command.files)) throw new SkillError("Choose the skill files.", 400);
  return command.files.map((item) => {
    if (!item || typeof item !== "object") throw new SkillError("Choose the skill files.", 400);
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.text !== "string") throw new SkillError("Choose the skill files.", 400);
    return { path: file.path, text: file.text };
  });
}

function sourceFrom(command: Record<string, unknown>): SkillSource {
  const source = command.source;
  if (typeof source !== "string" || !SOURCES.has(source as SkillSource)) throw new SkillError("Choose how this skill was acquired.", 400);
  return source as SkillSource;
}

function grantsFrom(command: Record<string, unknown>): string[] {
  if (!Array.isArray(command.grants)) return [];
  return command.grants.filter((item): item is string => typeof item === "string");
}

export async function readOwnedSkills(owner: string, agentId: string): Promise<{ installs: SkillInstall[]; revisions: Record<string, ValidSkill> }> {
  await requireOwned(owner, agentId);
  const names = await readNames(agentId);
  const installs: SkillInstall[] = [];
  const revisions: Record<string, ValidSkill> = {};
  for (const name of names) {
    const install = await readInstall(agentId, name);
    if (!install) continue;
    if (getAddress(install.owner) !== getAddress(owner)) continue;
    installs.push(install);
    for (const revisionId of [install.revisionId, install.pendingRevisionId].filter((item): item is string => Boolean(item))) {
      const revision = await readRevision(revisionId);
      if (revision) revisions[revisionId] = revision;
    }
  }
  return { installs, revisions };
}

export async function activeSkills(agentId: string): Promise<ValidSkill[]> {
  const names = await readNames(agentId);
  const skills: ValidSkill[] = [];
  for (const name of names) {
    const install = await readInstall(agentId, name);
    if (!install || install.state !== "active") continue;
    const revision = await readRevision(install.revisionId);
    if (revision) skills.push(revision);
  }
  return skills;
}

/** Grants the owner already chose. A specialty agent does not receive a script or a workspace write. */
export async function chatSkillGrants(agentId: string, allowScripts: boolean): Promise<ToolGrant[]> {
  const names = await readNames(agentId);
  const installs: { state: string; grants: string[] }[] = [];
  for (const name of names) {
    const install = await readInstall(agentId, name);
    if (!install) continue;
    const grants = allowScripts ? install.grants : install.grants.filter((grant) => grant !== "run_entry" && grant !== "write_workspace");
    installs.push({ state: install.state, grants });
  }
  return grantsForActiveSkills(installs);
}

/** The owner asked in this conversation. The package is guidance only: no script and no commerce tool. */
export async function addGuidanceSkill(owner: string, agentId: string, input: { name: string; description: string; instructions: string }): Promise<string> {
  const files = guidanceSkillFiles(input);
  const proposed = await handleSkill(owner, agentId, { action: "propose", source: "generated", files });
  await handleSkill(owner, agentId, {
    action: "activate",
    name: proposed.name,
    revisionId: proposed.pendingRevisionId || proposed.revisionId,
    grants: [],
  });
  return `Added ${proposed.name}. It is active. No script was granted. You can disable it on Skills.`;
}

export async function handleSkill(owner: string, agentId: string, body: unknown): Promise<SkillInstall> {
  await requireOwned(owner, agentId);
  const command = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const action = typeof command.action === "string" ? command.action : "";
  if (action === "propose") {
    const skill = validateSkillPackage(filesFrom(command), typeof command.directoryName === "string" ? command.directoryName : "");
    await storeRevision(skill);
    const existing = await readInstall(agentId, skill.name);
    const install = proposeInstall(existing, {
      agentId,
      name: skill.name,
      owner,
      source: sourceFrom(command),
      revision: { revisionId: skill.revisionId, version: skill.manifest.version, requests: skill.manifest.requests.tools, risk: skill.manifest.risk, depends: skill.manifest.depends },
    });
    await writeInstall(install);
    await syncInstalledFiles(agentId, (await readOwnedSkills(owner, agentId)).installs);
    return install;
  }
  const name = typeof command.name === "string" ? command.name : "";
  const existing = name ? await readInstall(agentId, name) : null;
  if (!existing) throw new SkillError("That skill is not installed.", 404);
  const installs = (await readOwnedSkills(owner, agentId)).installs;
  const active = installs.map((install) => ({ name: install.name, version: install.version, state: install.state }));
  let next = existing;
  if (action === "activate" || action === "rollback") {
    const revisionId = typeof command.revisionId === "string" && command.revisionId ? command.revisionId : existing.pendingRevisionId || existing.revisionId;
    const revision = await readRevision(revisionId);
    if (!revision) throw new SkillError("That revision is not in this skill's history.", 400);
    const change = action === "rollback" ? rollbackInstall : activateInstall;
    next = change(existing, {
      caller: owner,
      ownerGrants: grantsFrom(command),
      active,
      revision: { revisionId: revision.revisionId, version: revision.manifest.version, requests: revision.manifest.requests.tools, risk: revision.manifest.risk, depends: revision.manifest.depends },
    });
  } else if (action === "disable") {
    next = disableInstall(existing, owner);
  } else if (action === "remove") {
    next = removeInstall(existing, owner);
  } else {
    throw new SkillError("Choose a skill action.", 400);
  }
  await writeInstall(next);
  const refreshed = (await readOwnedSkills(owner, agentId)).installs;
  await syncInstalledFiles(agentId, refreshed);
  return next;
}

export function skillFailure(error: unknown): { message: string; status: number } {
  if (error instanceof SkillError) return { message: error.message, status: error.status };
  const message = error instanceof Error ? error.message : "Could not update this skill.";
  return { message, status: 400 };
}
