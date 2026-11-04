const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** An https origin, or this machine. An empty setting means the local app. */
export function isAllowedAppOrigin(origin: string): boolean {
  const value = origin.trim().replace(/\/$/, "");
  return value.startsWith("https://") || LOCALHOST.test(value);
}

export function appOrigin(env: Record<string, string | undefined> = process.env): string {
  const value = env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? "";
  if (!value) return "http://localhost:3000";
  if (!isAllowedAppOrigin(value)) {
    throw new Error("Set NEXT_PUBLIC_APP_URL to an https origin or http://localhost:3000.");
  }
  return value;
}

export function recordNameAllowed(name: string): boolean {
  try {
    const url = new URL(name);
    return isAllowedAppOrigin(`${url.protocol}//${url.host}`);
  } catch {
    return false;
  }
}
