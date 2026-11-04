"use client";

import { useSendTransaction, useSignTypedData, type SignTypedDataParams } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Address, Hex } from "viem";
import { preparedOwnerCall } from "@/lib/chain/owner-call";

type Quote = {
  hireId?: string;
  error?: string;
  authorize?: { to: Address; data?: Hex; chainId: number };
  typedData?: {
    domain: SignTypedDataParams["domain"];
    types: { ReceiveWithAuthorization: { name: string; type: string }[] };
    primaryType: "ReceiveWithAuthorization";
    message: {
      from: Address;
      to: Address;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: Hex;
    };
  };
};

/** The owner's wallet locks the USDC. The chat cannot do this by typing confirm. */
export function DealLockButton({
  agentId,
  payer,
  onError,
  onEngage,
  onDone,
}: {
  agentId: string;
  payer: Address;
  onError: (message: string) => void;
  onEngage?: () => void;
  onDone?: (ok: boolean) => void;
}) {
  const router = useRouter();
  const { signTypedData } = useSignTypedData();
  const { sendTransaction } = useSendTransaction();
  const [busy, setBusy] = useState(false);

  async function confirm() {
    onEngage?.();
    setBusy(true);
    onError("");
    try {
      const quotedResponse = await fetch(`/api/agents/${agentId}/deal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm" }),
      });
      const quoted = (await quotedResponse.json()) as { payment?: Quote | null; error?: string };
      const quote = quoted.payment;
      if (quotedResponse.status !== 402 || !quote?.hireId || !quote.typedData) {
        onError(quote?.error ?? quoted.error ?? "Confirm the deal before the hire quote.");
        onDone?.(false);
        return;
      }
      const message = quote.typedData.message;
      const signed = await signTypedData(
        {
          domain: quote.typedData.domain,
          types: { ReceiveWithAuthorization: quote.typedData.types.ReceiveWithAuthorization },
          primaryType: "ReceiveWithAuthorization",
          message,
        },
        { address: payer },
      );
      const prepared = await fetch("/api/hires", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hireId: quote.hireId, signature: signed.signature }),
      });
      const payment = (await prepared.json()) as Quote;
      if (prepared.status !== 402 || !payment.authorize?.data) {
        onError(payment.error ?? "The escrow did not lock the USDC.");
        onDone?.(false);
        return;
      }
      const filled = await preparedOwnerCall({ from: payer, to: payment.authorize.to, data: payment.authorize.data });
      const sent = await sendTransaction(
        {
          to: payment.authorize.to,
          data: payment.authorize.data,
          chainId: payment.authorize.chainId,
          nonce: filled.nonce,
          gasLimit: filled.gasLimit,
          maxFeePerGas: filled.maxFeePerGas,
          maxPriorityFeePerGas: filled.maxPriorityFeePerGas,
        },
        { address: payer },
      );
      const accepted = await fetch("/api/hires", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hireId: quote.hireId, signature: signed.signature, authorizeTx: sent.hash }),
      });
      const hired = (await accepted.json()) as { taskId?: string; error?: string };
      if (!accepted.ok || !hired.taskId) {
        onError(hired.error ?? "The escrow did not lock the USDC.");
        onDone?.(false);
        return;
      }
      await fetch(`/api/agents/${agentId}/deal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "locked", taskId: hired.taskId }),
      });
      onDone?.(true);
      router.push(`/tasks/${hired.taskId}`);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "The wallet did not sign.");
      onDone?.(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="bg-[var(--ink)] px-4 py-2 text-[var(--paper)] disabled:opacity-50" disabled={busy} type="button" onClick={() => void confirm()}>
      {busy ? "Waiting for the wallet…" : "Confirm and lock USDC"}
    </button>
  );
}
