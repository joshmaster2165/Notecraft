import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Notecraft reuses the reverse-engineering workspace directly:
//   @re/parser  - the .one revision-store parser
//   @re/canvas  - the reconstructed OneNote pan/zoom canvas
const reRoot = fileURLToPath(new URL("../onenote-re", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@re": reRoot },
    // onenote-re has its own node_modules; force a single React instance.
    dedupe: ["react", "react-dom"],
  },
  server: { fs: { allow: [".", reRoot] } },
});
