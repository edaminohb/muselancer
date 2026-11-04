export type DirectoryEndpoint = {
  address: string;
  authMode: "" | "tls";
};

/** gRPC target. https:// uses TLS. Any other host:port uses an insecure connection, including the public VPS address. */
export function directoryEndpoint(raw: string | undefined): DirectoryEndpoint {
  const value = raw?.trim() ?? "";
  if (!value) throw new Error("Set DIRECTORY_CLIENT_SERVER_ADDRESS.");
  let authMode: "" | "tls" = "";
  let address = value;
  if (value.startsWith("https://")) {
    authMode = "tls";
    address = value.slice("https://".length);
  } else if (value.startsWith("http://")) {
    address = value.slice("http://".length);
  }
  address = address.replace(/\/$/, "");
  const hasPort = address.startsWith("[") ? /\]:\d+$/.test(address) : /:\d+$/.test(address);
  if (!hasPort) throw new Error("DIRECTORY_CLIENT_SERVER_ADDRESS must include a port.");
  return { address, authMode };
}

/** Tailscale addresses are the CGNAT range 100.64.0.0/10 and the tailnet IPv6 prefix. */
export function isTailnetIp(address: string): boolean {
  const value = address.toLowerCase();
  if (value.startsWith("fd7a:115c:a1e0:")) return true;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}
