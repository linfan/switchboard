import { useState } from "react";

import { useStore } from "../store/store";
import type { Service } from "../store/types";
import { FolderPicker } from "./FolderPicker";
import { Modal } from "./Modal";

/**
 * Create a workspace (a named work folder) under a service. The folder is chosen
 * against the *hosting machine's* filesystem via `FolderPicker`; tasks created
 * under the workspace inherit this `cwd` without re-prompting.
 */
export function AddWorkspaceDialog({
  service,
  onClose,
}: {
  service: Service;
  onClose: () => void;
}) {
  const addWorkspace = useStore((s) => s.addWorkspace);
  const workspaces = useStore((s) => s.workspaces);
  const online = useStore((s) => s.runtime[service.id]?.status === "online");

  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = () => {
    const n = name.trim();
    const dir = cwd.trim();
    if (n === "" || dir === "") return;
    const dup = workspaces.some(
      (w) => w.serviceId === service.id && w.cwd === dir,
    );
    if (dup) {
      setError("A workspace for this folder already exists on this service.");
      return;
    }
    addWorkspace({ serviceId: service.id, name: n, cwd: dir });
    onClose();
  };

  const valid = name.trim() !== "" && cwd.trim() !== "";

  return (
    <Modal
      title="Add workspace"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!valid}
            onClick={submit}
          >
            Add
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          placeholder="my-project"
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>

      <label className="field">
        <span>Working dir</span>
        <div className="field__row">
          <input
            value={cwd}
            placeholder="/path/to/project"
            onChange={(e) => {
              setCwd(e.target.value);
              setError(undefined);
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={!online}
            onClick={() => setShowPicker(true)}
          >
            Browse…
          </button>
        </div>
      </label>

      {error && <p className="hint hint--error">{error}</p>}
      {!online && (
        <p className="hint">
          This service is offline; connect to browse its folders (you can still
          type a path).
        </p>
      )}

      {showPicker && (
        <FolderPicker
          service={service}
          initialPath={cwd.trim() || undefined}
          onPick={(p) => {
            setCwd(p);
            setError(undefined);
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </Modal>
  );
}
