import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.tsx";
import { loadLibrary } from "./store/persist.ts";
import { startVersionTracking } from "./store/versionService.ts";
import { startAutoLock } from "./store/locks.ts";
import { store } from "./store/store.ts";
import { setCustomTags } from "./model/tags.ts";
import "./styles.css";

// Dark paper keeps imported black text readable (see runsToHtml).
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const syncPaper = () => (document.documentElement.dataset.paper = dark.matches ? "dark" : "light");
syncPaper();
dark.addEventListener("change", syncPaper);

// Keep the custom tag registry in step with the library (Customize Tags, imports, undo).
let lastTags: unknown = undefined;
store.subscribe(() => {
  const defs = store.getState().lib.customTags;
  if (defs !== lastTags) setCustomTags((lastTags = defs));
});
void loadLibrary().then(() => (startVersionTracking(), startAutoLock()));

// Development builds: a handle for automated tests of the desktop app (src-tauri automation_report).
if (import.meta.env.DEV) {
  void Promise.all([import("./model/ops.ts"), import("./store/actions.ts"), import("./ai/client.ts"), import("./ai/features.ts"), import("./store/versionStore.ts"), import("./store/locks.ts")]).then(
    ([ops, actions, ai, features, versions, locks]) => Object.assign(window, { __notecraft: { store, ops, actions, ai, features, versions, locks } }),
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
