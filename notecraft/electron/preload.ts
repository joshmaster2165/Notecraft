// The only bridge between the page and Node: menu commands in, OneNote
// scanning/parsing out. Everything else runs in the sandboxed renderer.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("notecraftDesktop", {
  platform: process.platform,
  onCommand(fn: (command: string) => void) {
    const listener = (_e: unknown, command: string) => fn(command);
    ipcRenderer.on("notecraft:command", listener);
    return () => ipcRenderer.removeListener("notecraft:command", listener);
  },
  scanOneNote: () => ipcRenderer.invoke("onenote:scan"),
  parseOneNote: (path: string) => ipcRenderer.invoke("onenote:parse", path),
});
