"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import type { ReactNode } from "react";
import { baseSepolia } from "viem/chains";

export function Providers({ children, appId }: { children: ReactNode; appId?: string }) {
  if (!appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: { theme: "light", accentColor: "#5346F0" },
        defaultChain: baseSepolia,
        supportedChains: [baseSepolia],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
        loginMethods: ["email", "google"],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
