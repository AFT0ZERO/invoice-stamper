import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// In development the API runs on `wrangler dev` (port 8787); requests to /api are proxied there,
// so the web app needs no VITE_API_URL locally. In production set VITE_API_URL to the Worker URL.
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
    },
  },
  build: { target: "esnext" },
});
