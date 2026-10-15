// Readable text on user-chosen backgrounds (cell shading, page color), in
// either app theme.

export function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => {
    const c = parseInt(x!, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark ink on light backgrounds, light ink on dark ones; undefined keeps the theme's. */
export function inkFor(background: string | undefined): string | undefined {
  const l = background ? luminance(background) : null;
  if (l === null) return undefined;
  return l > 0.4 ? "#1d1f23" : "#eeece6";
}
