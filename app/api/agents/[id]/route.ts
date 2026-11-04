import { NextResponse } from "next/server";
import { ownedAgent, setCommercialTerms, setPaused } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    const agent = await ownedAgent(session.ownerAddress, id);
    if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
    return NextResponse.json({ agent });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the identity registry.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json()) as { paused?: boolean; hirePrice?: string };
  try {
    if (body.hirePrice !== undefined) {
      if (!body.hirePrice.trim()) {
        return NextResponse.json({ error: "Enter a hire price." }, { status: 400 });
      }
      const agent = await setCommercialTerms(session.ownerAddress, id, { hirePrice: body.hirePrice });
      return NextResponse.json({ agent });
    }
    if (typeof body.paused === "boolean") {
      const agent = await setPaused(session.ownerAddress, id, body.paused);
      return NextResponse.json({ agent });
    }
    return NextResponse.json({ error: "Enter a hire price." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update the agent.";
    const status = /not found|Unknown agent/.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
