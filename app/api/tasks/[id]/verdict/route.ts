import { after, NextResponse } from "next/server";
import { isHash, type Hash } from "viem";
import { startHireJob } from "@/lib/server/hire-job";
import { recordTaskOutcome } from "@/lib/server/deal";
import { HireError, confirmSettlement, settlementCall } from "@/lib/server/hire";
import { currentSession } from "@/lib/server/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json()) as { verdict?: string; txHash?: string; note?: string };
  if (body.verdict !== "pass" && body.verdict !== "fail" && body.verdict !== "needs_revision") {
    return NextResponse.json({ error: "Verdict must be pass, fail, or needs_revision." }, { status: 400 });
  }
  try {
    if (body.txHash) {
      if (body.verdict === "needs_revision") {
        return NextResponse.json({ error: "Send back leaves the lock in place." }, { status: 400 });
      }
      if (!isHash(body.txHash)) return NextResponse.json({ error: "Transaction hash is required." }, { status: 400 });
      const result = await confirmSettlement({
        payer: session.ownerAddress,
        taskId: id,
        verdict: body.verdict,
        txHash: body.txHash as Hash,
      });
      if (result.paymentStatus === "captured" || result.paymentStatus === "voided") {
        await recordTaskOutcome(id, result.paymentStatus === "captured" ? "paid" : "returned");
      }
      return NextResponse.json(result);
    }
    const result = await settlementCall({
      payer: session.ownerAddress,
      taskId: id,
      verdict: body.verdict,
      note: body.verdict === "needs_revision" && typeof body.note === "string" ? body.note : undefined,
    });
    if (body.verdict === "needs_revision") after(() => startHireJob(id));
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof HireError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : "Settlement refused.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
