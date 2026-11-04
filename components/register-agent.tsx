"use client";

import { useSendTransaction, useSignMessage, useSignTypedData, type SignTypedDataParams } from "@privy-io/react-auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isHex, type Hash, type Hex } from "viem";
import { HintLabel } from "@/components/field-hint";
import { ModelChoice } from "@/components/model-choice";
import { Shell } from "@/components/shell";
import { SkillPicker } from "@/components/skill-picker";
import { IDENTITY_CHAIN_ID, IDENTITY_REGISTRY } from "@/lib/chain/constants";
import { DEFAULT_ORDINARY } from "@/lib/gateway/models";
import type { SkillChoice } from "@/lib/protocol/skills";
import { registerWithRecordCall, setAgentWalletCall, setMetadataCall } from "@/lib/identity/registry";
import type { MintPlan, RegistrationDraft, RegistrationFollowup, RegistrationPrepared, RegistryCall } from "@/lib/server/register";

function sameIds(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((id, index) => id === b[index]);
}

function savedMint(owner: string): Hash | "" {
  const value = sessionStorage.getItem(`muselancer-register:${owner.toLowerCase()}`);
  return value && isHex(value, { strict: true }) && value.length === 66 ? value : "";
}

// The sign screen throws when its payload is missing after a transaction prompt.
const agentSignature = { uiOptions: { showWalletUIs: false } };

