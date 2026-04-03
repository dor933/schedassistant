import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * URL prefix is driven by the VITE_APP_URL_PREFIX env variable.
 * Production (behind nginx at /claw/) sets VITE_APP_URL_PREFIX=/claw.
 * Dev leaves it unset so the app is served at root.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const prefix = env.VITE_APP_URL_PREFIX || "";
  const base = prefix ? `${prefix}/` : "/";

  return {
    base,
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
  };
});
