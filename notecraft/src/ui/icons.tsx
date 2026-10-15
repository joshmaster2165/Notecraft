// 20px stroke icons drawn for Notecraft.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (props: P) => ({
  width: 18,
  height: 18,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...props,
});

export const Icon = {
  undo: (p: P) => <svg {...base(p)}><path d="M7 5 3.5 8.5 7 12" /><path d="M4 8.5h8a4.5 4.5 0 0 1 0 9H9" /></svg>,
  redo: (p: P) => <svg {...base(p)}><path d="m13 5 3.5 3.5L13 12" /><path d="M16 8.5H8a4.5 4.5 0 0 0 0 9h3" /></svg>,
  bold: (p: P) => <svg {...base(p)}><path d="M6 4h5a3 3 0 0 1 0 6H6zM6 10h6a3 3 0 0 1 0 6H6z" /></svg>,
  italic: (p: P) => <svg {...base(p)}><path d="M12 4H8m4 12H8m3.5-12-3 12" /></svg>,
  underline: (p: P) => <svg {...base(p)}><path d="M6 4v5a4 4 0 0 0 8 0V4M5 17h10" /></svg>,
  strike: (p: P) => <svg {...base(p)}><path d="M4 10h12M13.5 6.5C13 5 11.7 4 10 4 7.8 4 6.5 5.2 6.5 6.7c0 1.1.6 1.9 2 2.4m4.8 2.6c.5.5.7 1.1.7 1.8 0 1.6-1.6 2.5-3.8 2.5-1.9 0-3.4-.9-3.8-2.5" /></svg>,
  highlight: (p: P) => <svg {...base(p)}><path d="m12.5 3.5 4 4-7 7H5.5v-4z" /><path d="M3 17.5h14" /></svg>,
  bullets: (p: P) => <svg {...base(p)}><circle cx="4.5" cy="6" r=".9" fill="currentColor" /><circle cx="4.5" cy="10" r=".9" fill="currentColor" /><circle cx="4.5" cy="14" r=".9" fill="currentColor" /><path d="M8 6h9M8 10h9M8 14h9" /></svg>,
  numbers: (p: P) => <svg {...base(p)}><path d="M3.5 4.5h1v3M3.3 7.5h2.4M3.4 11.3c.2-.5.6-.8 1.1-.8.6 0 1 .4 1 .9 0 .9-2.1 1.6-2.1 2.6h2.2M8 6h9M8 10h9M8 14h9" /></svg>,
  indent: (p: P) => <svg {...base(p)}><path d="M3 4h14M9 8h8M9 12h8M3 16h14M3 7.5 5.5 10 3 12.5" /></svg>,
  outdent: (p: P) => <svg {...base(p)}><path d="M3 4h14M9 8h8M9 12h8M3 16h14M5.5 7.5 3 10l2.5 2.5" /></svg>,
  todo: (p: P) => <svg {...base(p)}><rect x="3.5" y="3.5" width="13" height="13" rx="3" /><path d="m7 10.2 2 2 4-4.4" /></svg>,
  star: (p: P) => <svg {...base(p)}><path d="m10 3 2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.7 5.7 16l.9-4.7L3.1 8l4.8-.6z" /></svg>,
  question: (p: P) => <svg {...base(p)}><circle cx="10" cy="10" r="7" /><path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5" /><circle cx="10" cy="14" r=".6" fill="currentColor" /></svg>,
  table: (p: P) => <svg {...base(p)}><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M3 8.5h14M3 12.5h14M8 4v12M12.5 4v12" /></svg>,
  image: (p: P) => <svg {...base(p)}><rect x="3" y="4" width="14" height="12" rx="2" /><circle cx="7.5" cy="8" r="1.3" /><path d="m3.5 14.5 4-4 3 3 2-2 4 3.5" /></svg>,
  link: (p: P) => <svg {...base(p)}><path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9" /><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9" /></svg>,
  minus: (p: P) => <svg {...base(p)}><path d="M5 10h10" /></svg>,
  plus: (p: P) => <svg {...base(p)}><path d="M10 5v10M5 10h10" /></svg>,
  fitWidth: (p: P) => <svg {...base(p)}><path d="M3 4v12M17 4v12M6 10h8M8 7.5 5.5 10 8 12.5M12 7.5l2.5 2.5-2.5 2.5" /></svg>,
  search: (p: P) => <svg {...base(p)}><circle cx="9" cy="9" r="5" /><path d="m13 13 4 4" /></svg>,
  page: (p: P) => <svg {...base(p)}><path d="M5 3h7l3 3v11H5z" /><path d="M12 3v3h3" /></svg>,
  subpage: (p: P) => <svg {...base(p)}><path d="M6 5v6h8M11 8l3 3-3 3" /></svg>,
  unsubpage: (p: P) => <svg {...base(p)}><path d="M14 5v6H6M9 8l-3 3 3 3" /></svg>,
  trash: (p: P) => <svg {...base(p)}><path d="M4 6h12M8 6V4h4v2M6 6l.8 10h6.4L14 6" /></svg>,
  more: (p: P) => <svg {...base(p)}><circle cx="5" cy="10" r=".9" fill="currentColor" /><circle cx="10" cy="10" r=".9" fill="currentColor" /><circle cx="15" cy="10" r=".9" fill="currentColor" /></svg>,
  import: (p: P) => <svg {...base(p)}><path d="M10 3v9m-3.5-3.5L10 12l3.5-3.5M4 14v2h12v-2" /></svg>,
  export: (p: P) => <svg {...base(p)}><path d="M10 12V3M6.5 6.5 10 3l3.5 3.5M4 14v2h12v-2" /></svg>,
  chevron: (p: P) => <svg {...base(p)}><path d="m6 8 4 4 4-4" /></svg>,
  grip: (p: P) => <svg {...base(p)}><circle cx="7" cy="7" r=".8" fill="currentColor" /><circle cx="13" cy="7" r=".8" fill="currentColor" /><circle cx="7" cy="13" r=".8" fill="currentColor" /><circle cx="13" cy="13" r=".8" fill="currentColor" /></svg>,
  file: (p: P) => <svg {...base(p)}><path d="M12.5 6.5 7.8 11.2a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.3-4.3l-5 5a4.5 4.5 0 0 0 6.4 6.4l4-4" /></svg>,
  notebook: (p: P) => <svg {...base(p)}><rect x="4.5" y="3" width="11" height="14" rx="1.5" /><path d="M7.5 3v14M3 6.5h3M3 10h3M3 13.5h3" /></svg>,
  history: (p: P) => <svg {...base(p)}><path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6" /><path d="M3 3.5v3h3" /><path d="M10 6.5V10l2.5 1.8" /></svg>,
  close: (p: P) => <svg {...base(p)}><path d="m5.5 5.5 9 9m0-9-9 9" /></svg>,
  check: (p: P) => <svg {...base(p)}><path d="m5 10.5 3 3 7-7" /></svg>,
};

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M9 22V10h3.2l7.6 8.4V10H23v12h-3.2l-7.6-8.4V22z" fill="var(--brand-ink)" />
    </svg>
  );
}
