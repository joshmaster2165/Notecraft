// Images and attachments: inline (inside an outline) and floating on the page.
import { memo, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { FileEl, FloatingImage, ImageData, ImageEl, ListRef } from "../../model/types.ts";
import { LAYOUT } from "../../model/types.ts";
import * as ops from "../../model/ops.ts";
import { store } from "../../store/store.ts";
import { dragPointer } from "../canvasApi.ts";
import { Icon } from "../icons.tsx";
import { useReadOnly } from "./readOnly.ts";

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
    </figure>
  );
});

export function FileChip({ el }: { el: FileEl }) {
  const size = el.size ? ` · ${el.size < 1e6 ? `${Math.round(el.size / 1024)} KB` : `${(el.size / 1e6).toFixed(1)} MB`}` : "";
  return (
    <div className="oe oe-file" style={{ paddingLeft: el.depth * LAYOUT.indent }}>
      {el.src ? (
        <a className="file-chip" href={el.src} download={el.name}>
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
