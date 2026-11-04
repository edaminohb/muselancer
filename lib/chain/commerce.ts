import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isHash,
  keccak256,
  toBytes,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  AUTH_CAPTURE_ESCROW,
  ERC3009_COLLECTOR,
  IDENTITY_CHAIN_ID,
  USDC_BASE_SEPOLIA,
} from "./constants";
import { baseClient } from "../identity/chain";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PRE_APPROVAL_SECONDS = 60 * 60;
const CAPTURE_SECONDS = 7 * 24 * 60 * 60;

export const PAYMENT_INFO_TYPE =
  "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)";

export const PAYMENT_INFO_TYPEHASH = keccak256(toBytes(PAYMENT_INFO_TYPE));

export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const paymentInfoComponents = [
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
] as const;

export const authCaptureAbi = [
  {
    type: "function",
    name: "authorize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentInfo", type: "tuple", components: paymentInfoComponents },
      { name: "amount", type: "uint256" },
      { name: "tokenCollector", type: "address" },
      { name: "collectorData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "capture",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentInfo", type: "tuple", components: paymentInfoComponents },
      { name: "amount", type: "uint256" },
      { name: "feeBps", type: "uint16" },
      { name: "feeReceiver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "void",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentInfo", type: "tuple", components: paymentInfoComponents }],
    outputs: [],
  },
] as const;

const eip712DomainAbi = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

export type HireLock = {
  operator: Address;
  payer: Address;
  receiver: Address;
  token: Address;
  maxAmount: string;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: Address;
  salt: Hex;
};

export type UsdcDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

export type ReceiveMessage = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

export function fallbackUsdcDomain(): UsdcDomain {
  return {
    name: "USDC",
    version: "2",
    chainId: IDENTITY_CHAIN_ID,
    verifyingContract: getAddress(USDC_BASE_SEPOLIA),
  };
}

export async function readUsdcDomain(): Promise<UsdcDomain> {
  const fallback = fallbackUsdcDomain();
  try {
    const domain = await baseClient().readContract({
      address: fallback.verifyingContract,
      abi: eip712DomainAbi,
      functionName: "eip712Domain",
    });
    const name = domain[1];
    const version = domain[2];
    const chainId = Number(domain[3]);
    const verifyingContract = getAddress(domain[4]);
    if (!name || !version || chainId !== IDENTITY_CHAIN_ID || verifyingContract !== fallback.verifyingContract) return fallback;
    return { name, version, chainId, verifyingContract };
  } catch {
    return fallback;
  }
}

/** Hash the escrow uses for a payment. The ERC-3009 nonce uses a zero payer. */
export function escrowPaymentHash(lock: HireLock, payer: Address): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint120" },
        { type: "uint48" },
        { type: "uint48" },
        { type: "uint48" },
        { type: "uint16" },
        { type: "uint16" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        PAYMENT_INFO_TYPEHASH,
        getAddress(lock.operator),
        getAddress(payer),
        getAddress(lock.receiver),
        getAddress(lock.token),
        BigInt(lock.maxAmount),
        lock.preApprovalExpiry,
        lock.authorizationExpiry,
        lock.refundExpiry,
        lock.minFeeBps,
        lock.maxFeeBps,
        getAddress(lock.feeReceiver),
        BigInt(lock.salt),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      [BigInt(IDENTITY_CHAIN_ID), getAddress(AUTH_CAPTURE_ESCROW), inner],
    ),
  );
}

export function erc3009Nonce(lock: HireLock): Hex {
  return escrowPaymentHash(lock, ZERO_ADDRESS);
}

export type EscrowCall = { to: Address; data: Hex; chainId: number };

export function buildHireLock(input: {
  payer: Address;
  receiver: Address;
  amount: string;
  operator: Address;
  now: number;
  salt: Hex;
}): HireLock {
  const preApprovalExpiry = input.now + PRE_APPROVAL_SECONDS;
  const authorizationExpiry = input.now + CAPTURE_SECONDS;
  const refundExpiry = authorizationExpiry + CAPTURE_SECONDS;
  return {
    operator: getAddress(input.operator),
    payer: getAddress(input.payer),
    receiver: getAddress(input.receiver),
    token: getAddress(USDC_BASE_SEPOLIA),
    maxAmount: input.amount,
    preApprovalExpiry,
    authorizationExpiry,
    refundExpiry,
    minFeeBps: 0,
    maxFeeBps: 0,
    feeReceiver: getAddress(input.operator),
    salt: input.salt,
  };
}

