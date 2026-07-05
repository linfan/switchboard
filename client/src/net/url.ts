//! Address-input normalization for the connect dialog.
//!
//! HTTPS is the implicit scheme: the macOS WKWebView (ATS) blocks cleartext to
//! remote hosts, so a service is effectively always `https://`. The dialog lets
//! the operator type a bare `host:port` and we fill in the scheme. An explicit
//! `http://` is still honored, for a local/dev server running without TLS.

/** Prepend the implicit `https://` scheme unless one was typed explicitly. */
export function withImplicitHttps(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Inverse of {@link withImplicitHttps} for display: drop a leading `https://`
 * (the implicit default) so the field shows a bare `host:port`, but keep an
 * explicit `http://` visible so http services round-trip unchanged on edit.
 */
export function stripImplicitHttps(url: string): string {
  return url.replace(/^https:\/\//i, "");
}
