import { NextResponse } from "next/server";
import { isHash, type Hash } from "viem";
import { registrationFollowup } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";

export async function POST(request: Request) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = (await request.json()) as { registerTxHash?: string };
  if (!body.registerTxHash || !isHash(body.registerTxHash)) {
    return NextResponse.json({ error: "Registration transaction hash is required." }, { status: 400 });
  }
  try {
    const followup = await registrationFollowup(session.ownerAddress, body.registerTxHash as Hash);
    return NextResponse.json(followup);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the registration.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
