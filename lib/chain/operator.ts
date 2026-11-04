import { encodePacked, getAddress, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { OPERATOR_DOMAIN } from "./constants";

export const VERDICTS = ["pass", "needs_revision", "fail", "dispute"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function verdictDigest(taskId: string, verdict: Verdict, artifactCid: string): Hex {
  return keccak256(
    encodePacked(["string", "string", "string", "string"], [OPERATOR_DOMAIN, taskId, verdict, artifactCid]),
  );
}

export async function recoverSupervisor(input: {
  taskId: string;
  verdict: Verdict;
  artifactCid: string;
  signature: Hex;
}): Promise<Address> {
  const digest = verdictDigest(input.taskId, input.verdict, input.artifactCid);
  const address = await recoverMessageAddress({ message: { raw: digest }, signature: input.signature });
  return getAddress(address);
}

export async function supervisorCoversArtifact(input: {
  taskId: string;
  verdict: Verdict;
  artifactCid: string;
  signature: Hex;
  supervisor: Address;
}): Promise<boolean> {
  const recovered = await recoverSupervisor(input);
  return recovered === getAddress(input.supervisor);
}
