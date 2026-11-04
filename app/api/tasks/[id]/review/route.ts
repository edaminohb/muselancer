import { NextResponse } from "next/server";
import { HireError, reviewDelivery } from "@/lib/server/hire";
import { currentSession } from "@/lib/server/session";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    const result = await reviewDelivery({ payer: session.ownerAddress, taskId: id });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof HireError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : "The delivery could not be reviewed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
