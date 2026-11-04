import { getAddress } from "viem";
import { readDocument, writeDocument } from "../db";
import { scanUntrusted } from "../gateway/firewall";

export type OwnerCard = { displayName: string; bio: string };

function key(owner: string): string {
  return `owner-profile:${getAddress(owner).toLowerCase()}`;
}

export async function readOwnerCard(owner: string): Promise<OwnerCard> {
  const raw = await readDocument(key(owner));
  if (!raw) return { displayName: "", bio: "" };
  try {
    const parsed = JSON.parse(raw) as Partial<OwnerCard>;
    return {
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : "",
      bio: typeof parsed.bio === "string" ? parsed.bio : "",
    };
  } catch {
    return { displayName: "", bio: "" };
  }
}

export async function saveOwnerCard(owner: string, input: OwnerCard): Promise<OwnerCard> {
  const displayName = input.displayName.trim();
  const bio = input.bio.trim();
  if (displayName.length > 80) throw new Error("The display name is too long.");
  if (bio.length > 600) throw new Error("The biography is too long.");
  for (const text of [displayName, bio]) {
    if (!text) continue;
    const scan = scanUntrusted(text);
    if (!scan.allow) throw new Error(scan.reason);
  }
  const card = { displayName, bio };
  await writeDocument(key(owner), JSON.stringify(card));
  return card;
}
