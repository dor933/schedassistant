import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Same as server — dev and prod use `/claw`. */
const prefix = "/claw";

export default defineConfig({
  base: `${prefix}/`,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      [`${prefix}/api`]: {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      [`${prefix}/socket.io`]: {
        target: "http://localhost:3000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
