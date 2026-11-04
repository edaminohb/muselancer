"use client";

import { getIdentityToken, useCreateWallet, usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export function PrivyLogin() {
  const router = useRouter();
  const { login, authenticated, user, ready, getAccessToken } = usePrivy();
  const { createWallet } = useCreateWallet();
  const [error, setError] = useState("");
  const started = useRef(false);

  async function enter() {
    setError("");
    const wallets = (user?.linkedAccounts ?? []).flatMap((account) =>
      account.type === "wallet" && account.chainType === "ethereum" && account.walletClientType === "privy"
        ? [account.address]
        : [],
    );
    const ownerAddress = wallets[0];
    if (!ownerAddress) {
      setError("Privy has not created the owner wallet yet.");
      return;
    }
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

  useEffect(() => {
    if (!ready || !authenticated || started.current) return;
    started.current = true;
    void enter();
    // Open the desk once Privy already has this account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated]);

  if (!ready || !authenticated) {
    return (
      <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={!ready} onClick={() => login()}>
        Sign in
      </button>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--muted)]">Opening your desk…</p>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
