import { useState } from "react";

import { useStore } from "../store/store";
import { Modal } from "./Modal";

export function AddServiceDialog({ onClose }: { onClose: () => void }) {
  const addService = useStore((s) => s.addService);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("dev-token");

  const valid = name.trim() !== "" && /^https?:\/\//i.test(url.trim());

  const submit = () => {
    if (!valid) return;
    // The pool observes the store and connects automatically.
    addService({ name: name.trim(), url: url.trim(), token });
    onClose();
  };

  return (
    <Modal
      title="Add hosting service"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!valid} onClick={submit}>
            Add
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
    </Modal>
  );
}
