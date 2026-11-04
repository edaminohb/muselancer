import { asArrayBuffer, base64UrlToBytes, bytesToBase64Url } from "./b64";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function subtle(): SubtleCrypto {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("Web Crypto is not available.");
  return cryptoApi.subtle;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

async function importAes(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", asArrayBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function aesEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomBytes(12);
  const encrypted = await subtle().encrypt({ name: "AES-GCM", iv: asArrayBuffer(iv) }, await importAes(key), asArrayBuffer(plaintext));
  return { iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(new Uint8Array(encrypted)) };
}

export async function aesDecrypt(key: Uint8Array, iv: string, ciphertext: string): Promise<Uint8Array> {
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(base64UrlToBytes(iv)) },
    await importAes(key),
    asArrayBuffer(base64UrlToBytes(ciphertext)),
  );
  return new Uint8Array(plain);
}

export type PasswordWrap = { salt: string; iv: string; ciphertext: string };

export async function wrapKey(raw: Uint8Array, password: string): Promise<PasswordWrap> {
  const salt = randomBytes(16);
  const key = await passwordKey(password, salt);
  const sealed = await aesEncrypt(key, raw);
  return { salt: bytesToBase64Url(salt), ...sealed };
}

export async function unwrapKey(wrapped: PasswordWrap, password: string): Promise<Uint8Array> {
  const key = await passwordKey(password, base64UrlToBytes(wrapped.salt));
  return aesDecrypt(key, wrapped.iv, wrapped.ciphertext);
}

async function passwordKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const base = await subtle().importKey("raw", asArrayBuffer(textEncoder.encode(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "PBKDF2", salt: asArrayBuffer(salt), iterations: 100_000, hash: "SHA-256" },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export function encodeText(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function decodeText(value: Uint8Array): string {
  return textDecoder.decode(value);
}
