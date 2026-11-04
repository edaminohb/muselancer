import { recordNameAllowed } from "./origin";

export type OasfSkill = { id: number; name?: string };

export type OasfRecord = {
  name: string;
  version: string;
  schemaVersion: string;
  description: string;
  skills: OasfSkill[];
  locators: { type: string; url: string }[];
  authors: string[];
  extensions: { name: string; data: { agentId: string; agentWallet: string; owner: string } }[];
};

export function buildOasfRecord(input: {
  nameUrl: string;
  description: string;
  skillIds: number[];
  agentId: string;
  agentWallet: string;
  owner: string;
  oasfCid: string;
  locator?: { type: string; url: string };
}): OasfRecord {
  return {
    name: input.nameUrl.trim(),
    version: "0.1.0",
    schemaVersion: "1.0.0",
    description: input.description.trim(),
    skills: input.skillIds.map((id) => ({ id })),
    locators: [input.locator ?? { type: "ipfs", url: `ipfs://${input.oasfCid}` }],
    authors: [input.owner],
    extensions: [
      {
        name: "muselancer.identity",
        data: {
          agentId: input.agentId,
          agentWallet: input.agentWallet,
          owner: input.owner,
        },
      },
    ],
  };
}

export function validateOasf(record: OasfRecord): string | null {
  if (!recordNameAllowed(record.name)) return "OASF name must use an https origin or localhost.";
  if (!record.description.trim() || record.description.length > 280) {
    return "Description must be 1–280 characters.";
  }
  if (!record.skills.length) return "At least one OASF taxonomy skill id is required.";
  for (const skill of record.skills) {
    if (!Number.isInteger(skill.id) || skill.id <= 0) return "Skill id must be a positive integer.";
  }
  const ext = record.extensions.find((item) => item.name === "muselancer.identity");
  if (!ext?.data.agentId || !ext.data.agentWallet || !ext.data.owner) {
    return "The record must include the agent id, agent wallet, and owner.";
  }
  return null;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function jsonFailure(message: string): never {
  throw new Error(message);
}

function rejectLooseJson(raw: string): void {
  let index = 0;
  const sets: (Set<string> | null)[] = [];
  const skip = () => {
    while (index < raw.length && raw.charCodeAt(index) <= 32) index += 1;
  };
  const parseString = (): string => {
    if (raw[index] !== '"') jsonFailure("OASF record is not valid JSON.");
    index += 1;
    let out = "";
    while (index < raw.length) {
      const char = raw[index];
      if (char === '"') {
        index += 1;
        return out;
      }
      if (char === "\\") {
        const next = raw[index + 1];
        if (next === "u") {
          const hex = raw.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) jsonFailure("OASF record is not valid JSON.");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
          continue;
        }
        const escaped: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (next === undefined || escaped[next] === undefined) jsonFailure("OASF record is not valid JSON.");
        out += escaped[next];
        index += 2;
        continue;
      }
      if (char < " ") jsonFailure("OASF record is not valid JSON.");
      out += char;
      index += 1;
    }
    jsonFailure("OASF record is not valid JSON.");
  };
  const parseNumber = () => {
    const start = index;
    if (raw[index] === "-") index += 1;
    if (raw[index] === "0") index += 1;
    else if (raw[index] !== undefined && raw[index] >= "1" && raw[index] <= "9") {
      while (raw[index] !== undefined && raw[index] >= "0" && raw[index] <= "9") index += 1;
    } else jsonFailure("OASF record is not valid JSON.");
    if (raw[index] === "." || raw[index] === "e" || raw[index] === "E") jsonFailure("OASF record contains a non-integer number.");
    if (index === start || (raw[start] === "-" && index === start + 1)) jsonFailure("OASF record is not valid JSON.");
  };
  const parseValue = (): void => {
    skip();
    const char = raw[index];
    if (char === "{") {
      index += 1;
      sets.push(new Set());
      parseObject();
      return;
    }
    if (char === "[") {
      index += 1;
      sets.push(null);
      parseArray();
      return;
    }
    if (char === '"') {
      parseString();
      return;
    }
    if (char === "t") {
      if (raw.slice(index, index + 4) !== "true") jsonFailure("OASF record is not valid JSON.");
      index += 4;
      return;
    }
    if (char === "f") {
      if (raw.slice(index, index + 5) !== "false") jsonFailure("OASF record is not valid JSON.");
      index += 5;
      return;
    }
    if (char === "n") {
      if (raw.slice(index, index + 4) !== "null") jsonFailure("OASF record is not valid JSON.");
      index += 4;
      return;
    }
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) {
      parseNumber();
      return;
    }
    jsonFailure("OASF record is not valid JSON.");
  };
  const parseObject = () => {
    skip();
    if (raw[index] === "}") {
      index += 1;
      sets.pop();
      return;
    }
    while (index < raw.length) {
      skip();
      const key = parseString();
      const keys = sets[sets.length - 1];
      if (!(keys instanceof Set)) jsonFailure("OASF record is not valid JSON.");
      if (keys.has(key)) jsonFailure("OASF record contains a duplicate key.");
      keys.add(key);
      skip();
      if (raw[index] !== ":") jsonFailure("OASF record is not valid JSON.");
      index += 1;
      parseValue();
      skip();
      if (raw[index] === "}") {
        index += 1;
        sets.pop();
        return;
      }
      if (raw[index] !== ",") jsonFailure("OASF record is not valid JSON.");
      index += 1;
    }
    jsonFailure("OASF record is not valid JSON.");
  };
  const parseArray = () => {
    skip();
    if (raw[index] === "]") {
      index += 1;
      sets.pop();
      return;
    }
    while (index < raw.length) {
      parseValue();
      skip();
      if (raw[index] === "]") {
        index += 1;
        sets.pop();
        return;
      }
      if (raw[index] !== ",") jsonFailure("OASF record is not valid JSON.");
      index += 1;
    }
    jsonFailure("OASF record is not valid JSON.");
  };
  parseValue();
  skip();
  if (index !== raw.length) jsonFailure("OASF record is not valid JSON.");
}

/** Parses JSON that is already in canonical form, with no duplicate keys or fractional numbers. */
export function parseCanonicalJson(raw: string): unknown {
  rejectLooseJson(raw);
  const parsed: unknown = JSON.parse(raw);
  if (canonicalJson(parsed) !== raw) jsonFailure("OASF record is not canonical JSON.");
  return parsed;
}
