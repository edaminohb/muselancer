import { NextResponse } from "next/server";
import { workerTaskText } from "@/lib/agent/profile";
import { scanUntrusted } from "@/lib/gateway/firewall";
import { assertModel, completeModel, type GatewayBudget } from "@/lib/gateway/meta";
import { readRuntimeToken } from "@/lib/gateway/token";
import { loadTaskBudget, saveTaskBudget } from "@/lib/server/budget";
import { desk } from "@/lib/server/desk";
import { modelKeyMissing } from "@/lib/server/readiness";
import { agentPreferredModel } from "@/lib/server/teach";

export async function POST(request: Request) {
  let agentId = "";
  let budget: GatewayBudget | undefined;
  try {
    const header = request.headers.get("authorization") ?? "";
    const token = readRuntimeToken(header.replace(/^Bearer /, ""));
    if (token.role === "worker" && new URL(request.url).pathname.endsWith("/settle")) {
      return NextResponse.json({ error: "A worker token cannot settle." }, { status: 403 });
    }
    if (modelKeyMissing()) {
      return NextResponse.json({ error: "The model key is missing. USDC stays locked." }, { status: 409 });
    }
    const body = (await request.json()) as { model?: string; input?: string };
    const task = workerTaskText(body.input ?? "");
    const scan = scanUntrusted(task);
    if (!scan.allow) return NextResponse.json({ error: scan.reason }, { status: 400 });
    const net = await desk();
    const longHorizon = net.tasks.get(token.taskId)?.longHorizon === true;
    agentId = token.taskId;
    budget = await loadTaskBudget(token.taskId);
    const result = await completeModel(
      {
        model: body.model?.trim() ? assertModel(body.model, longHorizon) : await agentPreferredModel(token.agentId, longHorizon),
        input: task,
        taskId: token.taskId,
        agentId: token.agentId,
        longHorizon,
      },
      budget,
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway refused the call.";
    return NextResponse.json({ error: message }, { status: 400 });
  } finally {
    if (budget && agentId) await saveTaskBudget(agentId, budget);
  }
}
