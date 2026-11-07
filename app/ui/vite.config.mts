import { writeFileSync } from "node:fs";
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Gallery-only: stamps each finished build so the open gallery window reloads itself (gallery/gallery.tsx).
const buildStamp: Plugin = {
  name: "gallery-build-stamp",
  writeBundle(options) {
    writeFileSync(path.join(options.dir!, "build-id.js"), `export default ${Date.now()};\n`);
  },
};

export default defineConfig(({ mode }) => ({ plugins: [react(), tailwindcss(), mode === "gallery" && buildStamp] }));
