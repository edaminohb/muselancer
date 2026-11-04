import { getAddress } from "viem";
import type { SkillDependency, SkillRisk } from "./package";

export type SkillSource = "upload" | "authored" | "generated" | "imported";
export type SkillState = "proposed" | "active" | "disabled" | "removed";

export type SkillInstall = {
  agentId: string;
  name: string;
  owner: string;
  revisionId: string;
  version: string;
  state: SkillState;
  publisher: string;
  source: SkillSource;
  signature: string;
  grants: string[];
  requests: string[];
  risk: SkillRisk;
  history: string[];
  pendingRevisionId: string | null;
};

export type RevisionFacts = {
  revisionId: string;
  version: string;
  requests: string[];
  risk: SkillRisk;
  depends: SkillDependency[];
};

const SOURCES = new Set<SkillSource>(["upload", "authored", "generated", "imported"]);

export function assertSkillOwner(installOwner: string, caller: string): void {
  if (getAddress(installOwner) !== getAddress(caller)) throw new Error("Only the owner of this agent can install a skill.");
}

/** Model text is never an install action. */
export function installFromModelText(_text: string): never {
  throw new Error("The model cannot change a skill install.");
}

function versionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error("Skill version must be semver.");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: string, right: string): number {
  const [a, b, c] = versionParts(left);
  const [d, e, f] = versionParts(right);
  if (a !== d) return a - d;
  if (b !== e) return b - e;
  return c - f;
}

export function semverSatisfies(version: string, range: string): boolean {
  if (!/^(?:\^|~)?\d+\.\d+\.\d+$/.test(range)) throw new Error("Activation does not follow a floating tag.");
  const floor = range.replace(/^[\^~]/, "");
  if (compareSemver(version, floor) < 0) return false;
  const [major, minor] = versionParts(version);
  const [floorMajor, floorMinor] = versionParts(floor);
  if (range.startsWith("^")) return major === floorMajor;
  if (range.startsWith("~")) return major === floorMajor && minor === floorMinor;
  return version === floor;
}

export function intersectGrants(requests: string[], ownerGrants: string[]): string[] {
  const allowed = new Set(requests);
  const seen = new Set<string>();
  const grants: string[] = [];
  for (const grant of ownerGrants) {
    if (!allowed.has(grant) || seen.has(grant)) continue;
    seen.add(grant);
    grants.push(grant);
  }
  return grants;
}

function remember(history: string[], revisionId: string): string[] {
  return history.includes(revisionId) ? history : [...history, revisionId];
}

export function proposeInstall(existing: SkillInstall | null, input: {
  agentId: string;
  name: string;
  owner: string;
  source: SkillSource;
  revision: RevisionFacts;
}): SkillInstall {
  if (!SOURCES.has(input.source)) throw new Error("Choose how this skill was acquired.");
  const owner = getAddress(input.owner);
  if (existing) assertSkillOwner(existing.owner, owner);
  const history = remember(existing?.history ?? [], input.revision.revisionId);
  if (!existing || existing.state === "removed" || existing.state === "proposed") {
    return {
      agentId: input.agentId,
      name: input.name,
      owner,
      revisionId: input.revision.revisionId,
      version: input.revision.version,
      state: "proposed",
      publisher: owner,
      source: input.source,
      signature: "",
      grants: [],
      requests: input.revision.requests,
      risk: input.revision.risk,
      history,
      pendingRevisionId: null,
    };
  }
  return {
    ...existing,
    source: input.source,
    history,
    pendingRevisionId: input.revision.revisionId,
  };
}

export function assertDependencies(depends: SkillDependency[], active: { name: string; version: string; state: SkillState }[]): void {
  for (const dep of depends) {
    const found = active.find((item) => item.name === dep.name && item.state === "active");
    if (!found || !semverSatisfies(found.version, dep.range)) throw new Error(`Dependency ${dep.name} is not active.`);
  }
}

export function activateInstall(install: SkillInstall, input: {
  caller: string;
  revision: RevisionFacts;
  ownerGrants: string[];
  active: { name: string; version: string; state: SkillState }[];
}): SkillInstall {
  assertSkillOwner(install.owner, input.caller);
  if (!install.history.includes(input.revision.revisionId)) throw new Error("That revision is not in this skill's history.");
  assertDependencies(input.revision.depends, input.active.filter((item) => item.name !== install.name));
  return {
    ...install,
    state: "active",
    revisionId: input.revision.revisionId,
    version: input.revision.version,
    requests: input.revision.requests,
    risk: input.revision.risk,
    grants: intersectGrants(input.revision.requests, input.ownerGrants),
    pendingRevisionId: install.pendingRevisionId === input.revision.revisionId ? null : install.pendingRevisionId,
    signature: "",
  };
}

export function disableInstall(install: SkillInstall, caller: string): SkillInstall {
  assertSkillOwner(install.owner, caller);
  if (install.state !== "active") throw new Error("Only an active skill can be disabled.");
  return { ...install, state: "disabled" };
}

export function removeInstall(install: SkillInstall, caller: string): SkillInstall {
  assertSkillOwner(install.owner, caller);
  if (install.state === "removed") throw new Error("That skill is already removed.");
  return { ...install, state: "removed", grants: [], pendingRevisionId: null };
}

export function rollbackInstall(install: SkillInstall, input: {
  caller: string;
  revision: RevisionFacts;
  ownerGrants: string[];
  active: { name: string; version: string; state: SkillState }[];
}): SkillInstall {
  return activateInstall(install, input);
}
