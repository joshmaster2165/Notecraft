// Insert › Record Audio: record from the microphone and drop the clip into the
// page as a playable attachment, as OneNote does with its audio recordings.
import type { Id, ListRef } from "../model/types.ts";
import { insertAttachments } from "./actions.ts";
import { store } from "./store.ts";

type Target = { ref: ListRef; afterId: Id } | { pageId: Id; x: number; y: number };

let recorder: MediaRecorder | null = null;

const pickType = () => ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

export async function startRecording(target: Target): Promise<void> {
  if (recorder) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return store.toast("Audio recording isn't available here.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return store.toast("Notecraft can't use the microphone. Allow microphone access and try again.");
  }
  const type = pickType();
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    store.setUi({ recording: null });
    const mime = rec.mimeType || type || "audio/webm";
    const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
    const stamp = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }).replace(/[/:]/g, "-");
    const file = new File(chunks, `Audio recording ${stamp}.${ext}`, { type: mime });
    if (file.size) insertAttachments([file], target);
  };
  recorder = rec;
  rec.start(1000);
  store.setUi({ recording: Date.now() });
}

export function stopRecording(): void {
  recorder?.stop();
}
