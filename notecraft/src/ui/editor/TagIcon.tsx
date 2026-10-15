// 16px tag glyphs for the catalog in model/tags.ts.
import type { TagDef } from "../../model/tags.ts";

const paths: Record<string, string> = {
  star: "M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6 4.2 13.6l.7-4.3-3.1-3 4.3-.6z",
  person: "M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8zm-4.8 5.6c.5-2.6 2.5-4 4.8-4s4.3 1.4 4.8 4",
  house: "M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.8h2V13h3V6.5",
  phone: "M5.2 2.5 3.4 3.6c-.8.5-1 1.5-.6 2.4a14 14 0 0 0 7.2 7.2c.9.4 1.9.2 2.4-.6l1.1-1.8-2.6-1.7-1.2 1.1A9 9 0 0 1 5.8 6.3l1.1-1.2z",
  globe: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z",
  bulb: "M6 12.5h4M6.5 14.2h3M8 1.8a4.3 4.3 0 0 0-2.4 7.9c.4.3.6.7.6 1.2v.6h3.6v-.6c0-.5.2-.9.6-1.2A4.3 4.3 0 0 0 8 1.8z",
  key: "M10 9.5a3.5 3.5 0 1 0-3.4-2.7L2 11.4V14h2.6v-1.4H6v-1.4h1.4l1.3-1.3c.4.1.8.2 1.3.2zM10.8 5.4h.01",
  film: "M2.5 3h11v10h-11zM5 3v10M11 3v10M2.5 6h2.5M2.5 10h2.5M11 6h2.5M11 10h2.5",
  book: "M3 2.8h4.2c.5 0 .8.4.8.8v10c0-.6-.4-1-1-1H3zM13 2.8H8.8c-.5 0-.8.4-.8.8v10c0-.6.4-1 1-1H13z",
  music: "M6 12.2V3.8l7-1.5v8.3M6 12.2a1.8 1.8 0 1 1-1.8-1.8A1.8 1.8 0 0 1 6 12.2zm7-1.6a1.8 1.8 0 1 1-1.8-1.8 1.8 1.8 0 0 1 1.8 1.8z",
  doc: "M4 1.8h5.3L12 4.5v9.7H4zM9.3 1.8v2.7H12M5.8 7.5h4.4M5.8 9.8h4.4M5.8 12h3",
  pen: "M10.5 2.5l3 3-7.6 7.6-3.8.8.8-3.8zM9.2 3.8l3 3",
  envelope: "M2 4h12v8.5H2zM2 4.3l6 4.7 6-4.7",
  calendar: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3",
};

export function TagIcon({ def, done, size = 15 }: { def: TagDef; done?: boolean; size?: number }) {
  const c = def.color;
  if (def.shape === "checkbox" || def.check) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <rect x="1.8" y="1.8" width="12.4" height="12.4" rx="2.5" fill={done ? c : "none"} stroke={c} strokeWidth="1.6" />
        {done && <path d="m4.7 8.2 2.2 2.2 4.4-4.8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        {!done && def.badge && (
          <text x="8" y="11.3" textAnchor="middle" fontSize="8.5" fontWeight="700" fill={c} fontFamily="system-ui, sans-serif">
            {def.badge}
          </text>
        )}
        {!done && def.shape !== "checkbox" && <path d={paths[def.shape]} transform="translate(4 4) scale(.5)" fill="none" stroke={c} strokeWidth="2.4" />}
      </svg>
    );
  }
  if (def.shape === "question" || def.shape === "alert") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill={c} />
        <text x="8" y="11.6" textAnchor="middle" fontSize="10" fontWeight="800" fill="#fff" fontFamily="system-ui, sans-serif">
          {def.shape === "question" ? "?" : "!"}
        </text>
      </svg>
    );
  }
  if (def.shape === "letter") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill={c} />
        <text x="8" y="11.6" textAnchor="middle" fontSize="9.5" fontWeight="800" fill="#fff" fontFamily="system-ui, sans-serif">
          {def.badge}
        </text>
      </svg>
    );
  }
  if (def.shape === "highlight") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <rect x="1.5" y="4" width="13" height="8" rx="2" fill={def.highlight} stroke={c} strokeWidth="1" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d={paths[def.shape]} fill={def.shape === "star" ? c : "none"} stroke={c} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
