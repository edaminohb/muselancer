import { saveConduct, saveGoals, saveIdentity, saveVoice, type AgentProfile } from "../agent/profile";

function labeled(text: string, label: string): string {
  const match = new RegExp(`^${label}:\\s*(.*)$`, "im").exec(text);
  return match?.[1]?.trim() ?? "";
}

function bullets(text: string, label: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase().startsWith(`${label.toLowerCase()}:`));
  if (start < 0) return [];
  const items: string[] = [];
  const inline = lines[start].slice(lines[start].indexOf(":") + 1).trim();
  if (inline) items.push(inline);
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    if (!/^\s*-\s+/.test(line)) break;
    const item = line.replace(/^\s*-\s+/, "").trim();
    if (item) items.push(item);
  }
  return items;
}

function keep(next: string, current: string): string {
  return next.trim() || current;
}

/** Private profile fields that match a saved workspace file. This does not touch the identity registry. */
export function applyWorkspaceFile(profile: AgentProfile, path: string, text: string): AgentProfile {
  if (path === "IDENTITY.md") {
    const role = labeled(text, "Role");
    return saveIdentity(profile, {
      displayName: keep(labeled(text, "Name"), profile.identity.displayName),
      description: keep(labeled(text, "Description"), profile.identity.description),
      expertise: role ? [role] : profile.identity.expertise,
    });
  }
  if (path === "SOUL.md") {
    const boundaries = bullets(text, "Boundaries");
    return saveConduct(
      saveVoice(profile, {
        personality: keep(labeled(text, "Personality"), profile.voice.personality),
        tone: keep(labeled(text, "Tone"), profile.voice.tone),
        style: keep(labeled(text, "Style"), profile.voice.style),
      }),
      {
        preferences: profile.conduct.preferences,
        decisionStyle: keep(labeled(text, "Decision style"), profile.conduct.decisionStyle),
        boundaries: boundaries.length > 0 ? boundaries : profile.conduct.boundaries,
        instructions: profile.conduct.instructions,
      },
    );
  }
  if (path === "USER.md") {
    const preferences = bullets(text, "Preferences");
    const goals = bullets(text, "Goals");
    return saveGoals(
      saveConduct(profile, {
        preferences: preferences.length > 0 ? preferences : profile.conduct.preferences,
        decisionStyle: profile.conduct.decisionStyle,
        boundaries: profile.conduct.boundaries,
        instructions: profile.conduct.instructions,
      }),
      { objectives: goals.length > 0 ? goals : profile.goals.objectives },
    );
  }
  return profile;
}
