// Images and attachments: inline (inside an outline) and floating on the page.
import { memo, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { FileEl, FloatingImage, ImageData, ImageEl, ListRef } from "../../model/types.ts";
import { LAYOUT } from "../../model/types.ts";
import * as ops from "../../model/ops.ts";
import { store } from "../../store/store.ts";
import { dragPointer } from "../canvasApi.ts";
import { Icon } from "../icons.tsx";
import { useReadOnly } from "./readOnly.ts";
import { askText } from "../prompt.ts";
import { desktop } from "../../desktop.ts";
import { download } from "../../store/actions.ts";
import { pictureText, transcribeRecording } from "../../ai/features.ts";
import { rotateDataUrl } from "../../lib/image.ts";

function ImageBody({ image, width, height }: { image: ImageData; width: number; height: number }) {
  if (image.src) return <img src={image.src} alt={image.alt ?? image.filename ?? ""} draggable={false} style={{ width, height }} />;
  // The source .one declared the picture but stored no bytes (<invfdo>).
  return (
    <div className="img-missing" style={{ width, height }} title={image.ocrText ?? undefined}>
      <Icon.image width={22} height={22} />
      <span className="img-missing-name">{image.filename ?? image.alt ?? "Image"}</span>
      <span className="img-missing-note">Picture data was not stored in the imported file</span>
      {image.ocrText && <span className="img-missing-ocr">{image.ocrText.slice(0, 180)}</span>}
    </div>
  );
}

/** Shown while a picture is selected: Alt Text, Rotate Left, Rotate Right. */
function ImageTools({ image, update }: { image: ImageData; update: (patch: Partial<ImageData>) => void }) {
  const stop = (e: PointerEvent | MouseEvent<HTMLElement>) => (e.stopPropagation(), e.preventDefault());
  const rotate = async (dir: 1 | -1) => {
    if (!image.src) return store.toast("This picture's data wasn't stored in the imported file, so it can't be rotated.");
    const src = await rotateDataUrl(image.src, dir);
    update({ src, width: image.height, height: image.width });
  };
  return (
    <div className="media-tools" role="toolbar" aria-label="Picture" onPointerDown={stop} onMouseDown={stop}>
      <button
        title="Alt text"
        onClick={async () => {
          const alt = await askText("Alt text", "Describe this picture for people who can't see it", image.alt ?? "");
          if (alt !== null) update({ alt: alt.trim() || undefined });
        }}
      >
        Alt text
      </button>
      <button
        title="Recognize the text in this picture (AI) so search finds it"
        onClick={async () => {
          if (!image.src) return store.toast("This picture's data wasn't stored in the imported file.");
          store.toast("Reading the picture…");
          try {
            const text = await pictureText(image.src);
            update({ ocrText: text || undefined });
            store.toast(text ? `Found ${text.split(/\s+/).length} words; search now finds them.` : "No text in this picture.");
          } catch (e) {
            store.toast((e as Error).message ?? String(e));
          }
        }}
      >
        Text
      </button>
      <button title="Rotate left" aria-label="Rotate left" onClick={() => void rotate(-1)}>⟲</button>
      <button title="Rotate right" aria-label="Rotate right" onClick={() => void rotate(1)}>⟳</button>
    </div>
  );
}

function onDeleteKey(e: KeyboardEvent, remove: () => void) {
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    remove();
  }
}

export const InlineImage = memo(function InlineImage({ el, listRef }: { el: ImageEl; listRef: ListRef }) {
  const readOnly = useReadOnly();
  const [liveW, setLiveW] = useState<number | null>(null);
  const w = liveW ?? el.image.width;
  const h = Math.round(w * (el.image.height / el.image.width || 1));
  const resize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = el.image.width;
    dragPointer(
      e,
      (dx) => setLiveW(Math.max(24, start + dx)),
      (dx, _dy, moved) => {
        setLiveW(null);
        if (moved) store.edit((d) => ops.resizeInlineImage(d, listRef, el.id, start + dx));
      },
    );
  };
  return (
    <div className="oe oe-image" style={{ paddingLeft: el.depth * LAYOUT.indent }}>
      <figure
        className="media"
        tabIndex={0}
        aria-label={el.image.alt ?? el.image.filename ?? "Image"}
        onKeyDown={readOnly ? undefined : (e) => onDeleteKey(e, () => store.edit((d) => ops.deleteElement(d, listRef, el.id)))}
      >
        <ImageBody image={el.image} width={w} height={h} />
        {!readOnly && <span className="media-resize" onPointerDown={resize} />}
        {!readOnly && <ImageTools image={el.image} update={(patch) => store.edit((d) => ops.updateInlineImage(d, listRef, el.id, patch))} />}
      </figure>
    </div>
  );
});

