import { useEffect, useMemo, useState } from "react";

import { gitBranches, gitCreateWorktree } from "../net/rest";
import { useStore } from "../store/store";
import type { Service, Workspace } from "../store/types";
import { Modal } from "./Modal";

/** Characters allowed in a worktree name — no spaces or path separators. */
const NAME_ALLOWED = /[^0-9a-zA-Z._-]/g;

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
  const [branches, setBranches] = useState<string[]>([]);
  // The branch combobox dropdown: open state + keyboard-highlighted row.
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Set once the user tries to create a worktree on a branch that doesn't
  // exist yet — the primary button then confirms creating the new branch.
  const [confirmNew, setConfirmNew] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Load the repo's existing branches so the combobox can filter them.
  useEffect(() => {
    let cancelled = false;
    gitBranches(service, workspace.cwd)
      .then((bs) => {
        if (!cancelled) setBranches(bs);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [service, workspace.cwd]);

  const trimmedBranch = branch.trim();
  const branchExists = branches.includes(trimmedBranch);
  // A non-empty branch that doesn't match any existing one → will be created.
  const isNewBranch = trimmedBranch !== "" && !branchExists;

  // Branches matching what's typed (case-insensitive substring), current
  // exact match first is unnecessary — git already sorts by recency.
  const filtered = useMemo(() => {
    const q = trimmedBranch.toLowerCase();
    if (q === "") return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, trimmedBranch]);

  const nameValid = name !== "";
  const valid = nameValid && trimmedBranch !== "";

  const choose = (b: string) => {
    setBranch(b);
    setOpen(false);
    setConfirmNew(false);
    setError(undefined);
  };

  const submit = async () => {
    if (!valid || busy) return;
    // First submit on a not-yet-existing branch asks for confirmation instead
    // of creating it silently.
    if (isNewBranch && !confirmNew) {
      setConfirmNew(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    let result;
    try {
      result = await gitCreateWorktree(
        service,
        workspace.cwd,
        workspace.name,
        name,
        trimmedBranch,
        isNewBranch,
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
      name: `${workspace.name}/${name}`,
      cwd: result.path,
      worktree: true,
    });
    selectWorkspace(id);
    onClose();
  };

  // Keyboard nav for the branch combobox. When the dropdown is open, arrows
  // move the highlight and ENTER picks it (rather than submitting the form).
  const onBranchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && open && filtered[highlight]) {
      e.preventDefault();
      choose(filtered[highlight]);
    } else if (e.key === "Escape" && open) {
      // Close the dropdown without also closing the modal.
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <Modal
      title="Create git worktree"
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
            {busy
              ? "Creating…"
              : isNewBranch && confirmNew
                ? `Create branch “${trimmedBranch}”`
                : "Create"}
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
            // Strip anything outside [0-9a-zA-Z._-] so the name has no spaces.
            setName(e.target.value.replace(NAME_ALLOWED, ""));
            setError(undefined);
          }}
          autoFocus
        />
      </label>

      <label className="field">
        <span>Branch</span>
        <div className="combobox">
          <input
            value={branch}
            placeholder="search or type a new branch name"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            autoComplete="off"
            onChange={(e) => {
              setBranch(e.target.value);
              setOpen(true);
              setHighlight(0);
              setConfirmNew(false);
              setError(undefined);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onBranchKeyDown}
          />
          {open && filtered.length > 0 && (
            <ul className="combobox__list" role="listbox">
              {filtered.map((b, i) => (
                <li key={b} role="option" aria-selected={i === highlight}>
                  <button
                    type="button"
                    className={`combobox__item${i === highlight ? " is-active" : ""}`}
                    // mousedown fires before the input's blur, so the pick lands.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(b);
                    }}
                    onMouseEnter={() => setHighlight(i)}
                  >
                    {b}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </label>

      {isNewBranch && (
        <p className="hint">
          Branch “{trimmedBranch}” doesn’t exist —{" "}
          {confirmNew
            ? "click Create again to make it."
            : "a new branch will be created."}
        </p>
      )}

      <p className="hint hint--muted">
        Created at ~/.switchboard/worktree/{workspace.name}/{name || "<name>"}{" "}
        on the host.
      </p>

      {error && <p className="hint hint--error">{error}</p>}
    </Modal>
  );
}
