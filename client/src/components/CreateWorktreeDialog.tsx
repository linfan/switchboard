import { useState } from "react";

import { gitCreateWorktree } from "../net/rest";
import { useStore } from "../store/store";
import type { Service, Workspace } from "../store/types";
import { Modal } from "./Modal";

/**
 * Create a git worktree for a workspace's repo. The worktree lands at
 * `$HOME/.switchboard/worktree/<workspaceName>/<worktreeName>` on the hosting
 * machine; on success it is registered as a new workspace (under the same
 * service) so the user can jump straight into it.
 */
export function CreateWorktreeDialog({
  service,
  workspace,
  onClose,
}: {
  service: Service;
  workspace: Workspace;
  onClose: () => void;
}) {
  const addWorkspace = useStore((s) => s.addWorkspace);
  const selectWorkspace = useStore((s) => s.selectWorkspace);

  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const valid = name.trim() !== "";

  const submit = async () => {
    const worktreeName = name.trim();
    if (worktreeName === "" || busy) return;
    setBusy(true);
    setError(undefined);
    let result;
    try {
      result = await gitCreateWorktree(
        service,
        workspace.cwd,
        workspace.name,
        worktreeName,
        branch.trim() || undefined,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    // Register the new worktree as a workspace under the same service and jump
    // into its editor.
    const id = addWorkspace({
      serviceId: service.id,
      name: `${workspace.name}/${worktreeName}`,
      cwd: result.path,
    });
    selectWorkspace(id);
    onClose();
  };

  return (
    <Modal
      title="Create worktree"
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
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <p className="hint hint--muted" title={workspace.cwd}>
        {workspace.cwd}
      </p>

      <label className="field">
        <span>Worktree name</span>
        <input
          value={name}
          placeholder="feature-x"
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          autoFocus
        />
      </label>

      <label className="field">
        <span>Existing branch (optional)</span>
        <input
          value={branch}
          placeholder="leave blank to create a new branch"
          onChange={(e) => {
            setBranch(e.target.value);
            setError(undefined);
          }}
        />
      </label>

      <p className="hint hint--muted">
        Created at ~/.switchboard/worktree/{workspace.name}/
        {name.trim() || "<name>"} on the host.
      </p>

      {error && <p className="hint hint--error">{error}</p>}
    </Modal>
  );
}
