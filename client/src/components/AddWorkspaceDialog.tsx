import { useState } from "react";

import { makeDir, statPath } from "../net/rest";
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
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const workspaces = useStore((s) => s.workspaces);
  const online = useStore((s) => s.runtime[service.id]?.status === "online");

  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // When set, the chosen folder doesn't exist yet: a nested confirm dialog asks
  // whether to create it before the workspace is committed.
  const [confirmCreate, setConfirmCreate] = useState<string | undefined>();

  // Commit the workspace to the store and jump into its editor.
  const commit = (n: string, dir: string) => {
    const id = addWorkspace({ serviceId: service.id, name: n, cwd: dir });
    selectWorkspace(id);
    onClose();
  };

  const submit = async () => {
    const n = name.trim();
    const dir = cwd.trim();
    if (n === "" || dir === "" || busy) return;
    const dup = workspaces.some(
      (w) => w.serviceId === service.id && w.cwd === dir,
    );
    if (dup) {
      setError("A workspace for this folder already exists on this service.");
      return;
    }
    // Offline we can't check the host's filesystem — create the workspace as-is
    // (the folder is validated later when a task is launched in it).
    if (!online) {
      commit(n, dir);
      return;
    }
    setBusy(true);
    setError(undefined);
    let stat;
    try {
      stat = await statPath(service, dir);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (stat.exists && !stat.is_dir) {
      setError("That path is a file, not a folder.");
      return;
    }
    if (!stat.exists) {
      // Ask before creating the folder on the host.
      setConfirmCreate(dir);
      return;
    }
    commit(n, dir);
  };

  // The user confirmed creating the missing folder: mkdir on the host, then
  // commit the workspace.
  const createAndCommit = async () => {
    const dir = confirmCreate;
    if (dir === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await makeDir(service, dir);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setConfirmCreate(undefined);
      return;
    }
    setBusy(false);
    setConfirmCreate(undefined);
    commit(name.trim(), dir);
  };

  const valid = name.trim() !== "" && cwd.trim() !== "";

  return (
    <Modal
      title="Add workspace"
      onClose={onClose}
      onSubmit={submit}
      dismissOnScrimClick={false}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!valid || busy}
            onClick={submit}
          >
            {busy ? "Checking…" : "Add"}
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

      {confirmCreate !== undefined && (
        <Modal
          title="Create folder?"
          onClose={() => !busy && setConfirmCreate(undefined)}
          onSubmit={createAndCommit}
          dismissOnScrimClick={false}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmCreate(undefined)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={createAndCommit}
                disabled={busy}
              >
                {busy ? "Creating…" : "Create folder"}
              </button>
            </>
          }
        >
          <p>This folder doesn't exist on the service yet:</p>
          <p className="hint hint--muted" title={confirmCreate}>
            {confirmCreate}
          </p>
          <p>Create it?</p>
        </Modal>
      )}
    </Modal>
  );
}
