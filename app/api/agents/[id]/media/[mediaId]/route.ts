import { NextResponse } from "next/server";
import { readDocument } from "@/lib/db";
import { ownedAgent } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";

export async function GET(_request: Request, context: { params: Promise<{ id: string; mediaId: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id, mediaId } = await context.params;
  if (!/^[a-f0-9]{18}$/.test(mediaId)) return NextResponse.json({ error: "That image is not available." }, { status: 404 });
  const agent = await ownedAgent(session.ownerAddress, id);
  if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  const stored = await readDocument(`chat-image:${id}:${mediaId}`);
  const match = stored ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(stored) : null;
  if (!match) return NextResponse.json({ error: "That image is not available." }, { status: 404 });
  const bytes = Buffer.from(match[2] ?? "", "base64");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": match[1] ?? "image/png",
      "cache-control": "private, max-age=86400",
    },
  });
}
