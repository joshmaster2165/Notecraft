// Insert › Record Audio and Record Video: record from the microphone (and
// camera) and drop the clip into the page as a playable attachment, as
// OneNote does with its recordings.
import type { Id, ListRef } from "../model/types.ts";
import { insertAttachments, MAX_RECORDING_BYTES } from "./actions.ts";
import { store } from "./store.ts";

type Target = { ref: ListRef; afterId: Id } | { pageId: Id; x: number; y: number };
export type RecordKind = "audio" | "video";

let recorder: MediaRecorder | null = null;
/** The camera while recording video, for the preview. */
export let liveStream: MediaStream | null = null;

const TYPES: Record<RecordKind, string[]> = {
  audio: ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"],
  video: ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
};
const pickType = (kind: RecordKind) => TYPES[kind].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

function extension(mime: string, kind: RecordKind): string {
  if (kind === "video") return mime.includes("mp4") ? "mp4" : "webm";
  return mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
}

export async function startRecording(target: Target, kind: RecordKind = "audio"): Promise<void> {
  if (recorder) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return store.toast(`${kind === "video" ? "Video" : "Audio"} recording isn't available here.`);
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(kind === "video" ? { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } } : { audio: true });
  } catch {
    return store.toast(kind === "video" ? "Notecraft can't use the camera. Allow camera and microphone access and try again." : "Notecraft can't use the microphone. Allow microphone access and try again.");
  }
  const type = pickType(kind);
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  let bytes = 0;
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    chunks.push(e.data);
    bytes += e.data.size;
    // Leave room for the last chunk: stop before the attachment would be refused.
    if (bytes > MAX_RECORDING_BYTES * 0.95 && rec.state === "recording") {
      rec.stop();
      store.toast("The recording reached 100 MB, so it stopped.");
    }
  };
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    liveStream = null;
    store.setUi({ recording: null });
    const mime = (rec.mimeType || type || (kind === "video" ? "video/webm" : "audio/webm")).split(";")[0]!;
    const stamp = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }).replace(/[/:]/g, "-");
    const file = new File(chunks, `${kind === "video" ? "Video" : "Audio"} recording ${stamp}.${extension(mime, kind)}`, { type: mime });
    if (file.size) insertAttachments([file], target, MAX_RECORDING_BYTES);
  };
  recorder = rec;
  liveStream = kind === "video" ? stream : null;
  rec.start(1000);
  store.setUi({ recording: { since: Date.now(), kind } });
}

export function stopRecording(): void {
  recorder?.stop();
}
