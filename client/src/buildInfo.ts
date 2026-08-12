/**
 * Version/build stamps baked into the bundle by Vite's `define`
 * (see vite.config.ts) and shown in the About dialog. The `typeof` guards keep
 * this importable from contexts that skip the substitution (e.g. a bare `tsc`
 * run), where the fields fall back to `"unknown"`.
 */
export const BUILD_INFO = {
  version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown",
  /** ISO-8601 UTC instant the bundle was built. */
  builtAt: typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "",
  commit: typeof __GIT_COMMIT__ === "string" ? __GIT_COMMIT__ : "unknown",
};

/**
 * Render a build stamp as `YYYY-MM-DD HH:MM` in the viewer's own timezone — the
 * stamp is stored in UTC, but "when was this built" is easier to place against
 * local wall-clock time. Unparseable input is passed through unchanged so a
 * missing or malformed stamp still shows *something* rather than "Invalid Date".
 */
export function formatBuildTime(iso: string): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}
