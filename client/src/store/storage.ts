import type { StateStorage } from "zustand/middleware";

/**
 * Persistence backend for the zustand store.
 *
 * In the browser we use `localStorage`. Inside the Tauri webview we instead use
 * `tauri-plugin-store`, which fsyncs a JSON file on the Rust side. WebKit buffers
 * `localStorage` writes and only flushes them periodically / on a clean shutdown,
 * so a delete made right before an abrupt `tauri dev` kill can be lost — which is
 * why removed services would reappear on the next launch. Writing through the
 * plugin and calling `save()` after every mutation makes each change durable
 * immediately.
 */

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type TauriStore = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  save(): Promise<void>;
};

let storePromise: Promise<TauriStore> | null = null;

function tauriStore(): Promise<TauriStore> {
  if (!storePromise) {
    storePromise = import("@tauri-apps/plugin-store").then(({ load }) =>
      load("agent-manage.json", { defaults: {}, autoSave: false }),
    );
  }
  return storePromise;
}

const tauriStorage: StateStorage = {
  getItem: async (name) => {
    const store = await tauriStore();
    return (await store.get<string>(name)) ?? null;
  },
  setItem: async (name, value) => {
    const store = await tauriStore();
    await store.set(name, value);
    await store.save();
  },
  removeItem: async (name) => {
    const store = await tauriStore();
    await store.delete(name);
    await store.save();
  },
};

export const persistStorage: StateStorage = isTauri
  ? tauriStorage
  : window.localStorage;
