import type { Address, Hex } from "viem";
import { assertCanSettle, readRuntimeToken } from "../gateway/token";
import { supervisorCoversArtifact, type Verdict } from "./operator";

/** The worker role never reaches capture or void. */
export async function authorizeSettlement(input: {
  token: string;
  taskId: string;
  verdict: Verdict;
  artifactCid: string;
  signature: Hex;
  supervisor: Address;
}): Promise<void> {
  assertCanSettle(readRuntimeToken(input.token));
  const covers = await supervisorCoversArtifact({
    taskId: input.taskId,
    verdict: input.verdict,
    artifactCid: input.artifactCid,
    signature: input.signature,
    supervisor: input.supervisor,
  });
  if (!covers) throw new Error("Supervisor signature does not cover this artifact.");
  if (input.verdict === "needs_revision" || input.verdict === "dispute") {
    throw new Error("This verdict does not capture or void.");
  }
}
