"use client";

import { useSendTransaction } from "@privy-io/react-auth";
import { useEffect, useState } from "react";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { IDENTITY_CHAIN_ID } from "@/lib/chain/constants";
import { preparedWalletSend } from "@/lib/chain/owner-call";
import { formatTokenAmount, parseSendTo, parseTokenAmount, type WalletActivity, type WalletToken } from "@/lib/chain/wallet";
import { toast } from "@/components/toaster";

type WalletView = {
  role: "owner" | "agent";
  name: string;
  address: Address;
  agentId: string;
  ethRaw: string;
  ethDisplay: string;
  tokens: WalletToken[];
  activity: WalletActivity[];
  error: string;
};

type Asset = { key: string; symbol: string; decimals: number; raw: string; display: string; token: Address | null };

const transferAbi = [{
  type: "function",
  name: "transfer",
  stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}] as const;

function short(value: string): string {
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function assetsOf(wallet: WalletView): Asset[] {
  return [
    { key: "eth", symbol: "ETH", decimals: 18, raw: wallet.ethRaw, display: wallet.ethDisplay, token: null },
    ...wallet.tokens.map((token) => ({
      key: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      raw: token.raw,
      display: token.display,
      token: token.address,
    })),
  ];
}

/** Balances, receive, and send for the owner wallet and each agent wallet. */
export function WalletPanel() {
  const { sendTransaction } = useSendTransaction();
  const [wallets, setWallets] = useState<WalletView[]>([]);
  const [network, setNetwork] = useState("Base Sepolia");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"receive" | "send" | "">("");
  const [assetKey, setAssetKey] = useState("eth");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setError("");
    const response = await fetch("/api/wallets");
    const body = (await response.json()) as { network?: string; wallets?: WalletView[]; error?: string };
    if (!response.ok) {
      setError(body.error ?? "Could not load the wallets.");
      setLoading(false);
      return;
    }
    const next = body.wallets ?? [];
    setNetwork(body.network ?? "Base Sepolia");
    setWallets(next);
    setSelected((current) => next.some((item) => item.address === current) ? current : next[0]?.address ?? "");
    setLoading(false);
  }

  useEffect(() => {
    void load().catch(() => {
      setError("Could not load the wallets.");
      setLoading(false);
    });
  }, []);

  const wallet = wallets.find((item) => item.address === selected) ?? wallets[0];
  const assets = wallet ? assetsOf(wallet) : [];
  const asset = assets.find((item) => item.key === assetKey) ?? assets[0];

  async function copyAddress() {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      toast("ok", "Address copied.");
    } catch {
      setError("Could not copy the address.");
    }
  }

  async function send() {
    if (!wallet || !asset) return;
    setError("");
    const to = parseSendTo(destination, wallet.address);
    if (typeof to === "string") {
      setError(to);
      return;
    }
    const raw = parseTokenAmount(amount, asset.decimals, asset.raw);
    if (!/^\d+$/.test(raw)) {
      setError(raw);
      return;
    }
    setBusy(true);
    try {
      const tokenTransfer = asset.token
        ? encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [to, BigInt(raw)] })
        : "0x" as Hex;
      const filled = await preparedWalletSend({
        from: wallet.address,
        to: asset.token ?? to,
        data: tokenTransfer,
        valueWei: asset.token ? BigInt(0) : BigInt(raw),
      });
      const fee = {
        chainId: IDENTITY_CHAIN_ID,
        nonce: filled.nonce,
        gasLimit: filled.gasLimit,
        maxFeePerGas: filled.maxFeePerGas,
        maxPriorityFeePerGas: filled.maxPriorityFeePerGas,
      };
      const sent = await sendTransaction(
        asset.token
          ? { to: asset.token, data: tokenTransfer, ...fee }
          : { to, data: tokenTransfer, value: `0x${BigInt(raw).toString(16)}` as Hex, ...fee },
        { address: wallet.address },
      );
      toast("ok", "The send was submitted.");
      setAmount("");
      setDestination("");
      setMode("");
      window.open(`https://sepolia.basescan.org/tx/${sent.hash}`, "_blank", "noopener,noreferrer");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The wallet did not send.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="wallets" className="card mt-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-base font-semibold">Wallets</p>
          <p className="mt-1 text-sm text-[var(--muted)]">{network}. ETH and tokens held by the owner wallet and each agent wallet.</p>
        </div>
        <button className="border border-[var(--ink)] px-3 py-2 text-sm disabled:opacity-50" type="button" disabled={loading || busy} onClick={() => void load()}>Refresh</button>
      </div>
      {loading ? <p className="mt-4 text-sm text-[var(--muted)]">Reading balances…</p> : null}
      {!loading && wallets.length > 0 && wallet && asset ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {wallets.map((item) => (
              <button
                key={item.address}
                className={`border px-3 py-2 text-sm ${item.address === wallet.address ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)]" : "border-[var(--line)]"}`}
                type="button"
                onClick={() => {
                  setSelected(item.address);
                  setMode("");
                  setAssetKey("eth");
                  setAmount("");
                  setDestination("");
                  setError("");
                }}
              >
                {item.name}
              </button>
            ))}
          </div>
          <div>
            <p className="text-xs text-[var(--muted)]">{wallet.role === "owner" ? "Owner wallet" : "Agent wallet"}</p>
            <p className="mt-1 break-all text-sm">{wallet.address}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="border border-[var(--ink)] px-3 py-2 text-sm" type="button" onClick={() => { setMode("send"); setError(""); }}>Send</button>
              <button className="border border-[var(--line)] px-3 py-2 text-sm" type="button" onClick={() => void copyAddress()}>Copy address</button>
              <a className="border border-[var(--line)] px-3 py-2 text-sm" href={`https://sepolia.basescan.org/address/${wallet.address}`} target="_blank" rel="noreferrer">View on BaseScan</a>
            </div>
          </div>
          <dl className="sheet">
            <div className="sheet-row flex items-center justify-between gap-3">
              <dt>ETH</dt>
              <dd className="font-semibold">{wallet.ethDisplay}</dd>
            </div>
            {wallet.tokens.map((token) => (
              <div key={token.address} className="sheet-row flex items-center justify-between gap-3">
                <dt title={token.name}>{token.symbol}</dt>
                <dd className="font-semibold">{token.display}</dd>
              </div>
            ))}
          </dl>
          {wallet.error ? <p className="text-sm text-[var(--muted)]">{wallet.error}</p> : null}
          {mode === "receive" ? (
            <div className="border border-[var(--line)] p-4 text-sm">
              <p className="font-semibold">Receive</p>
              <p className="mt-2 break-all">{wallet.address}</p>
              <p className="mt-2 text-[var(--muted)]">Send only Base Sepolia ETH and tokens to this address.</p>
            </div>
          ) : null}
          {mode === "send" ? (
            <form
              className="space-y-3 border border-[var(--line)] p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <p className="text-sm font-semibold">Send</p>
              <label className="block text-xs text-[var(--muted)]">
                Asset
                <select className="mt-1 w-full px-3 py-2 text-sm" value={asset.key} onChange={(event) => { setAssetKey(event.target.value); setAmount(""); }}>
                  {assets.map((item) => <option key={item.key} value={item.key}>{item.symbol} · {item.display}</option>)}
                </select>
              </label>
              <label className="block text-xs text-[var(--muted)]">
                Amount
                <span className="mt-1 flex gap-2">
                  <input className="min-w-0 flex-1 px-3 py-2 text-sm" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
                  <button className="border border-[var(--ink)] px-3 py-2 text-sm" type="button" onClick={() => setAmount(formatTokenAmount(asset.raw, asset.decimals, asset.decimals))}>Max</button>
                </span>
              </label>
              <label className="block text-xs text-[var(--muted)]">
                To
                <input className="mt-1 w-full px-3 py-2 text-sm" value={destination} placeholder="0x" onChange={(event) => setDestination(event.target.value)} />
              </label>
              <p className="text-xs text-[var(--muted)]">Privy asks you to confirm. Gas is paid in ETH from this wallet.</p>
              <button className="bg-[var(--ink)] px-4 py-2 text-sm text-[var(--paper)] disabled:opacity-50" disabled={busy} type="submit">{busy ? "Waiting for the wallet…" : "Send"}</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="alert alert-error mt-4" role="alert">{error}</p> : null}
    </section>
  );
}
