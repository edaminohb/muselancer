import { NextResponse } from "next/server";
import { currentSession } from "@/lib/server/session";
import { handleSkill, readOwnedSkills, skillFailure } from "@/lib/server/skills";

export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    return NextResponse.json(await readOwnedSkills(session.ownerAddress, id));
  } catch (error) {
    const failure = skillFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  try {
    const install = await handleSkill(session.ownerAddress, id, body);
    const listed = await readOwnedSkills(session.ownerAddress, id);
    return NextResponse.json({ install, ...listed });
  } catch (error) {
    const failure = skillFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}
