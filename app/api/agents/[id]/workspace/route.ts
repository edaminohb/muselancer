import { NextResponse } from "next/server";
import { currentSession } from "@/lib/server/session";
import { ownedAgent } from "@/lib/server/register";
import { ownerWorkspaceAction, readOwnerWorkspace } from "@/lib/server/workspace-edit";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    const agent = await ownedAgent(session.ownerAddress, id);
    if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
    const workspace = await readOwnerWorkspace(id, { name: agent.name, description: agent.description });
    return NextResponse.json(workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read this workspace.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    const agent = await ownedAgent(session.ownerAddress, id);
    if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
    const pointer = await ownerWorkspaceAction(session.ownerAddress, id, { name: agent.name, description: agent.description }, body ?? {});
    return NextResponse.json(pointer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update this workspace.";
    const status = message.includes("Reload it") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
