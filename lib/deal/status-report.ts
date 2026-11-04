export type HireSnapshot = {
  role: "hirer" | "worker";
  workerName: string;
  workerAgentId: string;
  paymentStatus: string | null;
  taskStatus: string;
  hasArtifact: boolean;
  reviewed: boolean;
  deliveryReleased: boolean;
  jobError: string;
};

/** Facts the agent can see. The agent chooses the words. */
export function hireStatusReport(input: HireSnapshot): string {
  const name = input.workerName.trim() || `Agent ${input.workerAgentId}`;
  const writing = input.taskStatus === "running" ? "yes" : "no";
  const lines = [
    "Hire record:",
    `Your part: ${input.role === "hirer" ? "hiring agent" : "hired agent"}`,
    `Worker: ${name}, id ${input.workerAgentId}`,
    `Task status: ${input.taskStatus || "none"}`,
    `Payment: ${input.paymentStatus || "none"}`,
    `Files released: ${input.deliveryReleased ? "yes" : "no"}`,
    `Delivery sealed: ${input.hasArtifact ? "yes" : "no"}`,
    `Supervisor reviewed: ${input.reviewed ? "yes" : "no"}`,
    `Worker in the sandbox: ${writing}`,
  ];
  if (input.jobError.trim() && !input.hasArtifact) lines.push(`Job error: ${input.jobError.trim()}`);
  return lines.join("\n");
}
