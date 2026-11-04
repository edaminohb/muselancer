import { scanUntrusted } from "../gateway/firewall";

/** Controls the owner must use before the agent can continue. */
export type OwnerAsk = {
  prompt: string;
  choices: string[];
  multiple: boolean;
  inputLabel: string;
};

export function ownerAskId(ask: OwnerAsk): string {
  return JSON.stringify([ask.prompt, ask.inputLabel, ask.multiple, ask.choices]);
}

export function ownerAskKey(agentId: string): string {
  return `owner-ask:${agentId}`;
}

/** A question with buttons, a multiple choice, a text field, or both. */
export function parseOwnerAsk(args: Record<string, unknown>): OwnerAsk | string {
  const prompt = typeof args.prompt === "string" ? args.prompt.replace(/\s+/g, " ").trim() : "";
  if (!prompt || prompt.length > 240) return "Ask in one short question.";
  const rawChoices = Array.isArray(args.choices) ? args.choices : [];
  const choices: string[] = [];
  for (const item of rawChoices) {
    if (typeof item !== "string") return "Each choice is a short label.";
    const label = item.replace(/\s+/g, " ").trim();
    if (!label || label.length > 80) return "Each choice is a short label.";
    if (label.toLowerCase() === "other") continue;
    if (choices.includes(label)) return "Each choice is different.";
    choices.push(label);
  }
  if (choices.length > 6) return "Ask for at most six choices.";
  const multiple = args.multiple === true;
  if (multiple && choices.length < 2) return "More than one choice needs at least two buttons.";
  const inputLabel = typeof args.input === "string" ? args.input.replace(/\s+/g, " ").trim() : "";
  if (inputLabel.length > 80) return "The text field label is too long.";
  if (choices.length === 0 && !inputLabel) return "Add a button or a text field.";
  const scan = scanUntrusted([prompt, inputLabel, ...choices].join("\n"));
  if (!scan.allow) return scan.reason;
  return { prompt, choices, multiple: multiple && choices.length > 1, inputLabel };
}

/** The owner's answer. Other is the text they typed, not the word Other. */
export function ownerAnswer(input: { picked: string[]; other: string; typed: string }): string {
  const custom = input.other.replace(/\s+/g, " ").trim();
  const notes = input.typed.replace(/\s+/g, " ").trim();
  const choices = input.picked.map((item) => item.trim()).filter(Boolean);
  if (custom) choices.push(custom);
  return [choices.join(", "), notes].filter(Boolean).join(". ");
}

export function readStoredAsk(raw: string | null): OwnerAsk | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as OwnerAsk;
    const ask = parseOwnerAsk({
      prompt: parsed.prompt,
      choices: parsed.choices,
      multiple: parsed.multiple,
      input: parsed.inputLabel,
    });
    return typeof ask === "string" ? null : ask;
  } catch {
    return null;
  }
}
