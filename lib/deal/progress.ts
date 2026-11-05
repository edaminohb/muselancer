export type HireStageState = "done" | "now" | "later";

export type HireStage = { label: string; detail: string; state: HireStageState };

export type HireProgress = { working: boolean; headline: string; stages: HireStage[] };

/** Sandbox size failures are recoverable: the file may fit after the sandbox limits change. Cap automatic resumes so a file that is still too large does not loop forever. */
export const MAX_SANDBOX_RESUMES = 3;

export function isSandboxSizeError(error: string): boolean {
  return error === "A sandbox file is too large." || error === "This sandbox is too large." || error.includes("is too large for the sandbox");
}

export function shouldStartWorker(task: { status?: string; artifactCid?: string | null; jobError?: string | null; jobLog?: { text: string }[] }): boolean {
  const error = String(task.jobError ?? "").trim();
  const sandboxSize = isSandboxSizeError(error);
  const starts = (task.jobLog ?? []).filter((entry) => entry.text.startsWith("The worker started.") || entry.text.startsWith("The hirer sent the delivery back.")).length;
  const recoverable =
    error === "The command is not a program and arguments." ||
    error.includes("Lookup failed for Function") ||
    error === "The hire sandbox is not deployed. No USDC has moved." ||
    error === "LlamaFirewall unavailable" ||
    error === "The hire did not return a usable step." ||
    error.includes("is not valid JSON") ||
    (error === "The worker returned the delivery unchanged." && starts <= MAX_SANDBOX_RESUMES) ||
    (sandboxSize && starts <= MAX_SANDBOX_RESUMES);
  const freshHire = task.status === "authorized" && !task.artifactCid;
  const sentBack = task.status === "revision" && Boolean(task.artifactCid);
  return (freshHire || sentBack) && (!error || recoverable);
}

/** How long the open task page waits before the next read. A closed hire stops. */
export function taskPollWait(input: { status?: string; reviewed?: boolean; hasArtifact?: boolean }): number | null {
  const status = input.status ?? "";
  if (status === "settled" || status === "released") return null;
  if (status === "running" || status === "authorized" || status === "revision") return 3000;
  if (input.hasArtifact && !input.reviewed) return 3000;
  return 10000;
}

/** A worker step the owner can read. File text stays out of this line. */
export function jobLogLine(input: { turn: number; paths: string[]; command: string[]; output: string; done: boolean; skipped?: string }): string {
  const wrote = input.paths.length > 0 ? `Wrote ${input.paths.join(", ")}.` : "Wrote no files.";
  const command = input.command.length > 0 ? `Ran ${input.command.join(" ")}.` : "Ran no command.";
  const output = input.output.trim() ? `Output: ${input.output.trim().slice(0, 280)}` : "";
  const next = input.done ? "The worker marked this step done." : "The worker is still working.";
  return [`Turn ${input.turn}.`, wrote, command, output, input.skipped, next].filter(Boolean).join(" ");
}

export type HireViewer = "hirer" | "worker";

export function hireProgress(input: {
  paymentStatus: string | null;
  taskStatus: string;
  hasArtifact: boolean;
  reviewed: boolean;
  jobError: string;
  viewer?: HireViewer;
}): HireProgress {
  const viewer = input.viewer ?? "hirer";
  const worker = viewer === "worker";
  const paid = input.paymentStatus === "captured";
  const voided = input.paymentStatus === "voided" || input.paymentStatus === "reclaimed" || input.taskStatus === "released";
  const locked = input.paymentStatus === "authorized" || paid || voided;
  const working = input.taskStatus === "running";
  const sealed = input.hasArtifact;
  const closed = paid || voided || input.taskStatus === "settled";
  const workerDone = sealed || closed;
  const reviewDone = input.reviewed || closed;
  const stages: HireStage[] = [
    {
      label: "USDC locked",
      detail: worker
        ? "The hirer locked USDC in escrow. Locked only, not paid."
        : "Your wallet authorized the escrow. Locked only, not paid.",
      state: locked ? "done" : "now",
    },
    {
      label: "Worker",
      detail: working ? "The worker is in the sandbox." : input.jobError && !sealed ? input.jobError : workerDone ? "The worker finished this pass." : "The worker has not started.",
      state: workerDone ? "done" : "now",
    },
    { label: "Delivery sealed", detail: sealed ? "The files are sealed for the supervisor." : "No delivery is sealed yet.", state: sealed || closed ? "done" : workerDone ? "now" : "later" },
    {
      label: "Supervisor review",
      detail: input.reviewed ? "The supervisor described the delivery." : "The supervisor has not reviewed a delivery.",
      state: reviewDone ? "done" : sealed ? "now" : "later",
    },
    {
      label: worker ? "Hirer decision" : "Your decision",
      detail: worker
        ? "Waiting for the hirer to confirm, send back, or reject. USDC stays locked."
        : "You choose confirm, send back, or reject. USDC stays locked until you choose.",
      state: closed ? "done" : input.reviewed ? "now" : "later",
    },
    {
      label: "Closed",
      detail: paid
        ? worker
          ? "The hirer confirmed the delivery."
          : "You confirmed the delivery."
        : voided
          ? "The lock was voided. USDC was not paid."
          : "The lock is still open.",
      state: closed ? "done" : "later",
    },
  ];
  let headline = worker ? "Your agent is starting. USDC stays locked." : "The worker is starting. USDC stays locked.";
  if (working) headline = worker ? "Your agent is in the sandbox. USDC stays locked." : "The worker is in the sandbox. USDC stays locked.";
  else if (input.jobError && !sealed) headline = input.jobError;
  else if (sealed && !input.reviewed) headline = "The supervisor has not reviewed a delivery.";
  else if (input.reviewed && !closed) {
    headline = worker
      ? "The supervisor reviewed the delivery. Waiting for the hirer to confirm, send back, or reject. USDC stays locked."
      : "The supervisor reviewed the delivery. You choose confirm, send back, or reject. USDC stays locked until you choose.";
  } else if (paid) headline = worker ? "The hirer confirmed the delivery." : "You confirmed the delivery.";
  else if (voided) headline = "The lock was voided. USDC was not paid.";
  return { working, headline, stages };
}
