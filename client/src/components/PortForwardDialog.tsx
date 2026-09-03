import { useMemo, useState } from "react";

import { useStore } from "../store/store";
import type { PortForward, Service } from "../store/types";
import { Modal } from "./Modal";

function parsePort(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

export function PortForwardDialog({
  service,
  forward,
  onClose,
}: {
  service: Service;
  forward?: PortForward;
  onClose: () => void;
}) {
  const portForwards = useStore((s) => s.portForwards);
  const addPortForward = useStore((s) => s.addPortForward);
  const updatePortForward = useStore((s) => s.updatePortForward);
  const [localPort, setLocalPort] = useState(
    forward ? String(forward.localPort) : "",
  );
  const [remotePort, setRemotePort] = useState(
    forward ? String(forward.remotePort) : "",
  );
  const [enabled, setEnabled] = useState(forward?.enabled ?? true);

  const parsedLocalPort = parsePort(localPort);
  const parsedRemotePort = parsePort(remotePort);
  const duplicate = useMemo(
    () =>
      parsedLocalPort !== undefined &&
      portForwards.some(
        (item) => item.id !== forward?.id && item.localPort === parsedLocalPort,
      ),
    [forward?.id, parsedLocalPort, portForwards],
  );
  const error =
    localPort.trim() !== "" && parsedLocalPort === undefined
      ? "Local port must be a whole number from 1 to 65535."
      : remotePort.trim() !== "" && parsedRemotePort === undefined
        ? "Remote port must be a whole number from 1 to 65535."
        : duplicate
          ? `127.0.0.1:${parsedLocalPort} is already used by another forward.`
          : undefined;
  const valid =
    parsedLocalPort !== undefined &&
    parsedRemotePort !== undefined &&
    !duplicate;

  const submit = () => {
    if (!valid || parsedLocalPort === undefined || parsedRemotePort === undefined) {
      return;
    }
    const patch = {
      serviceId: service.id,
      localPort: parsedLocalPort,
      remotePort: parsedRemotePort,
      enabled,
    };
    if (forward) updatePortForward(forward.id, patch);
    else addPortForward(patch);
    onClose();
  };

  return (
    <Modal
      title={forward ? "Edit port forward" : "Add port forward"}
      onClose={onClose}
      onSubmit={submit}
      dismissOnScrimClick={false}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!valid} onClick={submit}>
            {forward ? "Save" : "Add forward"}
          </button>
        </>
      }
    >
      <div className="forward-dialog__route" aria-label="Loopback-only route">
        <span>This computer</span>
        <span aria-hidden="true">→</span>
        <span>{service.name}</span>
      </div>

      <label className="field">
        <span>Local port</span>
        <div className="forward-dialog__port">
          <span>127.0.0.1:</span>
          <input
            value={localPort}
            inputMode="numeric"
            pattern="[0-9]*"
            min="1"
            max="65535"
            placeholder="5433"
            aria-invalid={localPort.trim() !== "" && parsedLocalPort === undefined}
            onChange={(event) => setLocalPort(event.target.value)}
            autoFocus
          />
        </div>
      </label>

      <label className="field">
        <span>Remote port</span>
        <div className="forward-dialog__port">
          <span>127.0.0.1:</span>
          <input
            value={remotePort}
            inputMode="numeric"
            pattern="[0-9]*"
            min="1"
            max="65535"
            placeholder="5432"
            aria-invalid={remotePort.trim() !== "" && parsedRemotePort === undefined}
            onChange={(event) => setRemotePort(event.target.value)}
          />
        </div>
      </label>

      <label className="forward-dialog__enabled">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>Start this forward now</span>
      </label>

      {error && <p className="hint hint--error">{error}</p>}
      <p className="hint hint--muted">
        Both endpoints are restricted to loopback addresses.
      </p>
    </Modal>
  );
}
