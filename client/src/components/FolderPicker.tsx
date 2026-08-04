import { useEffect, useState } from "react";

import { listDir } from "../net/rest";
import type { FsListing } from "../protocol";
import { Modal } from "./Modal";

/**
 * Browse the *hosting machine's* filesystem to choose a working directory.
 * The agent process runs on the server, so the tree shown is the server's, not
 * the local machine's — listings are fetched over the authed REST endpoint.
 */
export function FolderPicker({
  service,
  initialPath,
  onPick,
  onClose,
}: {
  service: { url: string; token: string };
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | undefined>(initialPath);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Entering a new directory resets the filter (its entries are unrelated).
    setFilter("");
    listDir(service, path)
      .then((l) => {
        if (cancelled) return;
        setListing(l);
        // Adopt the canonical path the server resolved (e.g. when we opened the
        // default home dir with no path).
        setPath(l.path);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const q = filter.trim().toLowerCase();

  return (
    <Modal
      title="Choose working directory"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!listing}
            onClick={() => listing && onPick(listing.path)}
          >
            Select this folder
          </button>
        </>
      }
    >
      <div className="fs-picker">
        <div className="fs-picker__path" title={listing?.path ?? path}>
          {listing?.path ?? path ?? "…"}
        </div>

        {error && <p className="hint hint--error">{error}</p>}

        <input
          className="fs-picker__filter"
          type="text"
          value={filter}
          placeholder="Filter…"
          aria-label="Filter entries"
          onChange={(e) => setFilter(e.target.value)}
        />

        <div className="fs-picker__list">
          <button
            className="fs-row fs-row--up"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && setPath(listing.parent)}
          >
            ⬆ Parent directory
          </button>

          {loading && <p className="hint">Loading…</p>}

          {!loading &&
            listing?.entries
              .filter((e) => e.name.toLowerCase().includes(q))
              .map((e) =>
                e.is_dir ? (
                  <button
                    key={e.path}
                    className="fs-row fs-row--dir"
                    onClick={() => setPath(e.path)}
                  >
                    📁 {e.name}
                  </button>
                ) : (
                  <div key={e.path} className="fs-row fs-row--file">
                    📄 {e.name}
                  </div>
                ),
              )}

          {!loading && listing?.entries.length === 0 && (
            <p className="hint">Empty directory.</p>
          )}
          {!loading &&
            !!listing?.entries.length &&
            listing.entries.filter((e) => e.name.toLowerCase().includes(q))
              .length === 0 && <p className="hint">No matching entries.</p>}
        </div>
      </div>
    </Modal>
  );
}