export function receiveMessage(lock: HireLock): ReceiveMessage {
  return {
    from: lock.payer,
    to: getAddress(ERC3009_COLLECTOR),
    value: lock.maxAmount,
    validAfter: "0",
    validBefore: String(lock.preApprovalExpiry),
    nonce: erc3009Nonce(lock),
  };
}

export type HireRequirement = {
  scheme: "auth-capture";
  network: "eip155:84532";
  asset: Address;
  amount: string;
  payTo: Address;
  receiver: Address;
  maxTimeoutSeconds: number;
  extra: {
    autoCapture: false;
    escrow: Address;
    tokenCollector: Address;
    captureAuthorizer: Address;
    captureDeadline: string;
    refundDeadline: string;
    salt: Hex;
  };
};

export function hireRequirement(lock: HireLock): HireRequirement {
  return {
    scheme: "auth-capture",
    network: "eip155:84532",
    asset: lock.token,
    amount: lock.maxAmount,
    payTo: lock.receiver,
    receiver: lock.receiver,
    maxTimeoutSeconds: PRE_APPROVAL_SECONDS,
    extra: {
      autoCapture: false,
      escrow: getAddress(AUTH_CAPTURE_ESCROW),
      tokenCollector: getAddress(ERC3009_COLLECTOR),
      captureAuthorizer: lock.operator,
      captureDeadline: String(lock.authorizationExpiry),
      refundDeadline: String(lock.refundExpiry),
      salt: lock.salt,
    },
  };
}

function paymentTuple(lock: HireLock) {
  return {
    operator: lock.operator,
    payer: lock.payer,
    receiver: lock.receiver,
    token: lock.token,
    maxAmount: BigInt(lock.maxAmount),
    preApprovalExpiry: lock.preApprovalExpiry,
    authorizationExpiry: lock.authorizationExpiry,
    refundExpiry: lock.refundExpiry,
    minFeeBps: lock.minFeeBps,
    maxFeeBps: lock.maxFeeBps,
    feeReceiver: lock.feeReceiver,
    salt: BigInt(lock.salt),
  };
}

function escrowCall(data: Hex): EscrowCall {
  return { to: getAddress(AUTH_CAPTURE_ESCROW), data, chainId: IDENTITY_CHAIN_ID };
}

/** Calldata for the hirer wallet. The supervisor key does not send this. */
export function authorizeCall(lock: HireLock, signature: Hex): EscrowCall {
  return escrowCall(
    encodeFunctionData({
      abi: authCaptureAbi,
      functionName: "authorize",
      args: [paymentTuple(lock), BigInt(lock.maxAmount), getAddress(ERC3009_COLLECTOR), signature],
    }),
  );
}

export function captureCall(lock: HireLock): EscrowCall {
  return escrowCall(
    encodeFunctionData({
      abi: authCaptureAbi,
      functionName: "capture",
      args: [paymentTuple(lock), BigInt(lock.maxAmount), 0, lock.feeReceiver],
    }),
  );
}

export function voidCall(lock: HireLock): EscrowCall {
  return escrowCall(
    encodeFunctionData({
      abi: authCaptureAbi,
      functionName: "void",
      args: [paymentTuple(lock)],
    }),
  );
}

export async function assertEscrowTransaction(hash: Hash, from: Address, data: Hex): Promise<void> {
  if (!isHash(hash)) throw new Error("Transaction hash is required.");
  const client = baseClient();
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: 45_000, confirmations: 1 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.toLowerCase().includes("not found") || message.toLowerCase().includes("could not be found")) {
      throw new Error("That transaction is not on Base Sepolia.");
    }
    throw new Error("The escrow transaction was not confirmed.");
  }
  if (receipt.status !== "success") throw new Error("The escrow transaction failed.");
  if (!receipt.to || getAddress(receipt.to) !== getAddress(AUTH_CAPTURE_ESCROW)) {
    throw new Error("The transaction was not sent to the escrow.");
  }
  if (getAddress(receipt.from) !== getAddress(from)) throw new Error("The hirer wallet did not send this transaction.");
  const tx = await client.getTransaction({ hash });
  if (tx.input.toLowerCase() !== data.toLowerCase()) throw new Error("The transaction does not match this hire.");
}
