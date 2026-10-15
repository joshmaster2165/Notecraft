// A small in-app text prompt. Electron doesn't implement window.prompt, so
// links, alt text and "Set numbering value" ask through this instead.
import { store } from "../store/store.ts";

export function askText(title: string, label: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => store.setUi({ dialog: { kind: "prompt", title, label, value, resolve } }));
}
