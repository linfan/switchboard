import { useEffect, useState } from "react";

import { pool } from "../net/pool";
import { useStore } from "../store/store";
import { Modal } from "./Modal";

export function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const services = useStore((s) => s.services);
  const runtime = useStore((s) => s.runtime);

  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [tool, setTool] = useState("");
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");

  const rt = runtime[serviceId];
  const online = rt?.status === "online";
  const tools = rt?.info?.tools ?? [];

  // Default the tool selection to the first available tool for the service.
  useEffect(() => {
    const firstAvailable = tools.find((t) => t.available)?.id ?? tools[0]?.id ?? "";
    setTool(firstAvailable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, tools.length]);

  const valid = serviceId !== "" && tool !== "" && online;

  const submit = () => {
    if (!valid) return;
    pool.createTask(
      serviceId,
      tool,
      title.trim() || null,
      cwd.trim() || null,
      prompt.trim() || null,
    );
    onClose();
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
          <button className="btn btn--primary" disabled={!valid} onClick={submit}>
            Create
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
            <span>Agent tool</span>
            <select
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              disabled={!online || tools.length === 0}
            >
              {tools.length === 0 ? (
                <option value="">
                  {online ? "no tools reported" : "connect to load tools"}
                </option>
              ) : (
                tools.map((t) => (
                  <option key={t.id} value={t.id} disabled={!t.available}>
                    {t.display_name}
                    {t.available ? "" : " (not installed)"}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="field">
            <span>Title (optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Working dir (optional)</span>
            <input
              value={cwd}
              placeholder="/path/to/project"
              onChange={(e) => setCwd(e.target.value)}
            />
          </label>
          <label className="field">
            <span>First message (optional)</span>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          {!online && (
            <p className="hint">
              This service is {rt?.status ?? "offline"}; connect before creating a
              task.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
