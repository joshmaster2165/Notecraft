// Notecraft desktop: the web app in an Electron window, native menus, and an
// importer that reads OneNote's own notebook backups (and its picture cache)
// straight from disk.
import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseOneNote, sniffMediaType } from "../../onenote-re/parser/src/notebook.ts";
import { OneNoteCache } from "../../onenote-re/parser/src/cache.ts";

const isMac = process.platform === "darwin";
const devUrl = process.env.NOTECRAFT_DEV_URL;
let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 820,
    minHeight: 560,
    title: "Notecraft",
    backgroundColor: "#f5f4f0",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });
  // Pinch and ⌃-scroll reach the page canvas (OneNote's zoom), not Chromium's page zoom.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (devUrl && url.startsWith(devUrl)) return;
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
  });
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../dist/index.html"));
  win.on("closed", () => (win = null));
}

// --- menus -----------------------------------------------------------------------------

const send = (command: string) => () => win?.webContents.send("notecraft:command", command);

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Page", accelerator: "CmdOrCtrl+N", click: send("newPage") },
        { label: "New Subpage", accelerator: "CmdOrCtrl+Shift+Alt+N", click: send("newSubpage") },
        { label: "New Section", accelerator: "CmdOrCtrl+T", click: send("newSection") },
        { label: "New Section Group", click: send("newSectionGroup") },
        { label: "New Notebook", click: send("newNotebook") },
        { type: "separator" },
        { label: "Import from OneNote on This Computer…", click: send("importFromOneNote") },
        { label: "Import .one Files…", accelerator: "CmdOrCtrl+O", click: send("importFiles") },
        { label: "Export Notebook…", accelerator: "CmdOrCtrl+Shift+E", click: send("exportNotebook") },
        { label: "Export Page as Markdown…", click: send("exportMarkdown") },
        { type: "separator" },
        { label: "Print…", accelerator: "CmdOrCtrl+P", click: send("print") },
        ...(isMac ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: send("undo") },
        { label: "Redo", accelerator: isMac ? "Cmd+Shift+Z" : "Ctrl+Y", click: send("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Find on Page", accelerator: "CmdOrCtrl+F", click: send("find") },
        { label: "Search All Notebooks", accelerator: "CmdOrCtrl+E", click: send("search") },
        { label: "Find Tags", accelerator: "CmdOrCtrl+Shift+T", click: send("tags") },
        { type: "separator" },
        { label: "Deleted Notes", click: send("deletedNotes") },
        ...(isMac ? [{ type: "separator" as const }, { role: "startSpeaking" as const }, { role: "stopSpeaking" as const }] : []),
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: send("zoomIn") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: send("zoomOut") },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: send("zoom100") },
        { label: "Zoom to Page Width", click: send("pageWidth") },
        { type: "separator" },
        { label: "Full Page View", accelerator: "CmdOrCtrl+Shift+F", click: send("fullPage") },
        { label: "Page Versions", accelerator: "CmdOrCtrl+Shift+H", click: send("versions") },
        { label: "Page Templates…", click: send("templates") },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Notecraft on GitHub", click: () => void shell.openExternal("https://github.com/joshmaster2165/Notecraft") }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- OneNote on this computer ---------------------------------------------------------------

interface FoundSection {
  path: string;
  name: string;
  modified: string;
  bytes: number;
}
interface FoundNotebook {
  name: string;
  sections: FoundSection[];
}

/** Where OneNote keeps notebooks on this machine. */
function oneNoteRoots(): string[] {
  const home = homedir();
  const roots = [
    // OneNote for Mac: local backups of every synced notebook.
    join(home, "Library/Containers/com.microsoft.onenote.mac/Data/Library/Application Support/Microsoft User Data/OneNote/15.0/Backup"),
    // OneNote 2016 / Windows: local notebooks and backups.
    join(home, "Documents/OneNote Notebooks"),
    join(home, "AppData/Local/Microsoft/OneNote/16.0/Backup"),
  ];
  return roots.filter((r) => existsSync(r));
}

/** Backups are named "Section (On 2026-10-14).one"; keep the newest copy of each section. */
function scanNotebooks(): FoundNotebook[] {
  const notebooks = new Map<string, Map<string, FoundSection>>();
  const walk = (dir: string, notebook: string | null, depth: number) => {
    if (depth > 6) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (/^OneNote_RecycleBin$/i.test(name)) continue;
        walk(p, notebook ?? name, depth + 1);
      } else if (/\.one$/i.test(name)) {
        const nb = notebook ?? basename(dirname(p));
        const section = name.replace(/\.one$/i, "").replace(/\s*\(On \d{4}-\d{2}-\d{2}\)$/, "");
        const entry: FoundSection = { path: p, name: section, modified: st.mtime.toISOString(), bytes: st.size };
        const sections = notebooks.get(nb) ?? new Map<string, FoundSection>();
        const prev = sections.get(section);
        if (!prev || prev.modified < entry.modified) sections.set(section, entry);
        notebooks.set(nb, sections);
      }
    }
  };
  for (const root of oneNoteRoots()) {
    try {
      walk(root, null, 0);
    } catch (e) {
      console.error("Notecraft: could not read", root, e);
    }
  }
  return [...notebooks].map(([name, sections]) => ({ name, sections: [...sections.values()].sort((a, b) => a.name.localeCompare(b.name)) }));
}

const caches = new Map<string, OneNoteCache | null>();
function cacheFor(path: string): OneNoteCache | null {
  const dir = OneNoteCache.findFor(path);
  if (!dir) return null;
  if (!caches.has(dir)) {
    try {
      caches.set(dir, new OneNoteCache(dir));
    } catch {
      caches.set(dir, null);
    }
  }
  return caches.get(dir) ?? null;
}

function parseSection(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  const assets: Record<string, string> = {};
  const cache = cacheFor(path);
  const json = parseOneNote(bytes, {
    sectionName: basename(path),
    includeVersions: true,
    ...(cache ? { resolveFileData: cache.resolver() } : {}),
    onAsset: ({ id, bytes: data, mediaType, extension }) => {
      const type = mediaType || sniffMediaType(data, extension);
      assets[id] = `data:${type};base64,${Buffer.from(data).toString("base64")}`;
      return id;
    },
  });
  return { json, assets, fileName: basename(path) };
}

function registerIpc() {
  ipcMain.handle("onenote:scan", () => ({ roots: oneNoteRoots(), notebooks: scanNotebooks() }));
  ipcMain.handle("onenote:parse", (_e, path: string) => {
    if (typeof path !== "string" || !/\.one$/i.test(path) || !oneNoteRoots().some((r) => path.startsWith(r))) {
      throw new Error("Not a OneNote section in a OneNote folder");
    }
    return parseSection(path);
  });
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => !isMac && app.quit());
