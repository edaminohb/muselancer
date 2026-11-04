import { NextResponse } from "next/server";
import { DirectorySkillCorrection, publishAgentRecord } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";
import type { Hash, Hex } from "viem";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  let proof: { uriTxHash: Hash; signatureTxHash: Hash; oasfSignature: Hex } | undefined;
  const text = await request.text();
  if (text.trim()) {
    try {
      const body = JSON.parse(text) as { uriTxHash?: string; signatureTxHash?: string; oasfSignature?: string };
      if (body.uriTxHash || body.signatureTxHash || body.oasfSignature) {
        proof = {
          uriTxHash: (body.uriTxHash ?? "") as Hash,
          signatureTxHash: (body.signatureTxHash ?? "") as Hash,
          oasfSignature: (body.oasfSignature ?? "") as Hex,
        };
      }
    } catch {
      return NextResponse.json({ error: "Directory push failed." }, { status: 400 });
    }
  }
  try {
    const agent = await publishAgentRecord(session.ownerAddress, id, proof);
    return NextResponse.json({ agent });
  } catch (error) {
    if (error instanceof DirectorySkillCorrection) {
      return NextResponse.json({ correction: error.correction }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Directory push failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
