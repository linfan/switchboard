import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and hides Vite's own errors behind its window.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2020",
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@xterm")) return "xterm";
          if (
            id.includes("@codemirror") ||
            id.includes("/codemirror/") ||
            id.includes("@lezer")
          ) {
            const isLang =
              id.includes("@codemirror/lang-") ||
              id.includes("@codemirror/legacy-modes") ||
              (id.includes("@lezer/") &&
                !/\/@lezer\/(common|highlight|lr)\//.test(id));
            return isLang ? "codemirror-langs" : "codemirror";
          }
          if (id.includes("react") || id.includes("scheduler")) return "react";
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
