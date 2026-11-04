import { asArrayBuffer, base64UrlToBytes, bytesToBase64Url } from "../crypto/b64";

export type MailboxKey = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicSpki: string;
};

export type Envelope = {
  id: string;
  from: string;
  to: string;
  ephemSpki: string;
  iv: string;
  ciphertext: string;
};

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

export async function createMailboxKey(): Promise<MailboxKey> {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const spki = await subtle().exportKey("spki", pair.publicKey);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicSpki: bytesToBase64Url(new Uint8Array(spki)),
  };
}

export async function exportMailbox(key: MailboxKey): Promise<{ publicSpki: string; privatePkcs8: string }> {
  const pkcs8 = await subtle().exportKey("pkcs8", key.privateKey);
  return { publicSpki: key.publicSpki, privatePkcs8: bytesToBase64Url(new Uint8Array(pkcs8)) };
}

export async function importMailbox(stored: { publicSpki: string; privatePkcs8: string }): Promise<MailboxKey> {
  const privateKey = await subtle().importKey(
    "pkcs8",
    asArrayBuffer(base64UrlToBytes(stored.privatePkcs8)),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKey = await subtle().importKey(
    "spki",
    asArrayBuffer(base64UrlToBytes(stored.publicSpki)),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  return { publicKey, privateKey, publicSpki: stored.publicSpki };
}

async function importSpki(spki: string): Promise<CryptoKey> {
  return subtle().importKey(
    "spki",
    asArrayBuffer(base64UrlToBytes(spki)),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

async function sharedKey(privateKey: CryptoKey, publicSpki: string): Promise<Uint8Array> {
  const bits = await subtle().deriveBits({ name: "ECDH", public: await importSpki(publicSpki) }, privateKey, 256);
  return new Uint8Array(bits);
}

export async function sealTo(input: {
  id: string;
  from: string;
  to: string;
  senderPrivate: CryptoKey;
  recipientSpki: string;
  plaintext: string;
}): Promise<Envelope> {
  void input.senderPrivate;
  const ephem = await createMailboxKey();
  const secret = await sharedKey(ephem.privateKey, input.recipientSpki);
  const ivBytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(ivBytes);
  const aes = await subtle().importKey("raw", asArrayBuffer(secret), "AES-GCM", false, ["encrypt"]);
  const encrypted = await subtle().encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(ivBytes) },
    aes,
    asArrayBuffer(new TextEncoder().encode(input.plaintext)),
  );
  return {
    id: input.id,
    from: input.from,
    to: input.to,
    ephemSpki: ephem.publicSpki,
    iv: bytesToBase64Url(ivBytes),
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
  };
}

export async function openEnvelope(envelope: Envelope, recipientPrivate: CryptoKey): Promise<string> {
  const secret = await sharedKey(recipientPrivate, envelope.ephemSpki);
  const aes = await subtle().importKey("raw", asArrayBuffer(secret), "AES-GCM", false, ["decrypt"]);
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(base64UrlToBytes(envelope.iv)) },
    aes,
    asArrayBuffer(base64UrlToBytes(envelope.ciphertext)),
  );
  return new TextDecoder().decode(plain);
}

/** What a relay is allowed to persist. There is no plaintext field. */
export function relayView(envelope: Envelope): Envelope {
  return {
    id: envelope.id,
    from: envelope.from,
    to: envelope.to,
    ephemSpki: envelope.ephemSpki,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
  };
}