export const FloatingImageView = memo(function FloatingImageView({ pageId, img }: { pageId: string; img: FloatingImage }) {
  const readOnly = useReadOnly();
  const [live, setLive] = useState<{ dx: number; dy: number; w: number | null } | null>(null);
  const w = live?.w ?? img.width;
  const h = Math.round(w * (img.height / img.width || 1));

  const move = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    dragPointer(
      e,
      (dx, dy) => setLive({ dx, dy, w: null }),
      (dx, dy, moved) => {
        setLive(null);
        if (moved) store.edit((d) => ops.updateFloatingImage(d, pageId, img.id, { x: Math.max(0, Math.round(img.x + dx)), y: Math.max(0, Math.round(img.y + dy)) }));
      },
    );
  };
  const resize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragPointer(
      e,
      (dx) => setLive({ dx: 0, dy: 0, w: Math.max(24, img.width + dx) }),
      (dx, _dy, moved) => {
        setLive(null);
        if (!moved) return;
        const width = Math.max(24, Math.round(img.width + dx));
        store.edit((d) => ops.updateFloatingImage(d, pageId, img.id, { width, height: Math.round(width * (img.height / img.width || 1)) }));
      },
    );
  };

  return (
    <figure
      className="media media-floating"
      tabIndex={0}
      style={{ left: img.x + (live?.dx ?? 0), top: img.y + (live?.dy ?? 0) }}
      onPointerDown={readOnly ? undefined : move}
      onKeyDown={readOnly ? undefined : (e) => onDeleteKey(e, () => store.edit((d) => ops.deleteFloatingImage(d, pageId, img.id)))}
      aria-label={img.alt ?? img.filename ?? "Image"}
    >
      <ImageBody image={img} width={w} height={h} />
      {!readOnly && <span className="media-resize" onPointerDown={resize} />}
      {!readOnly && <ImageTools image={img} update={(patch) => store.edit((d) => ops.updateFloatingImage(d, pageId, img.id, patch))} />}
    </figure>
  );
});

/** The desktop WebView can't download; save through the app instead. */
function saveAttachment(e: MouseEvent<HTMLAnchorElement>, el: FileEl) {
  if (!desktop || !el.src) return;
  e.preventDefault();
  void download(el.name, el.src);
}

const AUDIO = /\.(webm|m4a|mp3|ogg|oga|wav|aac|wma)$/i;

const VIDEO = /\.(mp4|mov|m4v)$/i;

export function FileChip({ el, listRef }: { el: FileEl; listRef?: ListRef }) {
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const size = el.size ? ` · ${el.size < 1e6 ? `${Math.round(el.size / 1024)} KB` : `${(el.size / 1e6).toFixed(1)} MB`}` : "";
  if (el.src && VIDEO.test(el.name)) {
    return (
      <div className="oe oe-file oe-video" style={{ paddingLeft: el.depth * LAYOUT.indent }}>
        <figure className="video-chip">
          <video controls preload="metadata" src={el.src} />
          <figcaption>
            <Icon.video width={15} height={15} /> {el.name}
            <a className="file-meta" href={el.src} download={el.name} onClick={(e) => saveAttachment(e, el)}>Save{size}</a>
          </figcaption>
        </figure>
      </div>
    );
  }
  if (el.src && AUDIO.test(el.name)) {
    const doTranscribe = async () => {
      if (!listRef || !el.src) return;
      setBusy(true);
      try {
        const n = await transcribeRecording(listRef, el.id, el.src, el.name);
        store.toast(`Transcribed ${n} line${n === 1 ? "" : "s"}`);
      } catch (e) {
        store.toast((e as Error).message ?? String(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="oe oe-file oe-audio" style={{ paddingLeft: el.depth * LAYOUT.indent }}>
        <div className="audio-chip">
          <Icon.mic width={16} height={16} />
          <span className="audio-name">{el.name.replace(AUDIO, "")}</span>
          <audio controls preload="metadata" src={el.src} />
          {!readOnly && listRef && (
            <button className="file-meta link-btn" disabled={busy} onClick={() => void doTranscribe()} title="Turn the recording into text (AI)">
              {busy ? "Transcribing…" : "Transcribe"}
            </button>
          )}
          <a className="file-meta" href={el.src} download={el.name} title="Save the recording" onClick={(e) => saveAttachment(e, el)}>Save{size}</a>
        </div>
      </div>
    );
  }
  return (
    <div className="oe oe-file" style={{ paddingLeft: el.depth * LAYOUT.indent }}>
      {el.src ? (
        <a className="file-chip" href={el.src} download={el.name} onClick={(e) => saveAttachment(e, el)}>
          <Icon.file width={16} height={16} /> {el.name}
          <span className="file-meta">{size}</span>
        </a>
      ) : (
        <span className="file-chip is-missing" title="The attachment's bytes were not stored in the imported file">
          <Icon.file width={16} height={16} /> {el.name}
          <span className="file-meta">{size} · not stored</span>
        </span>
      )}
    </div>
  );
}
