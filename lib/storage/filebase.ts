import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const ENDPOINT = "https://s3.filebase.com";

export function remotePinsEnabled(): boolean {
  return process.env.MUSELANCER_DB !== ":memory:";
}

function setting(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error("Set FILEBASE_ACCESS_KEY.");
  return value;
}

function client(): S3Client {
  return new S3Client({
    endpoint: ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: setting("FILEBASE_ACCESS_KEY"),
      secretAccessKey: setting("FILEBASE_SECRET_KEY"),
    },
  });
}

export async function putFilebaseObject(cid: string, bytes: Uint8Array): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: setting("FILEBASE_BUCKET"),
      Key: cid,
      Body: bytes,
    }),
  );
}

export async function getFilebaseObject(cid: string): Promise<Uint8Array | null> {
  try {
    const stored = await client().send(
      new GetObjectCommand({
        Bucket: setting("FILEBASE_BUCKET"),
        Key: cid,
      }),
    );
    if (!stored.Body) return null;
    return new Uint8Array(await stored.Body.transformToByteArray());
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw error;
  }
}
