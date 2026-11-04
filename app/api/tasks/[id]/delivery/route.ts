import { NextResponse } from "next/server";
import { HireError, readReleasedDelivery } from "@/lib/server/hire";
import { currentSession } from "@/lib/server/session";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    return NextResponse.json(await readReleasedDelivery(session.ownerAddress, id));
  } catch (error) {
    if (error instanceof HireError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : "The delivery stays sealed until you confirm.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
