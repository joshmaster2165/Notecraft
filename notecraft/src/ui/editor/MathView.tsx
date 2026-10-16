// An equation: MathML built up from UnicodeMath by the Rust engine. Click to
// edit the linear form (OneNote's "Linear" view), Enter or click away to build
// it up again ("Professional" view).
import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ListRef, MathEl } from "../../model/types.ts";
import { LAYOUT } from "../../model/types.ts";
import * as ops from "../../model/ops.ts";
import { store, useStore } from "../../store/store.ts";
import { toMathML } from "../../engine.ts";
import { useReadOnly } from "./readOnly.ts";

const cache = new Map<string, string>();

export function useMathML(linear: string): string | null {
  const [html, setHtml] = useState(() => cache.get(linear) ?? null);
  useEffect(() => {
    if (cache.has(linear)) return setHtml(cache.get(linear)!);
    let live = true;
    void toMathML(linear, true)
      .then((m) => {
        cache.set(linear, m);
        if (live) setHtml(m);
      })
      .catch(() => live && setHtml(null));
    return () => {
      live = false;
    };
  }, [linear]);
  return html;
}

export const MathView = memo(function MathView({ el, listRef }: { el: MathEl; listRef: ListRef }) {
  const readOnly = useReadOnly();
  const focusReq = useStore((s) => s.ui.focus);
  const [editing, setEditing] = useState(!el.linear);
  const [draft, setDraft] = useState(el.linear);
  const input = useRef<HTMLInputElement>(null);
  const mathml = useMathML(el.linear);

  useEffect(() => {
    if (focusReq?.elementId === el.id && !readOnly) setEditing(true);
  }, [focusReq, el.id, readOnly]);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const linear = draft.trim();
    if (!linear) store.edit((d) => ops.deleteElement(d, listRef, el.id));
    else if (linear !== el.linear) store.edit((d) => ops.setMath(d, listRef, el.id, linear));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.preventDefault(), commit());
    if (e.key === "Escape") (setDraft(el.linear), setEditing(false));
  };

  return (
    <div className="oe oe-math" style={{ paddingLeft: el.depth * LAYOUT.indent }}>
      {editing && !readOnly ? (
        <input
          ref={input}
          className="math-input"
          value={draft}
          placeholder="Type an equation, e.g. x=(-b±√(b^2-4ac))/2a or \frac{a}{b}"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
          aria-label="Equation (linear format)"
        />
      ) : (
        <button className="math-view" title={readOnly ? el.linear : "Edit equation"} disabled={readOnly} onClick={() => (setDraft(el.linear), setEditing(true))}>
          {mathml ? <span dangerouslySetInnerHTML={{ __html: mathml }} /> : <code>{el.linear}</code>}
        </button>
      )}
    </div>
  );
});
