import { NextResponse } from "next/server";
import { directorySearch } from "@/lib/server/register";

export async function GET(request: Request) {
  const skillParam = new URL(request.url).searchParams.get("skill");
  const skill = skillParam === null || skillParam === "" ? undefined : Number(skillParam);
  if (skill !== undefined && (!Number.isInteger(skill) || skill <= 0)) {
    return NextResponse.json({ error: "Skill id must be a positive integer." }, { status: 400 });
  }
  try {
    const result = await directorySearch(skill);
    return NextResponse.json({
      ...result,
      note: result.note,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the identity registry.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
