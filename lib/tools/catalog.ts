export const PLATFORM_TOOLS = ["read_skill", "read_skill_file", "list_workspace", "read_workspace", "search_workspace", "write_workspace", "stage_owner_file", "propose_memory", "run_entry"] as const;

export const MONEY_TOOLS = ["pay", "hire", "authorize", "capture", "void", "transfer", "discover", "message", "deliver"] as const;

export type ToolApproval = "preapproved" | "required";

export type ToolGrant = {
  name: string;
  approval: ToolApproval;
};

const DEFERRED = {
  type: "object",
  additionalProperties: false,
} as const;

export function nativeToolDefinitions(granted: string[]): Record<string, unknown>[] {
  const allowed = new Set(granted);
  const tools: Record<string, unknown>[] = [
    {
      type: "tool_search",
      execution: "client",
      description: "Search this agent's granted tools.",
      parameters: {
        ...DEFERRED,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ];
  const catalog: Record<string, Record<string, unknown>> = {
    read_skill: {
      type: "function",
      name: "read_skill",
      description: "Load one active skill's instructions.",
      defer_loading: true,
      parameters: { ...DEFERRED, properties: { name: { type: "string" } }, required: ["name"] },
    },
    read_skill_file: {
      type: "function",
      name: "read_skill_file",
      description: "Read one file from an active skill revision.",
      defer_loading: true,
      parameters: {
        ...DEFERRED,
        properties: { name: { type: "string" }, path: { type: "string" } },
        required: ["name", "path"],
      },
    },
    list_workspace: {
      type: "function",
      name: "list_workspace",
      description: "List workspace paths.",
      defer_loading: true,
      parameters: { ...DEFERRED, properties: {}, required: [] },
    },
    read_workspace: {
      type: "function",
      name: "read_workspace",
      description: "Read one workspace file by path. Use this for knowledge and daily logs.",
      defer_loading: true,
      parameters: { ...DEFERRED, properties: { path: { type: "string" } }, required: ["path"] },
    },
    search_workspace: {
      type: "function",
      name: "search_workspace",
      description: "Find workspace files by keyword or date.",
      defer_loading: true,
      parameters: { ...DEFERRED, properties: { query: { type: "string" } }, required: ["query"] },
    },
    write_workspace: {
      type: "function",
      name: "write_workspace",
      description: "Write an approved file under skills/proposals, projects, files, knowledge, or today's daily log. Root files and installed skills stay with the owner.",
      defer_loading: true,
      parameters: {
        ...DEFERRED,
        properties: { path: { type: "string" }, text: { type: "string" } },
        required: ["path", "text"],
      },
    },
    stage_owner_file: {
      type: "function",
      name: "stage_owner_file",
      description: "Stage the complete new text of a file the owner edits. This does not save. The owner saves it by saying confirm save.",
      defer_loading: true,
      parameters: {
        ...DEFERRED,
        properties: { path: { type: "string" }, text: { type: "string" } },
        required: ["path", "text"],
      },
    },
    propose_memory: {
      type: "function",
      name: "propose_memory",
      description: "Propose a curated fact. It is not stored until the owner confirms it.",
      defer_loading: true,
      parameters: { ...DEFERRED, properties: { fact: { type: "string" } }, required: ["fact"] },
    },
    run_entry: {
      type: "function",
      name: "run_entry",
      description: "Run an approved skill entry script.",
      defer_loading: true,
      parameters: {
        ...DEFERRED,
        properties: { skill: { type: "string" }, path: { type: "string" } },
        required: ["skill", "path"],
      },
    },
  };
  for (const name of PLATFORM_TOOLS) {
    if (allowed.has(name)) tools.push(catalog[name]);
  }
  return tools;
}

export function moneyTool(name: string): boolean {
  return (MONEY_TOOLS as readonly string[]).includes(name);
}

export function grantsForActiveSkills(installs: { state: string; grants: string[] }[]): ToolGrant[] {
  const grants: ToolGrant[] = [];
  const seen = new Set<string>();
  const active = installs.filter((install) => install.state === "active");
  if (active.length > 0) {
    for (const name of ["read_skill", "read_skill_file", "list_workspace"] as const) {
      grants.push({ name, approval: "preapproved" });
      seen.add(name);
    }
  }
  for (const install of active) {
    for (const name of install.grants) {
      if (seen.has(name) || moneyTool(name)) continue;
      seen.add(name);
      const approval = name === "run_entry" || name === "write_workspace" ? "required" : "preapproved";
      grants.push({ name, approval });
    }
  }
  return grants;
}
