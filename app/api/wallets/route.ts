import { NextResponse } from "next/server";
import { readWallet } from "@/lib/chain/wallet-read";
import { walletCards } from "@/lib/chain/wallet";
import { listOwned } from "@/lib/server/register";
import { currentSession } from "@/lib/server/session";

export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  let agents: { id: string; name: string; agentWallet: string }[] = [];
  try {
    agents = await listOwned(session.ownerAddress);
  } catch {
    agents = [];
  }
  const cards = walletCards(session.ownerAddress, session.agentWallet, agents);
  const wallets = await Promise.all(cards.map(async (card) => {
    const snapshot = await readWallet(card.address);
    return { ...card, ...snapshot };
  }));
  return NextResponse.json({
    network: "Base Sepolia",
    wallets,
  });
}
