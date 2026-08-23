import { useState } from "react";

import { probeService, upgradeFromUrl } from "../net/rest";
import { uploadBinaryUpgrade } from "../net/transfer";
import { useStore } from "../store/store";
import type { Service } from "../store/types";
import { Modal } from "./Modal";

type Source = "upload" | "url";
type Phase = "idle" | "sending" | "waiting" | "done" | "error";

/** How long to keep re-probing `/health` for the upgraded server to come back. */
const WAIT_TIMEOUT_MS = 30_000;
const WAIT_INTERVAL_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Push a new server binary to a host and restart it in place. The binary comes
 * either from a locally-picked file (uploaded raw) or a URL the *host* downloads.
 * On success the server validates, swaps its own executable, and re-execs —
 * keeping live tasks — so the connection blips and auto-reconnects. After the
 * request lands we re-probe `/health` until the new version answers, and show it
 * as confirmation.
 */
export function UpgradeHostDialog({
  service,
  onClose,
}: {
  service: Service;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source>("upload");
  const [url, setUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | undefined>();
  const [newVersion, setNewVersion] = useState<string | undefined>();
  const probeTimeoutMs = useStore((s) => s.settings.probeTimeoutMs);

  const busy = phase === "sending" || phase === "waiting";
  const urlValid = source === "url" ? url.trim() !== "" : true;

  // Poll the upgraded server until it answers again, then surface its version.
  const waitForServer = async () => {
    setPhase("waiting");
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    // Give the server its ~500ms pre-exec delay plus a moment to rebind.
    await sleep(WAIT_INTERVAL_MS);
    for (;;) {
      try {
        const { info } = await probeService(service, probeTimeoutMs);
        setNewVersion(info.version);
        setPhase("done");
        return;
      } catch {
        if (Date.now() > deadline) {
          // The host may still be restarting; the sidebar's auto-reconnect will
          // recover it. Report a soft failure rather than blocking the dialog.
          setError("Server did not come back in time — it may still be restarting.");
          setPhase("error");
          return;
        }
        await sleep(WAIT_INTERVAL_MS);
      }
    }
  };

  const submit = async () => {
    if (busy) return;
    setError(undefined);
    setPhase("sending");
    try {
      if (source === "upload") {
        const sent = await uploadBinaryUpgrade(service);
        if (!sent) {
          setPhase("idle"); // user cancelled the file picker
          return;
        }
      } else {
        await upgradeFromUrl(service, url.trim(), sha256.trim() || undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      return;
    }
    await waitForServer();
  };

  const primaryLabel =
    phase === "sending"
      ? source === "upload"
        ? "Uploading…"
        : "Sending…"
      : phase === "waiting"
        ? "Restarting…"
        : source === "upload"
          ? "Choose binary & upgrade"
          : "Download & upgrade";

  return (
    <Modal
      title="Upgrade host"
      onClose={onClose}
      onSubmit={submit}
      dismissOnScrimClick={false}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {phase === "done" ? "Close" : "Cancel"}
          </button>
          {phase !== "done" && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !urlValid}
              onClick={submit}
            >
              {primaryLabel}
            </button>
          )}
        </>
      }
    >
      {phase === "done" ? (
        <p className="hint">
          Upgrade complete. Server is back online
          {newVersion ? ` on version ${newVersion}` : ""}. Running tasks were
          preserved.
        </p>
      ) : (
        <>
          <div className="field">
            <span>Source</span>
            <div className="radio-row">
              <label>
                <input
                  type="radio"
                  name="upgrade-source"
                  checked={source === "upload"}
                  onChange={() => setSource("upload")}
                  disabled={busy}
                />
                Upload binary
              </label>
              <label>
                <input
                  type="radio"
                  name="upgrade-source"
                  checked={source === "url"}
                  onChange={() => setSource("url")}
                  disabled={busy}
                />
                From URL
              </label>
            </div>
          </div>
          {source === "url" && (
            <>
              <label className="field">
                <span>Binary URL</span>
                <input
                  value={url}
                  placeholder="https://…/switchboard-server"
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={busy}
                  autoFocus
                />
              </label>
              <label className="field">
                <span>SHA-256 (optional)</span>
                <input
                  value={sha256}
                  placeholder="hex digest to verify the download"
                  onChange={(e) => setSha256(e.target.value)}
                  disabled={busy}
                />
              </label>
            </>
          )}
          {source === "upload" && (
            <p className="hint">
              Pick a locally-built <code>switchboard-server</code> binary for this
              host's OS and architecture. It's validated before anything is
              replaced.
            </p>
          )}
          {phase === "waiting" && (
            <p className="hint">Server restarting — reconnecting…</p>
          )}
          {error && <p className="hint hint--error">{error}</p>}
        </>
      )}
    </Modal>
  );
}
