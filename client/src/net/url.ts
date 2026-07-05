//! Service-address helpers for the connect dialog.
//!
//! The dialog collects the protocol, host, and port separately (the port is
//! usually the default, so it can be left blank). These convert between that
//! shape and the single URL string persisted per service.

export interface ServiceAddr {
  protocol: "https" | "http";
  host: string;
  /** Empty string means "use the default port". */
  port: string;
}

/** Default hosting-service port; applied when the port field is left blank. */
export const DEFAULT_PORT = "8787";

/** Split a stored service URL into its parts (for editing an existing entry). */
export function parseServiceUrl(url: string): ServiceAddr {
  try {
    const u = new URL(url);
    return {
      protocol: u.protocol === "http:" ? "http" : "https",
      host: u.hostname,
      port: u.port,
    };
  } catch {
    return { protocol: "https", host: "", port: "" };
  }
}

/** Assemble a URL from the dialog fields, defaulting the port when blank. */
export function buildServiceUrl(addr: ServiceAddr): string {
  const host = addr.host.trim();
  const port = addr.port.trim() || DEFAULT_PORT;
  return `${addr.protocol}://${host}:${port}`;
}
