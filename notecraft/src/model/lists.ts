// List markers. Formats mirror OneNote's NumberListFormat: bullets carry a
// glyph, numbered lists an MSONFC scheme between an optional prefix/suffix.
import type { Element, ListStyle, NumberScheme } from "./types.ts";

export const BULLET_GLYPHS = ["•", "◦", "▪"];
export const NUMBER_SCHEMES: NumberScheme[] = ["decimal", "lowerLetter", "lowerRoman"];

/** OneNote cycles bullet glyphs and numbering schemes by indent level. */
export function defaultList(kind: ListStyle["kind"], depth: number): ListStyle {
  return kind === "bullet"
    ? { kind: "bullet", glyph: BULLET_GLYPHS[depth % BULLET_GLYPHS.length]! }
    : { kind: "numbered", scheme: NUMBER_SCHEMES[depth % NUMBER_SCHEMES.length]!, suffix: "." };
}

function roman(n: number): string {
  const table: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let s = "";
  for (const [v, r] of table) while (n >= v) { s += r; n -= v; }
  return s;
}

function letters(n: number): string {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

export function formatNumber(n: number, scheme: NumberScheme): string {
  switch (scheme) {
    case "upperRoman": return roman(n);
    case "lowerRoman": return roman(n).toLowerCase();
    case "upperLetter": return letters(n);
    case "lowerLetter": return letters(n).toLowerCase();
    default: return String(n);
  }
}

/** Glyphs from symbol fonts (Wingdings/Symbol) that read badly in web fonts. */
const GLYPH_FIXUPS: Record<string, string> = { "§": "▪", "·": "•", o: "◦", Ø: "➢", ü: "✓", "\uf0a7": "▪", "\uf0b7": "•" };

/**
 * Marker text for every element in a flat list. Numbering counts consecutive
 * numbered siblings at the same depth; a deeper element doesn't break the run.
 */
export function listMarkers(elements: Element[]): (string | null)[] {
  const counters: number[] = [];
  return elements.map((el) => {
    counters.length = el.depth + 1;
    const list = el.list;
    if (!list) {
      counters[el.depth] = 0;
      return null;
    }
    if (list.kind === "bullet") {
      counters[el.depth] = 0;
      return GLYPH_FIXUPS[list.glyph] ?? list.glyph;
    }
    const n = counters[el.depth] ? counters[el.depth]! + 1 : list.start ?? 1;
    counters[el.depth] = n;
    return `${list.prefix ?? ""}${formatNumber(n, list.scheme)}${list.suffix}`;
  });
}
