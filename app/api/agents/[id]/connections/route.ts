import { NextResponse } from "next/server";
import { connectionFailure, handleConnection, listConnections } from "@/lib/server/connections";
import { currentSession } from "@/lib/server/session";

export const maxDuration = 30;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    return NextResponse.json({ connections: await listConnections(session.ownerAddress, id) });
  } catch (error) {
    const failure = connectionFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json({ connections: await handleConnection(session.ownerAddress, id, body) });
  } catch (error) {
    const failure = connectionFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}
