import { NextResponse } from "next/server";
import { authorizeSettlement } from "@/lib/chain/escrow";
import type { Verdict } from "@/lib/chain/operator";

export async function POST(request: Request) {
  try {
    const header = request.headers.get("authorization") ?? "";
    const body = (await request.json()) as {
      taskId?: string;
      verdict?: Verdict;
      artifactCid?: string;
      signature?: `0x${string}`;
      supervisor?: `0x${string}`;
    };
    if (!body.taskId || !body.verdict || !body.artifactCid || !body.signature || !body.supervisor) {
      return NextResponse.json({ error: "Task, verdict, artifact, signature, and supervisor are required." }, { status: 400 });
    }
    await authorizeSettlement({
      token: header.replace(/^Bearer /, ""),
      taskId: body.taskId,
      verdict: body.verdict,
      artifactCid: body.artifactCid,
      signature: body.signature,
      supervisor: body.supervisor,
    });
    return NextResponse.json({ ok: true, verdict: body.verdict });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Settlement refused.";
    const status = /cannot settle/.test(message) ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
