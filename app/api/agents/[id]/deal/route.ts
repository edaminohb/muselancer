import { NextResponse } from "next/server";
import { dealFailure, handleDeal, readOwnedDeal } from "@/lib/server/deal";
import { currentSession } from "@/lib/server/session";

export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    const deal = await readOwnedDeal(session.ownerAddress, id);
    return NextResponse.json({ deal });
  } catch (error) {
    const failure = dealFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  try {
    const result = await handleDeal(session.ownerAddress, id, body);
    return NextResponse.json({ deal: result.deal, payment: result.payment ?? null }, { status: result.payment ? 402 : 200 });
  } catch (error) {
    const failure = dealFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}
