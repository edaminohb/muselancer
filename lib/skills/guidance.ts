const VERSION = "1.0.0";

function oneLine(value: string, limit: number): string {
  return value.replace(/[\r\n"]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** A guidance skill the owner asked for. It requests no tools and has no script. */
export function guidanceSkillFiles(input: { name: string; description: string; instructions: string }): { path: string; text: string }[] {
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("The skill name must be lowercase letters, numbers, and hyphens.");
  const description = oneLine(input.description, 1024);
  if (!description) throw new Error("Say what the skill is for.");
  const instructions = input.instructions.replace(/\r\n/g, "\n").trim().slice(0, 12_000);
  if (!instructions) throw new Error("Say what the skill should do.");
  if (instructions.split("\n").length > 480) throw new Error("That skill is too long.");
  const manifest = {
    formatVersion: 1,
    version: VERSION,
    depends: [],
    requests: { tools: [], mcp: [], network: "none", secrets: [] },
    risk: "low",
    entry: [],
    workflow: [],
    advertise: [],
  };
  return [
    {
      path: "SKILL.md",
      text: `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  version: "${VERSION}"\n---\n${instructions.endsWith("\n") ? instructions : `${instructions}\n`}`,
    },
    { path: "muselancer.manifest.json", text: `${JSON.stringify(manifest)}\n` },
  ];
}
