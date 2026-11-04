export function appSecret(): string {
  const value = process.env.MUSELANCER_SECRET?.trim();
  if (!value || value === "replace-me" || value === "muselancer-dev-secret") {
    throw new Error("Set MUSELANCER_SECRET to a long random string.");
  }
  return value;
}
