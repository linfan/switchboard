import { useEffect, useMemo, useRef, useState } from "react";

import { pool } from "../net/pool";
import { useStore } from "../store/store";
import { Modal } from "./Modal";

/**
 * Create a task under a workspace. The workspace fixes the service and working
 * directory, so this dialog only asks for the tool/command and an optional
 * title — the folder is inherited and never re-prompted.
 */
export function NewTaskDialog({
  serviceId,
  workspaceId,
  cwd,
  onClose,
}: {
  serviceId: string;
  workspaceId: string;
  cwd: string;
  onClose: () => void;
}) {
  const runtime = useStore((s) => s.runtime);
  const recentTools = useStore((s) => s.recentTools);
  const addRecentTool = useStore((s) => s.addRecentTool);
  const beginCreate = useStore((s) => s.beginCreate);
  const failCreate = useStore((s) => s.failCreate);
  const clearCreateRequest = useStore((s) => s.clearCreateRequest);
  const requestIdRef = useRef<string | null>(null);
  const createRequest = useStore((s) =>
    requestIdRef.current ? s.createRequests[requestIdRef.current] : undefined,
  );
  const createError = createRequest?.error;

  const [tool, setTool] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const rt = runtime[serviceId];
  const online = rt?.status === "online";
  const knownTools = useMemo(() => rt?.info?.tools ?? [], [rt?.info?.tools]);
  const recents = useMemo(
    () => recentTools[serviceId] ?? [],
    [recentTools, serviceId],
  );

  // Datalist suggestions: recent commands first, then any available known tools
  // not already listed.
  const suggestions = useMemo(() => {
    const known = knownTools.filter((t) => t.available).map((t) => t.id);
    return [...recents, ...known.filter((id) => !recents.includes(id))];
  }, [recents, knownTools]);

  // Default the command to the most recent one, else the first available tool.
  useEffect(() => {
    setTool(recents[0] ?? knownTools.find((t) => t.available)?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, recents.length, knownTools.length]);

  useEffect(
    () => () => {
      if (requestIdRef.current) clearCreateRequest(requestIdRef.current);
    },
    [clearCreateRequest],
  );

  useEffect(() => {
    if (submitting && createError) setSubmitting(false);
  }, [submitting, createError]);

  useEffect(() => {
    if (submitting && createRequest?.taskId) {
      addRecentTool(serviceId, tool.trim());
      onClose();
    }
  }, [
    submitting,
    createRequest?.taskId,
    serviceId,
    tool,
    addRecentTool,
    onClose,
  ]);

  const valid = tool.trim() !== "" && online;

  const submit = () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    if (requestIdRef.current) clearCreateRequest(requestIdRef.current);
    const requestId = beginCreate(serviceId, workspaceId);
    requestIdRef.current = requestId;
    const sent = pool.createTask(
      serviceId,
      requestId,
      tool.trim(),
      title.trim() || null,
      cwd.trim() || null,
    );
    if (!sent) {
      failCreate(requestId, "not connected to this service");
    }
  };

  return (
    <Modal
      title="New task"
      onClose={onClose}
      onSubmit={submit}
      dismissOnScrimClick={false}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!valid || submitting}
            onClick={submit}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <p className="hint hint--muted" title={cwd}>
        {cwd}
      </p>

      <label className="field">
        <span>Agent tool / command</span>
        <input
          list="nt-tool-suggestions"
          value={tool}
          placeholder="claude, bash, python3 -m http.server, …"
          disabled={!online}
          onChange={(e) => setTool(e.target.value)}
          // A datalist-associated input swallows ENTER to dismiss its suggestion
          // dropdown, so the form's implicit submit never fires here. Submit
          // explicitly to match the title field's behavior.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          autoFocus
        />
        <datalist id="nt-tool-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>

      <label className="field">
        <span>Title (optional)</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>

      {createError && <p className="hint hint--error">{createError}</p>}
      {!online && (
        <p className="hint">
          This service is {rt?.status ?? "offline"}; connect before creating a
          task.
        </p>
      )}
    </Modal>
  );
}
