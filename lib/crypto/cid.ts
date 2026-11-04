import { sha256 } from "viem";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** CIDv1 for raw bytes: multibase base32, codec raw, sha2-256. */
export function cidForBytes(bytes: Uint8Array): string {
  const digestHex = sha256(bytes).slice(2);
  const digest = Uint8Array.from(digestHex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
  const multihash = new Uint8Array(2 + digest.length);
  multihash[0] = 0x12;
  multihash[1] = 0x20;
  multihash.set(digest, 2);
  const cid = new Uint8Array(2 + multihash.length);
  cid[0] = 0x01;
  cid[1] = 0x55;
  cid.set(multihash, 2);
  return `b${base32(cid)}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
