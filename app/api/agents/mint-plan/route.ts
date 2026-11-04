import { NextResponse } from "next/server";
import { planMintRegistration } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";

export async function POST() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const plan = await planMintRegistration(session.ownerAddress);
    return NextResponse.json(plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not prepare the registration file.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
