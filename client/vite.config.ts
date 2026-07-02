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
  },
  test: {
    globals: true,
    environment: "jsdom",
  },
});
