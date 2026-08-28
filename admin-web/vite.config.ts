import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies /api to our MCP backend so the browser never
// hit CORS while calling config read/write or provider probing.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3100",
        changeOrigin: true,
      },
    },
  },
});