import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the API and the collaboration socket go to the server on :3000, from the same origin as the page.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/collab": { target: "ws://localhost:3000", ws: true },
    },
  },
});
