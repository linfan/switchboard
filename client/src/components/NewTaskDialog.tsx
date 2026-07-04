import { useEffect, useMemo, useRef, useState } from "react";

import { pool } from "../net/pool";
import { useStore } from "../store/store";
import { FolderPicker } from "./FolderPicker";
import { Modal } from "./Modal";

export function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const services = useStore((s) => s.services);
  const runtime = useStore((s) => s.runtime);
  const conversations = useStore((s) => s.conversations);
  const recentTools = useStore((s) => s.recentTools);
  const createError = useStore((s) => s.createError);
  const addRecentTool = useStore((s) => s.addRecentTool);
  const clearCreateError = useStore((s) => s.clearCreateError);

  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [tool, setTool] = useState("");
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const rt = runtime[serviceId];
  const online = rt?.status === "online";
  const knownTools = useMemo(() => rt?.info?.tools ?? [], [rt?.info?.tools]);
  const recents = useMemo(
    () => recentTools[serviceId] ?? [],
    [recentTools, serviceId],
  );
  const service = services.find((s) => s.id === serviceId);

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

  // Clear any stale create error when the dialog unmounts.
  useEffect(() => clearCreateError, [clearCreateError]);

  const prefix = `${serviceId}::`;
  const convCount = useMemo(
    () => Object.keys(conversations).filter((k) => k.startsWith(prefix)).length,
    [conversations, prefix],
  );
  const baselineRef = useRef(0);

  // A create failed: surface the server's message inline, re-enable the form.
  useEffect(() => {
    if (submitting && createError) setSubmitting(false);
  }, [submitting, createError]);

  // A create succeeded (a new conversation appeared for this service): remember
  // the command and close.
  useEffect(() => {
    if (submitting && convCount > baselineRef.current) {
      addRecentTool(serviceId, tool.trim());
      onClose();
    }
  }, [submitting, convCount, serviceId, tool, addRecentTool, onClose]);

  const valid = serviceId !== "" && tool.trim() !== "" && online;

  const submit = () => {
    if (!valid || submitting) return;
    clearCreateError();
    baselineRef.current = convCount;
    setSubmitting(true);
    const sent = pool.createTask(
      serviceId,
      tool.trim(),
      title.trim() || null,
      cwd.trim() || null,
    );
    if (!sent) {
      setSubmitting(false);
      useStore.setState({ createError: "not connected to this service" });
    }
  };

  return (
    <Modal
      title="New task"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!valid || submitting}
            onClick={submit}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      {services.length === 0 ? (
        <p className="empty">Add a hosting service first.</p>
      ) : (
        <>
          <label className="field">
            <span>Service</span>
            <select
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
            >
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {runtime[s.id]?.status === "online" ? "" : " (offline)"}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Agent tool / command</span>
            <input
              list="nt-tool-suggestions"
              value={tool}
              placeholder="claude, bash, python3 -m http.server, …"
              disabled={!online}
              onChange={(e) => setTool(e.target.value)}
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

          <label className="field">
            <span>Working dir (optional)</span>
            <div className="field__row">
              <input
                value={cwd}
                placeholder="/path/to/project"
                onChange={(e) => setCwd(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={!online || !service}
                onClick={() => setShowPicker(true)}
              >
                Browse…
              </button>
            </div>
          </label>

          {createError && <p className="hint hint--error">{createError}</p>}
          {!online && (
            <p className="hint">
              This service is {rt?.status ?? "offline"}; connect before creating a
              task.
            </p>
          )}
        </>
      )}

      {showPicker && service && (
        <FolderPicker
          service={service}
          initialPath={cwd.trim() || undefined}
          onPick={(p) => {
            setCwd(p);
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </Modal>
  );
}
