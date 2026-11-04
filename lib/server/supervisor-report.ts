import { scanUntrusted } from "../gateway/firewall";

export const SUPERVISOR_ROLE = "Role: supervisor";

/** Instructions written when the supervisor agent is created. They do not include a wallet key. */
export function supervisorJobFiles(name: string): { path: string; text: string }[] {
  const title = name.trim() || "Muselancer supervisor";
  return [
    {
      path: "AGENTS.md",
      text: `# How ${title} works

${SUPERVISOR_ROLE}

You are the supervisor for a hire. You are not the hiring agent and not the hired agent.
The deal text tells you the brief, the clarifications, the limits, and the deadline.
Read the delivery in private. Describe what it is in one short paragraph. For a page of HTML, say that it is HTML that appears to be a website or a landing page.
Do not quote the delivery. Do not include keys, passwords, or private text.
Suggest confirm, revise, or reject. The suggestion is advice. The hirer chooses confirm, send back, or reject.
`,
    },
    {
      path: "SOUL.md",
      text: `# Soul

${SUPERVISOR_ROLE}

Personality: Careful and specific. You describe the kind of work and you do not reveal it.
`,
    },
    {
      path: "IDENTITY.md",
      text: `# Identity

${SUPERVISOR_ROLE}

Name: ${title}
Description: Reviews a delivery in private and describes it for the hirer.
`,
    },
  ];
}

/** The supervisor's own public instructions. Owner notes and memory stay out. */
export function supervisorGuidance(files: { path: string; text: string }[]): string {
  const allowed = new Set(["AGENTS.md", "SOUL.md", "IDENTITY.md"]);
  return files
    .filter((file) => allowed.has(file.path))
    .map((file) => `# ${file.path}\n${file.text.trim().slice(0, 1600)}`)
    .join("\n\n")
    .slice(0, 5000);
}

/** The supervisor agent reads the delivery. The hirer sees only the description. */
export function reviewInstruction(criteria: string, evidence: string, guidance = ""): string {
  return [
    "You are the supervisor agent for this deal. You are not the hiring agent and not the hired agent.",
    "The terms are already agreed and the USDC is locked. You describe the delivery. The hirer confirms, sends it back, or rejects it.",
    "The task below is this deal. Use it to understand the work that was agreed.",
    "Follow your instructions below. They tell you how to review.",
    "Write one short description of what the delivery is.",
    "Name the kind of work. For a page of HTML, say that it is HTML that appears to be a website or a landing page.",
    "Do not quote the delivery. Do not include keys, passwords, secrets, or private text.",
    "Suggest confirm, revise, or reject. The suggestion is advice. The hirer chooses.",
    guidance ? `Your instructions:\n${guidance}` : "",
    `Deal:\n${criteria}`,
    `Delivery:\n${evidence}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Keep a description that does not repeat the delivery or carry secret material. */
export function acceptSupervisorReport(summary: string, evidence: string): string | null {
  const text = summary.replace(/\s+/g, " ").trim();
  if (text.length < 12 || text.length > 400) return null;
  if (!scanUntrusted(text).allow) return null;
  if (/0x[0-9a-fA-F]{32,}/.test(text) || /sk-[A-Za-z0-9]/.test(text)) return null;
  const compact = evidence.replace(/\s+/g, " ");
  for (let index = 0; index + 48 <= compact.length; index += 16) {
    const slice = compact.slice(index, index + 48);
    if (text.includes(slice)) return null;
  }
  return text;
}

export type SupervisorSuggestion = "confirm" | "revise" | "reject";

/** The suggestion is advice. An unknown value is dropped, and the hirer still chooses. */
export function acceptSupervisorSuggestion(value: string): SupervisorSuggestion | null {
  if (value === "confirm" || value === "revise" || value === "reject") return value;
  return null;
}

export function supervisorSuggestionNote(suggestion: string | null | undefined): string {
  if (suggestion === "confirm") return "The supervisor suggests you confirm.";
  if (suggestion === "revise") return "The supervisor suggests you send it back.";
  if (suggestion === "reject") return "The supervisor suggests you reject.";
  return "";
}
