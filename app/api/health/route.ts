import { NextResponse } from "next/server";
import { probeDirectory } from "@/lib/directory/client";
import { sandboxConfigured } from "@/lib/server/modal-job";
import { serverReadiness } from "@/lib/server/readiness";

export async function GET() {
  const ready = serverReadiness();
  return NextResponse.json({
    privy: ready.privy,
    baseRpc: ready.baseRpc,
    directory: ready.directory && (await probeDirectory()),
    appUrl: ready.appUrl,
    modelKey: ready.modelKey,
    sandbox: sandboxConfigured(),
  });
}
