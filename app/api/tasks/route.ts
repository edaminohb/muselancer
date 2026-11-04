import { NextResponse } from "next/server";
import { tasksForViewer } from "@/lib/server/hire";
import { currentSession } from "@/lib/server/session";

export async function GET(request: Request) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required.", tasks: [] }, { status: 401 });
  const agentId = new URL(request.url).searchParams.get("agentId")?.trim() ?? "";
  try {
    const tasks = await tasksForViewer(session.ownerAddress);
    return NextResponse.json({ tasks: agentId ? tasks.filter((task) => task.workerAgentId === agentId) : tasks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read tasks.";
    return NextResponse.json({ error: message, tasks: [] }, { status: 400 });
  }
}
