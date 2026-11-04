import { after, NextResponse } from "next/server";
import { readDocument } from "@/lib/db";
import { shouldStartWorker } from "@/lib/deal/progress";
import { HireError, taskPayload } from "@/lib/server/hire";
import { startHireJob } from "@/lib/server/hire-job";
import { currentSession } from "@/lib/server/session";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const raw = await readDocument(`task:${id}`);
  const report = raw ? (JSON.parse(raw) as unknown) : undefined;
  const session = await currentSession();
  if (!session) {
    if (report) return NextResponse.json({ report });
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const payload = await taskPayload(id, session.ownerAddress);
    if (!payload) return NextResponse.json({ error: "This task is not on the desk." }, { status: 404 });
    if (shouldStartWorker(payload.task)) after(() => startHireJob(id));
    return NextResponse.json({ ...payload, report });
  } catch (error) {
    const message = error instanceof HireError ? error.message : error instanceof Error ? error.message : "Could not read the task.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
