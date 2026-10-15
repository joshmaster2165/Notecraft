import { useEffect, useState } from "react";
import { store, useStore } from "../store/store.ts";
import { importFiles, importNotebookFolder, readDroppedEntries, repairSelection } from "../store/actions.ts";
import { Sidebar } from "./Sidebar.tsx";
import { PageList } from "./PageList.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { PageCanvas, useActivePage } from "./PageCanvas.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { PreviewBanner, VersionsPanel } from "./VersionsPanel.tsx";
import { TagsPanel } from "./TagsPanel.tsx";
import { Dialogs } from "./Dialogs.tsx";
import { FindBar } from "./FindBar.tsx";
import { canvasApi } from "./canvasApi.ts";
import { mod } from "./editor/Paragraph.tsx";
import { desktop } from "../desktop.ts";
import * as ops from "../model/ops.ts";
import { currentPage, exportNotebook, exportPageMarkdown, newNotebook, newPage, newSection, newSectionGroup, printPage } from "../store/actions.ts";

/** Native menu commands (desktop app) mapped onto the same actions as the UI. */
function useDesktopCommands() {
  useEffect(() => {
    if (!desktop) return;
    document.documentElement.dataset.desktop = desktop.platform;
    const inEditor = () => !!(document.activeElement as HTMLElement | null)?.closest?.(".oe-editable");
    const ui = () => store.getState().ui;
    const handlers: Record<string, () => void> = {
      newPage: () => newPage(),
      newSubpage: () => newPage({ asSubpage: true }),
      newSection: () => void newSection(),
      newSectionGroup: () => void newSectionGroup(),
      newNotebook: () => newNotebook(),
      importFromOneNote: () => store.setUi({ dialog: { kind: "oneNoteImport" } }),
      importFiles: () => document.querySelector<HTMLInputElement>(".sidebar-foot input[type=file]")?.click(),
      importFolder: () => document.querySelector<HTMLInputElement>(".sidebar-foot input.folder-input")?.click(),
      exportNotebook: () => exportNotebook(),
      exportMarkdown: () => exportPageMarkdown(),
      print: () => printPage(),
      undo: () => (store.undo(), repairSelection()),
      redo: () => (store.redo(), repairSelection()),
      find: () => store.setUi({ findOpen: true }),
      search: () => store.setUi({ searchOpen: true }),
      tags: () => store.setUi({ sidePanel: ui().sidePanel === "tags" ? null : "tags" }),
      deletedNotes: () => store.setUi({ dialog: { kind: "trash" } }),
      zoomIn: () => canvasApi.current?.zoomIn(),
      zoomOut: () => canvasApi.current?.zoomOut(),
      // In a paragraph ⌘0 removes tags (OneNote); elsewhere it resets zoom.
      zoom100: () => {
        const a = ui().active;
        if (inEditor() && a) store.edit((d) => ops.clearTags(d, a.ref, a.elementId));
        else canvasApi.current?.setZoom(1);
      },
      pageWidth: () => canvasApi.current?.zoomToPageWidth(),
      fullPage: () => store.setUi({ fullPage: !ui().fullPage }),
      versions: () => currentPage() && store.setUi({ sidePanel: ui().sidePanel === "versions" ? null : "versions", preview: null }),
      templates: () => store.setUi({ dialog: { kind: "templates" } }),
    };
    return desktop.onCommand((cmd) => handlers[cmd]?.());
  }, []);
}

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
      } else if (k === "f" && !e.shiftKey) {
        e.preventDefault();
        store.setUi({ findOpen: true });
      } else if (k === "f" && e.shiftKey) {
        // OneNote's full page view toggle.
        e.preventDefault();
        store.setUi({ fullPage: !store.getState().ui.fullPage });
      } else if (k === "=" || k === "+" || e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        canvasApi.current?.zoomIn();
      } else if (k === "-" || e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        canvasApi.current?.zoomOut();
      } else if ((k === "0" || e.code === "Digit0") && !e.altKey && !(e.target as HTMLElement).closest?.(".oe-editable")) {
        // In a paragraph ⌘0 removes tags (OneNote); elsewhere it resets zoom.
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
  const sidePanel = useStore((s) => s.ui.sidePanel);
  const fullPage = useStore((s) => s.ui.fullPage);
  const findOpen = useStore((s) => s.ui.findOpen);
  const drawing = useStore((s) => s.ui.draw.tool !== "type");
  const preview = useStore((s) => (s.ui.preview && s.ui.preview.pageId === s.ui.pageId ? s.ui.preview : null));
  const [dragging, setDragging] = useState(false);
  useGlobalShortcuts();
  useDesktopCommands();

  if (!loaded) return <div className="boot">Opening notebooks…</div>;

  return (
    <div
      className={`app${fullPage ? " is-full-page" : ""}${drawing ? " is-drawing" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.relatedTarget === null && setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        // A dropped folder is a OneNote notebook: read it with its subfolders.
        const entries = Array.from(e.dataTransfer.items)
          .map((i) => i.webkitGetAsEntry?.())
          .filter((x): x is FileSystemEntry => !!x);
        if (entries.some((x) => x.isDirectory)) {
          e.preventDefault();
          void readDroppedEntries(entries).then(importNotebookFolder);
          return;
        }
        const files = Array.from(e.dataTransfer.files).filter((f) => /\.(one|onetoc2|json)$/i.test(f.name));
        if (!files.length) return;
        e.preventDefault();
        void importFiles(files);
      }}
    >
      {!fullPage && <Sidebar />}
      {!fullPage && <PageList />}
      <main className="workspace">
        <Toolbar />
        {findOpen && <FindBar />}
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
          {sidePanel === "versions" && page && <VersionsPanel page={page} />}
          {sidePanel === "tags" && <TagsPanel />}
        </div>
      </main>
      {searchOpen && <SearchPanel />}
      <Dialogs />
      {dragging && <div className="drop-hint">Drop .one files to import them as sections</div>}
      <Toast />
    </div>
  );
}
