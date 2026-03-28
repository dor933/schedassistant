import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/claw/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/claw/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/claw/, ""),
      },
      "/claw/socket.io": {
        target: "http://localhost:3000",
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/claw/, ""),
      },
    },
  },
});
