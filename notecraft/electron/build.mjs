// Bundle the Electron main and preload scripts (they import the TypeScript
// parser from ../onenote-re, so they are bundled rather than shipped as-is).
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], sourcemap: false, logLevel: "info" };
await build({ ...common, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs" });
await build({ ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs" });
