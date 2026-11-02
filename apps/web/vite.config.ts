import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Same origin as the daemon in dev, so the session cookie works.
    proxy: {
      "/ws": { target: "http://127.0.0.1:8787", ws: true },
      ...Object.fromEntries(
        ["/auth", "/health", "/attachments", "/backgrounds", "/debug", "/share", "/oauth"].map((path) => [path, "http://127.0.0.1:8787"]),
      ),
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
