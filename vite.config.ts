import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // The app's WebView keeps its HTTP cache between runs; a cache entry damaged by a crash
    // made dev builds come up blank. Dev modules are served from localhost, so skip caching.
    headers: { "Cache-Control": "no-store" },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
