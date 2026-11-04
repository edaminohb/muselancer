import { NextResponse } from "next/server";
import { readOnchainAgent } from "@/lib/identity/chain";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "Agent id is required." }, { status: 400 });
  try {
    const agent = await readOnchainAgent(id);
    return new NextResponse(agent.registrationJson, {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the registry.";
    const status = message.includes("not on the identity registry") || message.includes("not on the registry yet") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
