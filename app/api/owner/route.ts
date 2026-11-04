import { NextResponse } from "next/server";
import { readOwnerCard, saveOwnerCard } from "@/lib/server/owner-profile";
import { currentSession } from "@/lib/server/session";

export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const card = await readOwnerCard(session.ownerAddress);
  return NextResponse.json({
    card,
    session: { label: session.label, owner: session.ownerAddress, agentWallet: session.agentWallet },
  });
}

export async function POST(request: Request) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { displayName?: string; bio?: string } | null;
  try {
    const card = await saveOwnerCard(session.ownerAddress, {
      displayName: body?.displayName ?? "",
      bio: body?.bio ?? "",
    });
    return NextResponse.json({ card });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save the profile.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
