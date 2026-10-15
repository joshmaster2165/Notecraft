import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.tsx";
import { loadLibrary } from "./store/persist.ts";
import { startVersionTracking } from "./store/versionService.ts";
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
void loadLibrary().then(startVersionTracking);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
