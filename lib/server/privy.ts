import { PrivyClient, type User } from "@privy-io/server-auth";
import { getAddress, type Address } from "viem";

let cached: PrivyClient | null = null;
let cachedAuthorizationKey = "";

export class PrivyAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function privyConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}

export function privyServer(): PrivyClient {
  return client();
}

function client(): PrivyClient {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new PrivyAuthError("Privy is not configured.", 503);
  const authorizationPrivateKey = process.env.PRIVY_AUTHORIZATION_KEY?.trim() ?? "";
  if (!cached || cachedAuthorizationKey !== authorizationPrivateKey) {
    cached = authorizationPrivateKey
      ? new PrivyClient(appId, appSecret, { walletApi: { authorizationPrivateKey } })
      : new PrivyClient(appId, appSecret);
    cachedAuthorizationKey = authorizationPrivateKey;
  }
  return cached;
}

function ethereumWallets(user: User): Address[] {
  return user.linkedAccounts.flatMap((account) =>
    account.type === "wallet" && account.chainType === "ethereum" ? [getAddress(account.address)] : [],
  );
}

export async function verifiedPrivyAccount(input: {
  accessToken: string;
  identityToken?: string;
  ownerAddress: string;
  agentWallet: string;
}): Promise<{ userId: string; label: string; ownerAddress: Address; agentWallet: Address }> {
  const privy = client();
  let claims;
  try {
    claims = await privy.verifyAuthToken(input.accessToken);
  } catch {
    throw new PrivyAuthError("Privy sign-in is required.", 401);
  }
  let user: User;
  try {
    user = input.identityToken ? await privy.getUser({ idToken: input.identityToken }) : await privy.getUser(claims.userId);
  } catch {
    throw new PrivyAuthError("Privy sign-in is required.", 401);
  }
  if (user.id !== claims.userId) throw new PrivyAuthError("Privy sign-in is required.", 401);

  let owner: Address;
  let agent: Address;
  try {
    owner = getAddress(input.ownerAddress);
    agent = getAddress(input.agentWallet);
  } catch {
    throw new PrivyAuthError("Owner and agent wallet are required.", 400);
  }
  if (owner === agent) throw new PrivyAuthError("The agent wallet must be a second Privy wallet.", 400);

  let wallets = ethereumWallets(user);
  if (!wallets.includes(owner) || !wallets.includes(agent)) {
    try {
      user = await privy.getUser(claims.userId);
    } catch {
      throw new PrivyAuthError("Privy sign-in is required.", 401);
    }
    if (user.id !== claims.userId) throw new PrivyAuthError("Privy sign-in is required.", 401);
    wallets = ethereumWallets(user);
  }
  if (!wallets.includes(owner) || !wallets.includes(agent)) {
    throw new PrivyAuthError("Both wallets must belong to this Privy account.", 403);
  }
  const label = (user.email?.address ?? "owner").slice(0, 40);
  return { userId: user.id, label, ownerAddress: owner, agentWallet: agent };
}
