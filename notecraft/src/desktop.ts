// Renderer side of the desktop bridge (electron/preload.ts). Undefined in the browser.
import type { NotebookJson } from "@re/parser/src/notebook.ts";

export interface FoundSection {
  path: string;
  name: string;
  modified: string;
  bytes: number;
}
export interface FoundNotebook {
  name: string;
  sections: FoundSection[];
}

export interface DesktopBridge {
  platform: string;
  onCommand(fn: (command: string) => void): () => void;
  scanOneNote(): Promise<{ roots: string[]; notebooks: FoundNotebook[] }>;
  parseOneNote(path: string): Promise<{ json: NotebookJson; assets: Record<string, string>; fileName: string }>;
}

export const desktop: DesktopBridge | undefined = (window as unknown as { notecraftDesktop?: DesktopBridge }).notecraftDesktop;
