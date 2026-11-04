import { spawn } from "node:child_process";

export type ModalJobFile = { path: string; text: string };

export type ModalJob = { files: ModalJobFile[]; writes: ModalJobFile[]; command: string[] };

export type ModalJobResult = { ok: boolean; stdout: string; error?: string; files: ModalJobFile[] };

const SANDBOX_MS = 320_000;

export function sandboxConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.MODAL_TOKEN_ID?.trim() && env.MODAL_TOKEN_SECRET?.trim());
}

export function sandboxFailure(detail: string): Error {
  if (/Lookup failed for Function/i.test(detail) || /NotFoundError/i.test(detail)) {
    return new Error("The hire sandbox is not deployed. No USDC has moved.");
  }
  const line = detail.split("\n").map((item) => item.trim()).filter(Boolean).at(-1) ?? "";
  return new Error((line || "The hire sandbox did not run. No USDC has moved.").slice(0, 240));
}

/** One call to the deployed `run_job` function. The model key is not in this payload. The event loop stays free. */
export function runModalJob(job: ModalJob): Promise<ModalJobResult> {
  if (!sandboxConfigured()) {
    return Promise.reject(new Error("The hire sandbox is not deployed. No USDC has moved."));
  }
  const python = process.env.PYTHON ?? "python";
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["runtime/modal_job.py"], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: ModalJobResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result as ModalJobResult);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(sandboxFailure("The hire sandbox timed out. No USDC has moved."));
    }, SANDBOX_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(sandboxFailure(error.message)));
    child.on("close", (status) => {
      if (status !== 0) {
        finish(sandboxFailure(stderr || stdout));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}") as ModalJobResult;
        finish(undefined, { ok: parsed.ok === true, stdout: parsed.stdout ?? "", error: parsed.error, files: parsed.files ?? [] });
      } catch {
        finish(sandboxFailure("The hire sandbox did not run. No USDC has moved."));
      }
    });
    child.stdin.write(JSON.stringify({ files: job.files, writes: job.writes, command: job.command }));
    child.stdin.end();
  });
}
