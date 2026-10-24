// Legend swatches shared by the map legend and the Site panel.  OWNER: workstream A.
const SWATCH_RING = "ring-1 ring-black/10 dark:ring-white/30"; // keeps dark swatches visible on dark panels

/** Filled dot (plants, fuels) or white ring (substations). */
export function Dot({ color, size = 10, ring = false }: { color: string; size?: number; ring?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full ${ring ? "bg-white" : SWATCH_RING}`}
      style={ring ? { width: size, height: size, border: `2px solid ${color}` } : { width: size, height: size, backgroundColor: color }}
    />
  );
}

/** Short line segment (transmission lines, connectors). */
export function LineSwatch({ color, width = 3, dashed = false }: { color: string; width?: number; dashed?: boolean }) {
  return (
    <span aria-hidden className="inline-flex h-3 w-5 shrink-0 items-center">
      <span className="block w-full" style={{ borderTop: `${width}px ${dashed ? "dashed" : "solid"} ${color}` }} />
    </span>
  );
}
