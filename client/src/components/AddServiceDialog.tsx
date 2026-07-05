import { useState } from "react";

import { probeService } from "../net/rest";
import { useStore } from "../store/store";
import type { Service } from "../store/types";
import { Modal } from "./Modal";

/**
 * Add a new hosting service, or (when `service` is given) edit an existing one.
 * In both cases the URL+token are verified against the server before the store
 * is touched: a wrong token or unreachable address reports the error inline and
 * keeps the dialog open instead of registering a service that can never connect.
 */
export function AddServiceDialog({
  service,
  onClose,
}: {
  service?: Service;
  onClose: () => void;
}) {
  const addService = useStore((s) => s.addService);
  const updateService = useStore((s) => s.updateService);
  const editing = service !== undefined;

  const [name, setName] = useState(service?.name ?? "");
  const [url, setUrl] = useState(service?.url ?? "http://127.0.0.1:8787");
  const [token, setToken] = useState(service?.token ?? "dev-token");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const valid = name.trim() !== "" && /^https?:\/\//i.test(url.trim());

  const submit = async () => {
    if (!valid || verifying) return;
    const svc = { name: name.trim(), url: url.trim(), token };
    setVerifying(true);
    setError(undefined);
    try {
      await probeService(svc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVerifying(false);
      return;
    }
    // Verified — commit to the store. The pool observes it and (re)connects.
    if (editing) updateService(service.id, svc);
    else addService(svc);
    onClose();
  };

  return (
    <Modal
      title={editing ? "Edit hosting service" : "Add hosting service"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={verifying}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!valid || verifying}
            onClick={submit}
          >
            {verifying ? "Verifying…" : editing ? "Save" : "Add"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          placeholder="Laptop / prod-box"
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>
      <label className="field">
        <span>URL</span>
        <input
          value={url}
          placeholder="http://host:8787"
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Token</span>
        <input
          value={token}
          type="password"
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {error && <p className="hint hint--error">{error}</p>}
    </Modal>
  );
}
