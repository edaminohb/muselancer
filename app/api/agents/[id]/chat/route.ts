import { NextResponse } from "next/server";
import { MAX_ATTACHMENTS } from "@/lib/gateway/attachment-kind";
import { agentReply, ChatReplyError, readOwnerAsk, type ChatAttachment } from "@/lib/server/chat-reply";
import { ownerChatBudget } from "@/lib/server/budget";
import { ownedAgent } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";
import { missingDealLines } from "@/lib/chat/rows";
import { readChatTranscript, writeChatTranscript, type ChatTurn } from "@/lib/server/chat-thread";
import { readOwnedDeal } from "@/lib/server/deal";
import { messagingMode, xmtpBackendUrl } from "@/lib/messaging/transport";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  try {
    const agent = await ownedAgent(session.ownerAddress, id);
    if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
    const backendUrl = xmtpBackendUrl();
    if (!backendUrl) return NextResponse.json({ error: "Set XMTP_BACKEND_URL." }, { status: 503 });
    const transcript = await readChatTranscript(id);
    let shown = transcript;
    try {
      const deal = await readOwnedDeal(session.ownerAddress, id);
      if (deal) {
        const missing = missingDealLines(transcript, deal.turns, (role, text) => ({ role, text }) as ChatTurn);
        if (missing.length > 0) {
          shown = [...missing, ...transcript];
          await writeChatTranscript(id, shown);
        }
      }
    } catch {
      shown = transcript;
    }
    return NextResponse.json({
      mode: messagingMode(),
      backendUrl,
      ownerAddress: session.ownerAddress,
      agentWallet: agent.agentWallet,
      transcript: shown,
      ask: await readOwnerAsk(id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the identity registry.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { message?: string; startup?: boolean; history?: unknown; attachments?: ChatAttachment[] } | null;
  const message = body?.message?.trim() ?? "";
  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
  if (!message && attachments.length === 0) return NextResponse.json({ error: "Say what to send." }, { status: 400 });
  if (attachments.length > MAX_ATTACHMENTS) return NextResponse.json({ error: "Attach up to 8 files." }, { status: 400 });
  if (attachments.some((item) => !item || (item.kind !== "text" && item.kind !== "image" && item.kind !== "voice"))) {
    return NextResponse.json({ error: "Attach a .md, .txt, .csv, image, or voice file." }, { status: 400 });
  }
  const budget = ownerChatBudget();
  const agent = await ownedAgent(session.ownerAddress, id);
  if (!agent) return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  const replyInput = {
    startup: body?.startup === true,
    name: agent.name,
    description: agent.description,
    history: body?.history,
    attachments,
  };
  const shownError = (error: unknown) => {
    const messageText = error instanceof Error ? error.message : "Could not reply.";
    const shown = messageText === "Agent budget is exhausted." ? "This turn ran out of model calls. Send it again." : messageText;
    const status = error instanceof ChatReplyError ? error.status : messageText.startsWith("The model key is missing") ? 409 : 400;
    return { shown, status };
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      try {
        const reply = await agentReply(session.ownerAddress, id, message, budget, {
          ...replyInput,
          onActivity: (phase) => send({ phase }),
        });
        send({ text: reply.text, ownerText: reply.ownerText, ask: reply.ask, mode: messagingMode() });
      } catch (error) {
        const failure = shownError(error);
        send({ error: failure.shown, status: failure.status });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
