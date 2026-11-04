import { encodeFunctionData, type Address, type Hex } from "viem";
import { assertCanSettle, readRuntimeToken } from "../gateway/token";
import { supervisorCoversArtifact, type Verdict } from "./operator";

export const operatorAbi = [
  {
    type: "function",
    name: "captureIfPass",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: [
          { name: "operator", type: "address" },
          { name: "payer", type: "address" },
          { name: "receiver", type: "address" },
          { name: "token", type: "address" },
          { name: "maxAmount", type: "uint120" },
          { name: "preApprovalExpiry", type: "uint48" },
          { name: "authorizationExpiry", type: "uint48" },
          { name: "refundExpiry", type: "uint48" },
          { name: "minFeeBps", type: "uint16" },
          { name: "maxFeeBps", type: "uint16" },
          { name: "feeReceiver", type: "address" },
          { name: "salt", type: "uint256" },
        ],
      },
      { name: "amount", type: "uint256" },
      { name: "taskId", type: "string" },
      { name: "artifactCid", type: "string" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "voidIfFail",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: [
          { name: "operator", type: "address" },
          { name: "payer", type: "address" },
          { name: "receiver", type: "address" },
          { name: "token", type: "address" },
          { name: "maxAmount", type: "uint120" },
          { name: "preApprovalExpiry", type: "uint48" },
          { name: "authorizationExpiry", type: "uint48" },
          { name: "refundExpiry", type: "uint48" },
          { name: "minFeeBps", type: "uint16" },
          { name: "maxFeeBps", type: "uint16" },
          { name: "feeReceiver", type: "address" },
          { name: "salt", type: "uint256" },
        ],
      },
      { name: "taskId", type: "string" },
      { name: "artifactCid", type: "string" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export type PaymentInfo = {
  operator: Address;
  payer: Address;
  receiver: Address;
  token: Address;
  maxAmount: bigint;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: Address;
  salt: bigint;
};

export function captureCall(input: {
  paymentInfo: PaymentInfo;
  amount: bigint;
  taskId: string;
  artifactCid: string;
  signature: Hex;
}): Hex {
  return encodeFunctionData({
    abi: operatorAbi,
    functionName: "captureIfPass",
    args: [input.paymentInfo, input.amount, input.taskId, input.artifactCid, input.signature],
  });
}

export function voidCall(input: { paymentInfo: PaymentInfo; taskId: string; artifactCid: string; signature: Hex }): Hex {
  return encodeFunctionData({
    abi: operatorAbi,
    functionName: "voidIfFail",
    args: [input.paymentInfo, input.taskId, input.artifactCid, input.signature],
  });
}

/** The worker role never reaches capture or void. */
export async function authorizeSettlement(input: {
  token: string;
  taskId: string;
  verdict: Verdict;
  artifactCid: string;
  signature: Hex;
  supervisor: Address;
}): Promise<void> {
  assertCanSettle(readRuntimeToken(input.token));
  const covers = await supervisorCoversArtifact({
    taskId: input.taskId,
    verdict: input.verdict,
    artifactCid: input.artifactCid,
    signature: input.signature,
    supervisor: input.supervisor,
  });
  if (!covers) throw new Error("Supervisor signature does not cover this artifact.");
  if (input.verdict === "needs_revision" || input.verdict === "dispute") {
    throw new Error("This verdict does not capture or void.");
  }
}
