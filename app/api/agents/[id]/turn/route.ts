import { NextResponse } from "next/server";
import { loadBudget, saveBudget } from "@/lib/server/budget";
import { currentSession } from "@/lib/server/session";
import { handleOwnerTurn, turnFailure } from "@/lib/server/turn";

export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const budget = await loadBudget("turn", id);
  try {
    return NextResponse.json(await handleOwnerTurn(session.ownerAddress, id, body, budget));
  } catch (error) {
    const failure = turnFailure(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  } finally {
    await saveBudget("turn", id, budget);
  }
}
