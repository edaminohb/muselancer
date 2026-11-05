"use client";

import { getIdentityToken, useCreateWallet, usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const WALLET_WAIT_MS = 30_000;

export function PrivyLogin() {
  const router = useRouter();
  const { login, authenticated, user, ready, getAccessToken } = usePrivy();
  const { createWallet } = useCreateWallet();
  const [error, setError] = useState("");
  const started = useRef(false);

  // Privy reports authenticated before the embedded wallet it creates on
  // login has been linked to the account. Until that wallet appears, the
  // account is still being created: wait, do not fail.
  const wallets = (user?.linkedAccounts ?? []).flatMap((account) =>
    account.type === "wallet" && account.chainType === "ethereum" && account.walletClientType === "privy"
      ? [account.address]
      : [],
  );
  const ownerAddress = wallets[0] ?? "";

  async function enter() {
    setError("");
    let agentAddress = wallets[1] ?? "";
    if (!agentAddress) {
      const created = await createWallet({ createAdditional: true });
      agentAddress = created.address;
    }
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Privy sign-in is required.");
      return;
    }
    const identityToken = await getIdentityToken();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    };
    if (identityToken) headers["privy-id-token"] = identityToken;
    const response = await fetch("/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ ownerAddress, agentWallet: agentAddress }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? "Could not open the session.");
      return;
    }
    router.push("/dashboard");
  }

  // Only complain if Privy still has not linked a wallet long after sign-in.
  useEffect(() => {
    if (!ready || !authenticated || ownerAddress) return;
    const timer = setTimeout(() => {
      setError("Privy is taking longer than usual to create the owner wallet. Keep this tab open, or refresh and sign in again.");
    }, WALLET_WAIT_MS);
    return () => clearTimeout(timer);
  }, [ready, authenticated, ownerAddress]);

  useEffect(() => {
    if (!ready || !authenticated || !ownerAddress || started.current) return;
    started.current = true;
    void enter().catch(() => {
      started.current = false;
      setError("Could not finish sign-in. Try again.");
    });
    // Open the desk once Privy has linked this account's wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, ownerAddress]);

  if (!ready || !authenticated) {
    return (
      <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={!ready} onClick={() => login()}>
        Sign in
      </button>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--muted)]">{ownerAddress ? "Opening your desk…" : "Creating your wallet…"}</p>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
