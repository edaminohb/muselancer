import { NextResponse } from "next/server";
import { currentSession } from "@/lib/server/session";
import { readOwnedWeb, setWebEnabled } from "@/lib/server/web-access";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    return NextResponse.json({ enabled: await readOwnedWeb(session.ownerAddress, id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read web access.";
    const status = message === "Agent not found." ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "Choose whether web is on." }, { status: 400 });
  try {
    return NextResponse.json({ enabled: await setWebEnabled(session.ownerAddress, id, body.enabled) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update web access.";
    const status = message === "Agent not found." ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
