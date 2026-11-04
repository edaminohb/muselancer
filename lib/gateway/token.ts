import { createHmac, timingSafeEqual } from "crypto";
import { appSecret } from "../server/app-secret";

export type RuntimeRole = "worker" | "supervisor" | "owner";

export type RuntimeToken = {
  agentId: string;
  taskId: string;
  role: RuntimeRole;
  exp: number;
};

function secret(): string {
  return appSecret();
}

export function mintRuntimeToken(token: RuntimeToken): string {
  const body = Buffer.from(JSON.stringify(token)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readRuntimeToken(value: string): RuntimeToken {
  const [body, mac] = value.split(".");
  if (!body || !mac) throw new Error("Malformed runtime token.");
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Bad runtime token.");
  const token = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RuntimeToken;
  if (token.exp < Date.now()) throw new Error("Runtime token expired.");
  return token;
}

export function assertCanSettle(token: RuntimeToken): void {
  if (token.role !== "supervisor") {
    throw new Error("A worker token cannot settle or submit a verdict.");
  }
}
