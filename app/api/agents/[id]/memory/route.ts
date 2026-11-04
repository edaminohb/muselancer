import { NextResponse } from "next/server";
import { recoverMemory } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json()) as { password?: string };
  if (!body.password) return NextResponse.json({ error: "Password required." }, { status: 400 });
  try {
    const memory = await recoverMemory(session.ownerAddress, id, body.password);
    return NextResponse.json({ memory });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open memory.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
