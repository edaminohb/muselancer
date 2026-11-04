import { NextResponse } from "next/server";
import { PrivyAuthError, verifiedPrivyAccount } from "@/lib/server/privy";
import { currentSession, sealSession, SESSION_MAX_AGE_SECONDS } from "@/lib/server/session";

export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ session: null });
  return NextResponse.json({
    session: { label: session.label, owner: session.ownerAddress, agentWallet: session.agentWallet },
  });
}

export async function POST(request: Request) {
  let body: { ownerAddress?: string; agentWallet?: string };
  try {
    body = (await request.json()) as { ownerAddress?: string; agentWallet?: string };
  } catch {
    return NextResponse.json({ error: "Owner and agent wallet are required." }, { status: 400 });
  }
  if (!body.ownerAddress || !body.agentWallet) {
    return NextResponse.json({ error: "Owner and agent wallet are required." }, { status: 400 });
  }
  const header = request.headers.get("authorization") ?? "";
  const accessToken = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!accessToken) return NextResponse.json({ error: "Privy sign-in is required." }, { status: 401 });
  const identityToken = request.headers.get("privy-id-token")?.trim() || undefined;
  try {
    const account = await verifiedPrivyAccount({
      accessToken,
      identityToken,
      ownerAddress: body.ownerAddress,
      agentWallet: body.agentWallet,
    });
    const session = sealSession({
      userId: account.userId,
      ownerAddress: account.ownerAddress,
      agentWallet: account.agentWallet,
      label: account.label,
    });
    const response = NextResponse.json({
      label: account.label,
      ownerAddress: account.ownerAddress,
      agentWallet: account.agentWallet,
    });
    response.cookies.set("muselancer_session", session, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) {
    if (error instanceof PrivyAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Could not open the session.";
    const status = message.startsWith("Set MUSELANCER_SECRET") ? 500 : 401;
    return NextResponse.json({ error: status === 500 ? message : "Privy sign-in is required." }, { status });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set("muselancer_session", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  });
  return response;
}
