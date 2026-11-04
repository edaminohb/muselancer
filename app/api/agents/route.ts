import { NextResponse } from "next/server";
import { DirectoryPublishError, completeRegistration, listOwned } from "@/lib/server/register";
import { serverReadiness } from "@/lib/server/readiness";
import { currentSession } from "@/lib/server/session";

export async function GET() {
  const readiness = serverReadiness();
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required.", readiness, agents: [] }, { status: 401 });
  try {
    const agents = await listOwned(session.ownerAddress);
    return NextResponse.json({
      agents,
      readiness,
      session: { label: session.label, owner: session.ownerAddress, agentWallet: session.agentWallet },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the identity registry.";
    return NextResponse.json({ error: message, readiness, agents: [], session: { label: session.label, owner: session.ownerAddress, agentWallet: session.agentWallet } }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = (await request.json()) as {
    registerTxHash?: string;
    uriTxHash?: string;
    signatureTxHash?: string;
    walletTxHash?: string;
    password?: string;
    model?: string;
    walletSignature?: string;
    oasfSignature?: string;
  };
  if (!body.registerTxHash) {
    return NextResponse.json({ error: "Registration transaction hash is required." }, { status: 400 });
  }
  try {
    const agent = await completeRegistration({
      owner: session.ownerAddress,
      agentWallet: session.agentWallet,
      password: body.password ?? "",
      model: body.model,
      registerTxHash: body.registerTxHash as `0x${string}`,
      uriTxHash: body.uriTxHash ? (body.uriTxHash as `0x${string}`) : undefined,
      signatureTxHash: body.signatureTxHash ? (body.signatureTxHash as `0x${string}`) : undefined,
      walletTxHash: body.walletTxHash ? (body.walletTxHash as `0x${string}`) : undefined,
      walletSignature: body.walletSignature ? (body.walletSignature as `0x${string}`) : undefined,
      oasfSignature: body.oasfSignature ? (body.oasfSignature as `0x${string}`) : undefined,
    });
    return NextResponse.json({ agent });
  } catch (error) {
    if (error instanceof DirectoryPublishError) {
      return NextResponse.json({ error: error.message, agentId: error.agentId }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Could not register.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
