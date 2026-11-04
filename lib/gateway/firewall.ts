const INJECTION = [/ignore (all |any )?(prior|previous) instructions/i, /developer mode/i, /reveal (the |your )?system prompt/i];
const SECRET = [/LLM_[A-Za-z0-9_]+/, /PRIVATE KEY/i, /BEGIN (RSA |OPENSSH )?PRIVATE KEY/];

export type ScanDecision = { allow: boolean; reason: string };

/** Always-on precheck. LlamaFirewall in the Python runtime is the second scanner. */
export function scanUntrusted(text: string): ScanDecision {
  for (const pattern of INJECTION) {
    if (pattern.test(text)) return { allow: false, reason: "Prompt injection pattern." };
  }
  for (const pattern of SECRET) {
    if (pattern.test(text)) return { allow: false, reason: "Secret material in content." };
  }
  return { allow: true, reason: "Scanner allowed the text." };
}

export function scanGeneratedCode(text: string): ScanDecision {
  if (/child_process|eval\(|exec\(|os\.system|subprocess/.test(text)) {
    return { allow: false, reason: "CodeShield blocked a dangerous call." };
  }
  return scanUntrusted(text);
}

/** Skill files are untrusted text. An approved entry script is executed by path, so this check does not ban subprocess. */
export function scanSkillText(text: string): ScanDecision {
  return scanUntrusted(text);
}
