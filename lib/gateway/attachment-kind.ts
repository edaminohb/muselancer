/** Kinds the owner can attach to one chat turn. These files are not workspace files. */

export const MAX_ATTACHMENTS = 8;

export function attachmentKind(name: string): "text" | "image" | "voice" | null {
  const base = name.trim().split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (/\.(md|txt|csv)$/.test(base)) return "text";
  if (/\.(png|jpe?g|webp|gif)$/.test(base)) return "image";
  if (/\.(wav|mp3|m4a|ogg|webm)$/.test(base)) return "voice";
  return null;
}

export function attachmentName(name: string): string {
  const base = name.trim().split(/[/\\]/).pop() || "file";
  return base.slice(0, 120);
}
