import { useState } from "react";

import { probeService } from "../net/rest";
import {
  buildServiceUrl,
  DEFAULT_PORT,
  isValidServiceTag,
  parseServiceUrl,
  type ServiceAddr,
} from "../net/url";
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
  const probeTimeoutMs = useStore((s) => s.settings.probeTimeoutMs);
  const editing = service !== undefined;

  const initial: ServiceAddr = service
    ? parseServiceUrl(service.url)
    : { protocol: "https", host: "", port: "" };
  const [name, setName] = useState(service?.name ?? "");
  const [protocol, setProtocol] = useState<ServiceAddr["protocol"]>(
    initial.protocol,
  );
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(initial.port);
  const [token, setToken] = useState(service?.token ?? "");
  const [tag, setTag] = useState(service?.tag ?? "");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const portOk = port.trim() === "" || /^\d+$/.test(port.trim());
  const tagOk = tag === "" || isValidServiceTag(tag);
  const valid = name.trim() !== "" && host.trim() !== "" && portOk && tagOk;

  const submit = async () => {
    if (!valid || verifying) return;
    const url = buildServiceUrl({ protocol, host, port });
    const svc = {
      name: name.trim(),
      url,
      token,
      tag: tag === "" ? undefined : tag,
    };
    setVerifying(true);
    setError(undefined);
    let certFingerprint: string | undefined;
    try {
      // Trust-on-first-use: the probe captures the server's leaf-cert
      // fingerprint, which we persist so every later connection can pin it.
      ({ certFingerprint } = await probeService(svc, probeTimeoutMs));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVerifying(false);
      return;
    }
    // Verified — commit to the store. The pool observes it and (re)connects.
    const verified = { ...svc, certFingerprint };
    if (editing) updateService(service.id, verified);
    else addService(verified);
    onClose();
  };

  return (
    <Modal
      title={editing ? "Edit hosting service" : "Add hosting service"}
      onClose={onClose}
      onSubmit={submit}
      dismissOnScrimClick={false}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={verifying}
          >
            Cancel
          </button>
          <button
            type="button"
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
      <div className="field">
        <span>Protocol</span>
        <div className="radio-row">
          <label>
            <input
              type="radio"
              name="protocol"
              checked={protocol === "https"}
              onChange={() => setProtocol("https")}
            />
            https
          </label>
          <label>
            <input
              type="radio"
              name="protocol"
              checked={protocol === "http"}
              onChange={() => setProtocol("http")}
            />
            http
          </label>
        </div>
      </div>
      <div className="field">
        <span>Address</span>
        <div className="field__row">
          <input
            value={host}
            placeholder="hostname or IP"
            onChange={(e) => setHost(e.target.value)}
          />
          <input
            className="field__port"
            value={port}
            placeholder={DEFAULT_PORT}
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
      </div>
      <label className="field">
        <span>Token</span>
        <input
          value={token}
          type="password"
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <label className="field">
        <span>TAG</span>
        <input
          value={tag}
          placeholder="worker-a"
          readOnly={editing}
          aria-label="TAG"
          onChange={(e) => setTag(e.target.value)}
        />
      </label>
      <p className={`hint ${tagOk ? "hint--muted" : "hint--error"}`}>
        {editing
          ? "TAG is immutable. To connect to another TAG, create a new service."
          : tagOk
            ? "1–64 letters, digits, _ or -, starting with a letter or digit. Required for repeaters; optional for direct workers. Cannot be changed after creation."
            : "Invalid TAG. Use 1–64 letters, digits, _ or -, starting with a letter or digit."}
      </p>
      {error && <p className="hint hint--error">{error}</p>}
    </Modal>
  );
}
