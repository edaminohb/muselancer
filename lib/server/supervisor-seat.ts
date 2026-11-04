import { getAddress } from "viem";

/** The supervisor is a third agent. The hiring agent and the hirer do not qualify. */
export function supervisorSeat(input: {
  supervisorAgentId: string;
  hiringAgentId: string;
  workerAgentId: string;
  supervisorOwner: string;
  hirer: string;
}): string {
  if (!/^\d+$/.test(input.supervisorAgentId) || input.supervisorAgentId === "0") {
    throw new Error("This deal needs a deployed supervisor agent.");
  }
  if (input.supervisorAgentId === input.hiringAgentId || input.supervisorAgentId === input.workerAgentId) {
    throw new Error("The supervisor must be a different agent from the hiring agent and the hired agent.");
  }
  if (getAddress(input.supervisorOwner) === getAddress(input.hirer)) {
    throw new Error("The supervisor cannot belong to the hirer.");
  }
  return input.supervisorAgentId;
}

/** The sealed delivery has one reader, the supervisor wallet. */
export function sealedToSupervisor(readers: string[], supervisorWallet: string, blocked: string[]): boolean {
  if (readers.length !== 1) return false;
  const only = getAddress(readers[0] ?? "");
  if (only !== getAddress(supervisorWallet)) return false;
  return blocked.every((wallet) => getAddress(wallet) !== only);
}
