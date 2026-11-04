import { NextResponse } from "next/server";
import { loadSkillCatalog } from "@/lib/protocol/skills";

export async function GET() {
  try {
    const skills = await loadSkillCatalog();
    return NextResponse.json({ skills });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the OASF skill taxonomy.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
