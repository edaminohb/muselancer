/** Base Sepolia ERC-8004 Identity Registry. */
export const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const IDENTITY_CHAIN_ID = 84532;

/** ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Implementation behind the identity registry proxy, read from the ERC-1967 slot on 2026-10-28.
 * Discovery stops when this address changes.
 */
export const IDENTITY_IMPLEMENTATION = "0x7274e874CA62410a93Bd8bf61c69d8045E399c02";

/** Circle USDC on Base Sepolia. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Base Commerce Payments AuthCaptureEscrow, same address on Base and Base Sepolia. */
export const AUTH_CAPTURE_ESCROW = "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff";

/** ERC-3009 collector used to pull USDC into the escrow. */
export const ERC3009_COLLECTOR = "0x0E3dF9510de65469C4518D7843919c0b8C7A7757";

/** Immediate x402 exact proxy. Not used for hires. */
export const X402_EXACT_PERMIT2_PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";

export const OPERATOR_DOMAIN = "MuselancerOperator.v1";
export const MEMORY_HEAD_KEY = "memoryHead";