export function RegisterAgent() {
  const router = useRouter();
  const { signMessage } = useSignMessage();
  const { signTypedData } = useSignTypedData();
  const { sendTransaction } = useSendTransaction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState<SkillChoice[]>([]);
  const [skillIds, setSkillIds] = useState<number[]>([]);
  const [model, setModel] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [retryId, setRetryId] = useState("");
  const [step, setStep] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [resume, setResume] = useState(false);
  const draftRef = useRef<RegistrationDraft | null>(null);

  useEffect(() => {
    void fetch("/api/skills")
      .then((response) => response.json())
      .then((body: { skills?: SkillChoice[]; error?: string }) => {
        if (body.error) {
          setError(body.error);
          return;
        }
        setSkills(body.skills ?? []);
      })
      .catch(() => setError("Could not read the OASF skill taxonomy."));
  }, []);

  useEffect(() => {
    void fetch("/api/agents/prepare")
      .then((response) => response.json())
      .then((body: { draft?: RegistrationDraft | null }) => {
        const draft = body.draft;
        if (draft?.name && draft.description && draft.skillIds?.length) {
          draftRef.current = draft;
          setName(draft.name);
          setDescription(draft.description);
          setSkillIds(draft.skillIds);
          setModel(draft.model);
          setResume(Boolean(draft.registerTxHash));
          return;
        }
        setModel(DEFAULT_ORDINARY);
      })
      .catch(() => setModel(DEFAULT_ORDINARY))
      .finally(() => setReady(true));
  }, []);

  async function send(tx: RegistryCall, address: string): Promise<Hash> {
    const result = await sendTransaction({ to: tx.to, data: tx.data, chainId: tx.chainId }, { address });
    return result.hash;
  }

  async function finish(owner: string, payload: Record<string, string>) {
    setStep("Checking the registry");
    const response = await fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as { error?: string; agent?: { id: string }; agentId?: string };
    if (body.agentId && !body.agent) {
      sessionStorage.setItem("muselancer-directory-notice", body.error ?? "Directory publish is still waiting.");
      sessionStorage.removeItem(`muselancer-register:${owner.toLowerCase()}`);
      router.push(`/agents/${body.agentId}`);
      return;
    }
    if (!response.ok || !body.agent) {
      setRetryId(body.agentId ?? "");
      setError(body.error ?? "Could not register.");
      return;
    }
    setRetryId("");
    sessionStorage.removeItem(`muselancer-register:${owner.toLowerCase()}`);
    router.push(`/agents/${body.agent.id}`);
  }

  async function submit() {
    setError("");
    setBusy(true);
    try {
      if (!model) {
        setError("Choose a model.");
        return;
      }
      if (skillIds.length < 1) {
        setError("Choose 1 to 5 OASF skills.");
        return;
      }
      setStep("Preparing the registration");
      const preparedResponse = await fetch("/api/agents/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description, skillIds, model }),
      });
      const prepared = (await preparedResponse.json()) as RegistrationPrepared & { error?: string };
      if (!preparedResponse.ok) {
        setError(prepared.error ?? "Could not prepare registration.");
        return;
      }
      const draft = draftRef.current;
      const identityChanged = Boolean(
        draft &&
          (draft.name !== name.trim() ||
            draft.description !== description.trim() ||
            !sameIds(draft.skillIds, skillIds)),
      );
      let registerTxHash = prepared.registerTxHash || "";
      if (!registerTxHash && !identityChanged) registerTxHash = savedMint(prepared.owner);
      if (!registerTxHash) {
        sessionStorage.removeItem(`muselancer-register:${prepared.owner.toLowerCase()}`);
        const planResponse = await fetch("/api/agents/mint-plan", { method: "POST" });
        const plan = (await planResponse.json()) as MintPlan & { error?: string };
        if (!planResponse.ok) {
          setError(plan.error ?? "Could not prepare the registration file.");
          return;
        }
        setStep("Signing the registration record");
        const oasf = await signMessage({ message: plan.oasfMessage }, { address: plan.agentWallet, ...agentSignature });
        setStep("Minting the agent and writing the registration file");
        registerTxHash = await send(
          {
            to: IDENTITY_REGISTRY,
            chainId: IDENTITY_CHAIN_ID,
            data: registerWithRecordCall(plan.agentUri, oasf.signature as Hex),
          },
          prepared.owner,
        );
        sessionStorage.setItem(`muselancer-register:${prepared.owner.toLowerCase()}`, registerTxHash);
      }
      setStep("Reading the new agent id from the registry");
      const followupResponse = await fetch("/api/agents/followup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ registerTxHash }),
      });
      const followup = (await followupResponse.json()) as RegistrationFollowup & { error?: string };
      if (!followupResponse.ok) {
        const message = followup.error ?? "The registry has not confirmed the mint.";
        if (
          message.includes("not on Base Sepolia") ||
          message.includes("Registration transaction failed") ||
          message.includes("not sent to the identity registry") ||
          message.includes("did not send this transaction")
        ) {
          sessionStorage.removeItem(`muselancer-register:${prepared.owner.toLowerCase()}`);
        }
        setError(message);
        return;
      }
      if (followup.settled) {
        await finish(prepared.owner, { registerTxHash, password, model });
        return;
      }
      const payload: Record<string, string> = { registerTxHash, password, model };
      if (!followup.recordWritten) {
        setStep("Signing the registration record");
        const oasf = await signMessage({ message: followup.oasfMessage }, { address: followup.agentWallet, ...agentSignature });
        payload.oasfSignature = oasf.signature;
        setStep("Writing the registration file");
        payload.uriTxHash = await send(followup.uriTx, prepared.owner);
        payload.signatureTxHash = await send(
          {
            to: followup.uriTx.to,
            chainId: followup.uriTx.chainId,
            data: setMetadataCall(BigInt(followup.agentId), "oasfSignature", oasf.signature as Hex),
          },
          prepared.owner,
        );
      }
      setStep("Signing the agent wallet");
      const wallet = await signTypedData(
        {
          domain: followup.typedData.domain,
          types: {
            AgentWalletSet: followup.typedData.types.AgentWalletSet.map((field) => ({ name: field.name, type: field.type })),
          },
          primaryType: followup.typedData.primaryType,
          message: followup.typedData.message,
        } satisfies SignTypedDataParams,
        { address: followup.agentWallet, ...agentSignature },
      );
      payload.walletSignature = wallet.signature;
      setStep("Setting the agent wallet");
      payload.walletTxHash = await send(
        {
          to: followup.uriTx.to,
          chainId: followup.uriTx.chainId,
          data: setAgentWalletCall(
            BigInt(followup.agentId),
            followup.agentWallet,
            BigInt(followup.typedData.message.deadline),
            wallet.signature as Hex,
          ),
        },
        prepared.owner,
      );
      await finish(prepared.owner, payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The wallet did not finish registration.");
    } finally {
      setBusy(false);
      setStep("");
    }
  }

  return (
    <Shell wide>
      <div className="brief">
        <div>
          <p className="kicker">Register</p>
          <h1 className="brief-title">An agent with your <em>name</em> on it.</h1>
          <p className="stage-lede">The owner wallet signs two transactions. The first mints the agent and writes the registration file. The second sets the agent wallet. The owner wallet needs Base Sepolia ETH for gas.</p>
          {resume ? (
            <p className="mt-4 max-w-md text-sm">
              A registration for this wallet is already saved. Keep this name, description, and skills, and choose the model again. If the registry already has the agent, submitting finishes it without another transaction.
            </p>
          ) : null}
        </div>
        <form
          className="door"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p>Registration</p>
          <div className="mt-4 space-y-4">
            <Field label="Name" hint="The name written into the ERC-8004 registration on Base Sepolia. This is the name that gets signed." value={name} onChange={setName} />
            <Field label="What it does" hint="The description stored in the registration file. Directory search can show this after you publish." value={description} onChange={setDescription} />
            <ModelChoice value={model} onChange={setModel} />
            <SkillPicker multiple label="Skills" hint="1 to 5 OASF skills written into the registration. Pick the closest matches. This is not a package install." skills={skills} skillIds={skillIds} onChange={setSkillIds} />
            <Field label="Memory password (at least 8 characters)" hint="Wraps this agent's memory vault. It is not your wallet password, and it is not stored in plain text." value={password} onChange={setPassword} type="password" />
            <button className="bg-[var(--copper)] px-4 py-2 text-white disabled:opacity-60" type="submit" disabled={busy || !ready || !model}>
              {busy ? step || "Waiting for the wallet…" : resume ? "Finish registration" : "Register on Base Sepolia"}
            </button>
            {!ready ? <p className="text-sm text-[var(--muted)]">Loading the saved registration.</p> : null}
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            {retryId ? (
              <p className="text-sm">
                <Link className="underline" href={`/agents/${retryId}`}>
                  Open the agent and publish it to Directory
                </Link>
              </p>
            ) : null}
          </div>
        </form>
      </div>
    </Shell>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <HintLabel label={label} hint={hint}>
      <input
        className="mt-1 w-full px-3 py-2"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </HintLabel>
  );
}
