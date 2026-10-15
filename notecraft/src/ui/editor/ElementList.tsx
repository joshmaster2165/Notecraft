// Renders a flat element list (an outline or a table cell). Depth becomes
// indentation; list markers are computed across the whole list.
import { memo, useMemo } from "react";
import type { Element, ListRef } from "../../model/types.ts";
import { listMarkers } from "../../model/lists.ts";
import { Paragraph, type CellNav } from "./Paragraph.tsx";
import { TableView } from "./TableView.tsx";
import { FileChip, InlineImage } from "./media.tsx";

interface Props {
  elements: Element[];
  listRef: ListRef;
  cellNav?: CellNav;
  placeholder?: string;
}

export const ElementList = memo(function ElementList({ elements, listRef, cellNav, placeholder }: Props) {
  const markers = useMemo(() => listMarkers(elements), [elements]);
  const textIds = useMemo(() => elements.filter((e) => e.kind === "text").map((e) => e.id), [elements]);

  return (
    <>
      {elements.map((el, i) => {
        if (el.kind === "text") {
          const t = textIds.indexOf(el.id);
          return (
            <Paragraph
              key={el.id}
              el={el}
              listRef={listRef}
              marker={markers[i] ?? null}
              prevId={textIds[t - 1] ?? null}
              nextId={textIds[t + 1] ?? null}
              cellNav={cellNav}
              placeholder={elements.length === 1 ? placeholder : undefined}
            />
          );
        }
        if (el.kind === "table" && !("tableId" in listRef)) return <TableView key={el.id} table={el} listRef={listRef} />;
        if (el.kind === "image") return <InlineImage key={el.id} el={el} listRef={listRef} />;
        if (el.kind === "file") return <FileChip key={el.id} el={el} />;
        return null;
      })}
    </>
  );
});
