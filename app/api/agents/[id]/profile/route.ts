import { NextResponse } from "next/server";
import { handleTeach, profileFailure, readOwnedProfile } from "@/lib/server/teach";
import { currentSession } from "@/lib/server/session";

export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    const profile = await readOwnedProfile(session.ownerAddress, id);
    return NextResponse.json({ profile });
  } catch (error) {
    const failure = profileFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  try {
    const result = await handleTeach(session.ownerAddress, id, body);
    return NextResponse.json(result);
  } catch (error) {
    const failure = profileFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}
