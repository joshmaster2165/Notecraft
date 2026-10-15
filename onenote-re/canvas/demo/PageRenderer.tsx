// Minimal renderer for the parser's NotebookJson pages, used by the demo to
// put real page layout inside the canvas. 1pt (OneNote's unit) = 1 CSS px.
import type { CSSProperties } from "react";
import type { ContentBlock, OutlineBlock, OutlineElementBlock, Page, PageBlock, TextStyle } from "../../parser/src/notebook.ts";

const INDENT_PX = 27; // OneNote's default outline indent (0.375in)

function styleOf(s: TextStyle | undefined): CSSProperties {
  if (!s) return {};
  return {
    fontFamily: s.font ? `"${s.font}", system-ui, sans-serif` : undefined,
    fontSize: s.fontSize ? `${s.fontSize}pt` : undefined,
    color: s.color,
    background: s.highlight,
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: [s.underline && "underline", s.strikethrough && "line-through"].filter(Boolean).join(" ") || undefined,
    verticalAlign: s.superscript ? "super" : s.subscript ? "sub" : undefined,
    display: s.hidden ? "none" : undefined,
  };
}

function Content({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "richText":
      return (
        <div style={{ ...styleOf(block.paragraph), textAlign: block.paragraph.alignment, marginTop: block.paragraph.spaceBefore, marginBottom: block.paragraph.spaceAfter, whiteSpace: "pre-wrap", minHeight: "1.2em" }}>
          {block.runs.map((r, i) =>
            r.href ? (
              <a key={i} href={r.href} target="_blank" rel="noreferrer" style={{ ...styleOf(r.style), color: "#2b6cb0" }}>
                {r.text}
              </a>
            ) : (
              <span key={i} style={styleOf(r.style)}>
                {r.text}
              </span>
            ),
          )}
        </div>
      );
    case "image":
      return (
        <div
          title={block.filename}
          style={{ width: block.layout.width ?? 120, height: block.layout.height ?? 80, border: "1px dashed #a0aec0", background: "#edf2f7", display: "grid", placeItems: "center", font: "11px system-ui", color: "#4a5568" }}
        >
          {block.assetStatus === "embedded" ? block.filename ?? "image" : `${block.filename ?? "image"} (not embedded)`}
        </div>
      );
    case "table":
      return (
        <table style={{ borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            {block.columnWidths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell) => (
                  <td key={cell.id} style={{ border: block.bordersVisible === false ? "none" : "1px solid #a0aec0", padding: "2px 6px", verticalAlign: "top", background: cell.shading }}>
                    <Elements elements={cell.children} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "embeddedFile":
      return <div style={{ font: "12px system-ui", padding: 4, border: "1px solid #cbd5e0", display: "inline-block" }}>📎 {block.filename ?? "attachment"}</div>;
    default:
      return null;
  }
}

function marker(el: OutlineElementBlock, index: number): string | null {
  if (!el.list) return null;
  if (el.list.kind === "bullet") return el.list.bullet === "§" ? "▪" : el.list.bullet === "·" ? "•" : el.list.bullet ?? "•";
  const n = (el.list.restart ?? 1) + index;
  const fmt =
    el.list.scheme === "lowerLetter" ? String.fromCharCode(96 + ((n - 1) % 26) + 1)
    : el.list.scheme === "upperLetter" ? String.fromCharCode(64 + ((n - 1) % 26) + 1)
    : el.list.scheme === "lowerRoman" ? roman(n).toLowerCase()
    : el.list.scheme === "upperRoman" ? roman(n)
    : String(n);
  return `${el.list.prefix ?? ""}${fmt}${el.list.suffix ?? ""}`;
}

function roman(n: number): string {
  const t: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let s = "";
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}

function Elements({ elements }: { elements: OutlineElementBlock[] }) {
  let listIndex = 0;
  return (
    <>
      {elements.map((el) => {
        listIndex = el.list?.kind === "numbered" ? listIndex + 1 : 0;
        const m = marker(el, listIndex - 1);
        return (
          <div key={el.id}>
            <div style={{ display: "flex", gap: 6 }}>
              {m && <span style={{ minWidth: 14, textAlign: "right", userSelect: "none" }}>{m}</span>}
              <div style={{ flex: 1, minWidth: 0 }}>
                {el.content.map((c) => (
                  <Content key={c.id} block={c} />
                ))}
              </div>
            </div>
            {el.children.length > 0 && (
              <div style={{ marginLeft: INDENT_PX }}>
                <Elements elements={el.children} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function Outline({ block }: { block: OutlineBlock }) {
  return (
    <div style={{ position: "absolute", left: block.layout.x ?? 0, top: block.layout.y ?? 0, width: block.layout.width, font: "11pt Calibri, system-ui, sans-serif" }}>
      <Elements elements={block.children} />
    </div>
  );
}

function PageBlockView({ block }: { block: PageBlock }) {
  if (block.type === "outline") return <Outline block={block} />;
  if (block.type === "image" || block.type === "embeddedFile") {
    return (
      <div style={{ position: "absolute", left: block.layout.x ?? 0, top: block.layout.y ?? 0 }}>
        <Content block={block} />
      </div>
    );
  }
  return null;
}

export function PageRenderer({ page }: { page: Page }) {
  return (
    <div style={{ position: "relative" }}>
      {page.titleBlocks.map((b, i) => (
        <div key={b.id} style={{ position: "absolute", left: 36, top: 24 + i * 26, borderBottom: i === 0 ? "1px solid #cbd5e0" : undefined, minWidth: 360, fontSize: i === 0 ? "20pt" : "10pt", color: i === 0 ? "#1a202c" : "#718096" }}>
          <Elements elements={b.children} />
        </div>
      ))}
      {page.blocks.map((b) => (
        <PageBlockView key={b.id} block={b} />
      ))}
    </div>
  );
}
