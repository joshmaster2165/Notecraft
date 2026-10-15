import type { NoteTag } from "../../model/types.ts";
import { tagDef, tagLabel } from "../../model/tags.ts";
import { TagIcon } from "./TagIcon.tsx";

/** Tag icons in front of a paragraph. Checkable tags toggle; highlight tags show no icon (the line is tinted). */
export function TagGutter({ tags, onToggle }: { tags: NoteTag[]; onToggle?: (kind: string) => void }) {
  return (
    <>
      {tags.map((tag) => {
        const def = tagDef(tag);
        if (def.highlight) return null;
        const label = tagLabel(tag);
        if (tag.done !== undefined) {
          return (
            <button
              key={tag.kind}
              type="button"
              className="tag tag-check"
              role="checkbox"
              aria-checked={tag.done}
              aria-label={`${label}: ${tag.done ? "done" : "not done"}`}
              title={label}
              disabled={!onToggle}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onToggle?.(tag.kind)}
            >
              <TagIcon def={def} done={tag.done} />
            </button>
          );
        }
        return (
          <span key={tag.kind} className="tag" title={label} role="img" aria-label={label}>
            <TagIcon def={def} />
          </span>
        );
      })}
    </>
  );
}
