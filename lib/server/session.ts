import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";
import { appSecret } from "./app-secret";

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export type Session = {
  userId: string;
  ownerAddress: string;
  agentWallet: string;
  label: string;
  exp: number;
};

function secret(): string {
  return appSecret();
}

export function sealSession(session: Omit<Session, "exp"> & { exp?: number }): string {
  const body = Buffer.from(JSON.stringify({ ...session, exp: session.exp ?? Date.now() + SESSION_MS })).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function openSession(value: string | undefined): Session | null {
  if (!value) return null;
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<Session>;
  if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
  if (!parsed.userId || !parsed.ownerAddress || !parsed.agentWallet) return null;
  return {
    userId: parsed.userId,
    ownerAddress: parsed.ownerAddress,
    agentWallet: parsed.agentWallet,
    label: parsed.label ?? "",
    exp: parsed.exp,
  };
}

export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  return openSession(jar.get("muselancer_session")?.value);
}
