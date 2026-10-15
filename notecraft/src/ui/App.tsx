import { useEffect, useState } from "react";
import { store, useStore } from "../store/store.ts";
import { importFiles, repairSelection } from "../store/actions.ts";
import { Sidebar } from "./Sidebar.tsx";
import { PageList } from "./PageList.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { PageCanvas, useActivePage } from "./PageCanvas.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { PreviewBanner, VersionsPanel } from "./VersionsPanel.tsx";
import { canvasApi } from "./canvasApi.ts";
import { mod } from "./editor/Paragraph.tsx";

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!mod(e)) return;
      const k = e.key.toLowerCase();
      const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (k === "z" && !inField) {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        repairSelection();
      } else if (k === "y" && !inField) {
        e.preventDefault();
        store.redo();
        repairSelection();
      } else if (k === "e") {
        e.preventDefault();
        store.setUi({ searchOpen: true });
      } else if (k === "=" || k === "+" || e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        canvasApi.current?.zoomIn();
      } else if (k === "-" || e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        canvasApi.current?.zoomOut();
      } else if ((k === "0" || e.code === "Digit0") && !e.altKey) {
        e.preventDefault();
        canvasApi.current?.setZoom(1);
      }
    };
    // Route the Edit menu's undo/redo through the app history as well.
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
        e.preventDefault();
        if (e.inputType === "historyUndo") store.undo();
        else store.redo();
        repairSelection();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("beforeinput", onBeforeInput, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("beforeinput", onBeforeInput, { capture: true });
    };
  }, []);
}

function Toast() {
  const toast = useStore((s) => s.ui.toast);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && (
        <div className="toast" key={toast.id}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export function App() {
  const loaded = useStore((s) => s.loaded);
  const searchOpen = useStore((s) => s.ui.searchOpen);
  const page = useActivePage();
  const versionsOpen = useStore((s) => s.ui.versionsOpen);
  const preview = useStore((s) => (s.ui.preview && s.ui.preview.pageId === s.ui.pageId ? s.ui.preview : null));
  const [dragging, setDragging] = useState(false);
  useGlobalShortcuts();

  if (!loaded) return <div className="boot">Opening notebooks…</div>;

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.relatedTarget === null && setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        const files = Array.from(e.dataTransfer.files).filter((f) => /\.(one|json)$/i.test(f.name));
        if (!files.length) return;
        e.preventDefault();
        void importFiles(files);
      }}
    >
      <Sidebar />
      <PageList />
      <main className="workspace">
        <Toolbar />
        {preview && <PreviewBanner version={preview.version} />}
        <div className="workspace-body">
          {page ? (
            preview ? (
              <PageCanvas page={{ ...preview.version.page, id: page.id }} version={preview.version.id} />
            ) : (
              <PageCanvas page={page} />
            )
          ) : (
            <div className="empty-state">Choose or add a page.</div>
          )}
          {versionsOpen && page && <VersionsPanel page={page} />}
        </div>
      </main>
      {searchOpen && <SearchPanel />}
      {dragging && <div className="drop-hint">Drop .one files to import them as sections</div>}
      <Toast />
    </div>
  );
}
