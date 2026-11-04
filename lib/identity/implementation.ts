import { getAddress, type Address, type Hex } from "viem";
import { IDENTITY_IMPLEMENTATION } from "../chain/constants";

export function implementationFromSlot(slot: Hex): Address {
  if (!/^0x[0-9a-fA-F]{64}$/.test(slot)) throw new Error("Identity registry implementation slot is unreadable.");
  return getAddress(`0x${slot.slice(-40)}`);
}

export function assertPinnedImplementation(slot: Hex): void {
  const current = implementationFromSlot(slot);
  if (current !== getAddress(IDENTITY_IMPLEMENTATION)) {
    throw new Error("Identity registry implementation changed. Discovery is stopped until the pinned implementation is updated.");
  }
}
