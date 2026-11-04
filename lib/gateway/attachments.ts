/** Chat attachments stay out of the workspace. They belong to this turn. */

const IMAGE_CAP = 3_500_000;
const VOICE_CAP = 2_500_000;

export function readImageDataUrl(value: string): { mediaType: string; dataUrl: string } {
  if (typeof value !== "string") throw new Error("Send a PNG, JPEG, WebP, or GIF image.");
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value.trim());
  if (!match) throw new Error("Send a PNG, JPEG, WebP, or GIF image.");
  const payload = (match[2] ?? "").replace(/\s/g, "");
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < 16 || bytes.length > IMAGE_CAP) throw new Error("That image is too large.");
  const mediaType = match[1] === "image/jpg" ? "image/jpeg" : (match[1] ?? "image/png");
  return { mediaType, dataUrl: `data:${mediaType};base64,${payload}` };
}

export function readVoiceWav(value: string): Uint8Array {
  if (typeof value !== "string" || !value.trim()) throw new Error("Send a voice message.");
  const bytes = Buffer.from(value.replace(/\s/g, ""), "base64");
  if (bytes.length > VOICE_CAP) throw new Error("That voice message is too large.");
  const head = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (bytes.length < 44 || !head.startsWith("RIFF") || head.slice(8, 12) !== "WAVE") throw new Error("Send a voice message as WAV audio.");
  return new Uint8Array(bytes);
}
