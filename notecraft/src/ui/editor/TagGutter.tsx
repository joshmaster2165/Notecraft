import type { NoteTag } from "../../model/types.ts";
import { Icon } from "../icons.tsx";

/** Note tag glyphs (NoteTagShape): To Do checkbox, Important star, Question mark. */
export function TagGutter({ tag, onToggle }: { tag: NoteTag; onToggle?: () => void }) {
  if (tag.kind === "todo") {
    return (
      <button
        type="button"
        className={`tag tag-todo${tag.done ? " is-checked" : ""}`}
        role="checkbox"
        aria-checked={!!tag.done}
        aria-label={tag.done ? "Mark as not done" : "Mark as done"}
        disabled={!onToggle}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
      >
        {tag.done && <Icon.check width={12} height={12} strokeWidth={2.4} />}
      </button>
    );
  }
  if (tag.kind === "important") return <Icon.star className="tag tag-important" width={15} height={15} aria-label="Important" />;
  if (tag.kind === "question") return <Icon.question className="tag tag-question" width={15} height={15} aria-label="Question" />;
  return (
    <span className="tag tag-custom" title={tag.label}>
      {tag.label?.slice(0, 1) ?? "•"}
    </span>
  );
}
