export type HireImageRef = { path: string; imageId: string; sourceAgentId: string };

const MARK = /\[\[image:([a-f0-9]+)\]\]/g;
const FORWARD = /\b(?:forward|include|attach|send|give)\b[\s\S]{0,80}\b(?:image|picture|png|photo)\b|\buse (?:this|that|the|my) (?:image|picture|png|photo)\b/i;

export const MAX_HIRE_IMAGES = 4;
export const MAX_IMAGE_DATA_URL = 1_500_000;

export function chatImageKey(agentId: string, imageId: string): string {
  return `chat-image:${agentId}:${imageId}`;
}

export function imageIdsIn(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(MARK)) {
    const id = match[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Markers named in the brief win. Otherwise a forward request uses the latest image in the thread. */
export function hireImageIds(brief: string, transcript: string): string[] {
  const named = imageIdsIn(brief);
  if (named.length) return named.slice(0, MAX_HIRE_IMAGES);
  if (!FORWARD.test(brief)) return [];
  return imageIdsIn(transcript).slice(-1);
}

export function imageFilePath(index: number, dataUrl: string): string {
  const mime = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(dataUrl)?.[1]?.toLowerCase() ?? "image/png";
  const ext = mime.endsWith("jpeg") || mime.endsWith("jpg") ? "jpg" : mime.endsWith("webp") ? "webp" : mime.endsWith("gif") ? "gif" : "png";
  return `inputs/image-${index + 1}.${ext}`;
}

export function criteriaWithImages(criteria: string, paths: string[]): string {
  const clean = criteria.replace(MARK, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!paths.length) return clean;
  return `${clean}\n\nThe hirer attached these files in the sandbox. Use them in the delivery:\n${paths.join("\n")}`;
}
