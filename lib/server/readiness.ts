import { isAllowedAppOrigin } from "../protocol/origin";

export type Readiness = {
  privy: boolean;
  baseRpc: boolean;
  directory: boolean;
  appUrl: boolean;
  modelKey: boolean;
};

/** Present or missing only. The returned object never carries secret values. */
export function serverReadiness(env: Record<string, string | undefined> = process.env): Readiness {
  const privyId = env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ?? "";
  const privySecret = env.PRIVY_APP_SECRET?.trim() ?? "";
  return {
    privy: privyId.length > 0 && privySecret.length > 0,
    baseRpc: (env.BASE_RPC_URL?.trim() ?? "").startsWith("https://"),
    directory: (env.DIRECTORY_CLIENT_SERVER_ADDRESS?.trim() ?? "").length > 0,
    appUrl: appUrlPresent(env.NEXT_PUBLIC_APP_URL),
    modelKey: (env.MODEL_API_KEY?.trim() ?? "").length > 0,
  };
}

function appUrlPresent(value: string | undefined): boolean {
  const trimmed = value?.trim().replace(/\/$/, "") ?? "";
  if (!trimmed) return true;
  return isAllowedAppOrigin(trimmed);
}

export function modelKeyMissing(env: Record<string, string | undefined> = process.env): boolean {
  return (env.MODEL_API_KEY?.trim() ?? "").length === 0;
}
