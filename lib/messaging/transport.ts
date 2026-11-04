/**
 * Owner chat uses the XMTP backend when its URL is set.
 * The browser opens the client. The URL alone does not send a message.
 */
export function messagingMode(): "xmtp" | "sealed-envelope" {
  return xmtpBackendUrl() ? "xmtp" : "sealed-envelope";
}

export function xmtpBackendUrl(): string | null {
  return process.env.XMTP_BACKEND_URL || null;
}
