import { after, NextResponse } from "next/server";
import { isHash, isHex, type Hash, type Hex } from "viem";
import { HireError, confirmHire, prepareAuthorize } from "@/lib/server/hire";
import { startHireJob } from "@/lib/server/hire-job";
import { publicAgent } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";

function failure(error: unknown) {
  if (error instanceof HireError) return NextResponse.json({ error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "Hire refused.";
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  const agentId = new URL(request.url).searchParams.get("agentId")?.trim() ?? "";
  const session = await currentSession();
  try {
    const agent = await publicAgent(agentId);
    return NextResponse.json({
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        agentWallet: agent.agentWallet,
        paused: agent.paused,
        hirePrice: agent.hirePrice,
        hirePriceUsdc: agent.hirePriceUsdc,
      },
      payer: session?.ownerAddress ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("no OASF record") || message.includes("not on the identity registry") || message.includes("not on the registry yet")) {
      return NextResponse.json({ error: "This agent is not available. Choose an agent from the directory." }, { status: 404 });
    }
    return failure(error);
  }
}

export async function POST(request: Request) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = (await request.json()) as {
    agentId?: string;
    criteria?: string;
    longHorizon?: boolean;
    hireId?: string;
    signature?: string;
    authorizeTx?: string;
    agreedAmountUsdc?: string;
  };
  if (body.agreedAmountUsdc !== undefined || !body.hireId || !body.signature) {
    return NextResponse.json({ error: "Confirm the deal before the hire quote." }, { status: 400 });
  }
  try {
    if (body.hireId && body.signature) {
      if (!isHex(body.signature, { strict: true })) {
        return NextResponse.json({ error: "Signature is not from the hirer." }, { status: 400 });
      }
      if (body.authorizeTx) {
        if (!isHash(body.authorizeTx)) return NextResponse.json({ error: "Transaction hash is required." }, { status: 400 });
        const result = await confirmHire({
          payer: session.ownerAddress,
          hireId: body.hireId,
          signature: body.signature as Hex,
          authorizeTx: body.authorizeTx as Hash,
        });
        after(() => startHireJob(result.taskId));
        return NextResponse.json(result);
      }
      const prepared = await prepareAuthorize({
        payer: session.ownerAddress,
        hireId: body.hireId,
        signature: body.signature as Hex,
      });
      return NextResponse.json(prepared, { status: 402 });
    }
    return NextResponse.json({ error: "Confirm the deal before the hire quote." }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}
