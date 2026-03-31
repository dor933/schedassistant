import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Deployed behind nginx at https://host/claw/ → proxy_pass strips /claw/ and serves this SPA.
 * Production build uses base `/claw/` so JS/CSS requests resolve correctly.
 * Dev server keeps base `/` so http://localhost:5173/ works without the prefix.
 */
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/claw/" : "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://localhost:3000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
}));
