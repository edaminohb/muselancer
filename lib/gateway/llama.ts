import { spawn } from "node:child_process";
import { scanGeneratedCode, scanUntrusted, type ScanDecision } from "./firewall";

/** Regex scan used by the app process. Hire jobs also run runtime/firewall.py before a delivery is sealed. */
export function scanPlaintext(text: string, kind: "text" | "code" = "text"): ScanDecision {
  return kind === "code" ? scanGeneratedCode(text) : scanUntrusted(text);
}

/** A real refusal stops the seal. A missing LlamaFirewall package does not, once the regex scan has allowed the text. */
export function scannerBlocksSeal(result: { allow: boolean }): boolean {
  return result.allow === false;
}

/** The same Python scanner the sandbox image runs. A missing LlamaFirewall package leaves the regex result. */
export function scanHireText(text: string, kind: "text" | "code" = "text"): Promise<{ allow: boolean; reason: string; llama: string }> {
  const python = process.env.PYTHON ?? "python";
  return new Promise((resolve) => {
    const child = spawn(python, ["runtime/firewall.py"], { cwd: process.cwd() });
    let stdout = "";
    let settled = false;
    const finish = (result: { allow: boolean; reason: string; llama: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ allow: false, reason: "LlamaFirewall unavailable", llama: "unavailable" });
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => finish({ allow: false, reason: "LlamaFirewall unavailable", llama: "unavailable" }));
    child.on("close", (status) => {
      if (status !== 0) {
        finish({ allow: false, reason: "LlamaFirewall unavailable", llama: "unavailable" });
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}") as { allow?: boolean; reason?: string; llama?: string };
        finish({
          allow: parsed.allow === true,
          reason: typeof parsed.reason === "string" ? parsed.reason : "LlamaFirewall unavailable",
          llama: typeof parsed.llama === "string" ? parsed.llama : "unavailable",
        });
      } catch {
        finish({ allow: false, reason: "LlamaFirewall unavailable", llama: "unavailable" });
      }
    });
    child.stdin.write(JSON.stringify({ text, kind }));
    child.stdin.end();
  });
}
