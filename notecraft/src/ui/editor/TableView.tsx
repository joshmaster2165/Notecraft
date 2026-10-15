// TableNode → TableRowNode → TableCellNode. Each cell holds its own element
// list; Tab walks cells and adds a row at the end, as in OneNote.
import { memo, useState, type CSSProperties, type PointerEvent } from "react";
import type { ListRef, TableEl } from "../../model/types.ts";
import { LAYOUT } from "../../model/types.ts";
import * as ops from "../../model/ops.ts";
import { store } from "../../store/store.ts";
import { dragPointer } from "../canvasApi.ts";
import { Icon } from "../icons.tsx";
import { ElementList } from "./ElementList.tsx";
import { useReadOnly } from "./readOnly.ts";
import { inkFor } from "../../lib/color.ts";

type OutlineRef = { pageId: string; outlineId: string };

export const TableView = memo(function TableView({ table, listRef }: { table: TableEl; listRef: OutlineRef | ListRef }) {
  const { pageId, outlineId } = listRef;
  const readOnly = useReadOnly();
  const [liveWidths, setLiveWidths] = useState<number[] | null>(null);
  const widths = liveWidths ?? table.columns;

  const cells = table.rows.flatMap((r) => r.cells.map((c) => ({ row: r, cell: c })));
  const focusCell = (index: number, at: "start" | "end") => {
    const target = cells[index];
    if (!target) return;
    const texts = target.cell.elements.filter((e) => e.kind === "text");
    const el = at === "start" ? texts[0] : texts[texts.length - 1];
    if (el) store.focus(el.id, at === "start" ? 0 : "end");
  };
  const navFor = (index: number) => ({
    next: () => {
      if (index + 1 < cells.length) focusCell(index + 1, "start");
      else {
        const id = store.edit((d) => ops.addTableRow(d, pageId, outlineId, table.id));
        if (id) store.focus(id, 0);
      }
    },
    prev: () => focusCell(index - 1, "end"),
  });

  const startResize = (col: number) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = [...table.columns];
    dragPointer(
      e,
      (dx) => setLiveWidths(start.map((w, i) => (i === col ? Math.max(40, w + dx) : w))),
      (dx, _dy, moved) => {
        setLiveWidths(null);
        if (moved) store.edit((d) => ops.setColumnWidth(d, pageId, outlineId, table.id, col, start[col]! + dx));
      },
    );
  };

  let x = 0;
  return (
    <div className="oe oe-table" style={{ paddingLeft: table.depth * LAYOUT.indent }}>
      <div className="table-wrap">
        <table className={table.borders ? "has-borders" : ""} style={{ width: widths.reduce((a, b) => a + b, 0) }}>
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell) => {
                  const index = cells.findIndex((c) => c.cell === cell);
                  return (
                    <td key={cell.id} style={cell.shading ? ({ background: cell.shading, color: inkFor(cell.shading), "--ink": inkFor(cell.shading) } as CSSProperties) : undefined}>
                      <ElementList
                        elements={cell.elements}
                        listRef={{ pageId, outlineId, tableId: table.id, rowId: row.id, cellId: cell.id }}
                        cellNav={navFor(index)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!readOnly && widths.slice(0, -1).map((w, i) => {
          x += w;
          return <div key={i} className="col-resizer" style={{ left: x - 3 }} onPointerDown={startResize(i)} />;
        })}
        {!readOnly && <div className="col-resizer" style={{ left: widths.reduce((a, b) => a + b, 0) - 3 }} onPointerDown={startResize(widths.length - 1)} />}
        {!readOnly && <>
        <button
          type="button"
          className="table-add table-add-row"
          title="Add row"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const id = store.edit((d) => ops.addTableRow(d, pageId, outlineId, table.id));
            if (id) store.focus(id, 0);
          }}
        >
          <Icon.plus width={14} height={14} />
        </button>
        <button
          type="button"
          className="table-add table-add-col"
          title="Add column"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => store.edit((d) => ops.addTableColumn(d, pageId, outlineId, table.id))}
        >
          <Icon.plus width={14} height={14} />
        </button>
        </>}
      </div>
    </div>
  );
});
