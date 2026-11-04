import { readDocument, writeDocument } from "../db";
import { scanPlaintext } from "../gateway/llama";
import { createMailboxKey, exportMailbox, importMailbox, openEnvelope, relayView, type Envelope, type MailboxKey } from "./seal";

type StoredMailbox = { publicSpki: string; privatePkcs8: string };

async function agentMailbox(agentId: string): Promise<MailboxKey> {
  const raw = await readDocument(`mailbox-secret:${agentId}`);
  if (raw) return importMailbox(JSON.parse(raw) as StoredMailbox);
  const created = await createMailboxKey();
  await writeDocument(`mailbox-secret:${agentId}`, JSON.stringify(await exportMailbox(created)));
  return created;
}

async function loadEnvelopes(agentId: string): Promise<Envelope[]> {
  const raw = await readDocument(`mailbox:${agentId}`);
  return raw ? (JSON.parse(raw) as Envelope[]) : [];
}

export async function agentPublicSpki(agentId: string): Promise<string> {
  return (await agentMailbox(agentId)).publicSpki;
}

/** Store the owner's sealed message. The agent speaks through the model, not a prepared line. */
export async function acceptOwnerEnvelope(input: { agentId: string; envelope: Envelope; ownerSpki: string }): Promise<Envelope[]> {
  const agent = await agentMailbox(input.agentId);
  const plaintext = await openEnvelope(input.envelope, agent.privateKey);
  const scan = scanPlaintext(plaintext, "text");
  if (!scan.allow) throw new Error(scan.reason);
  const envelopes = [...(await loadEnvelopes(input.agentId)), relayView(input.envelope)];
  await writeDocument(`mailbox:${input.agentId}`, JSON.stringify(envelopes));
  return envelopes.map(relayView);
}
