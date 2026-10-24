import { STAR_POINTS } from "./recommendationStars";
// Legend swatches shared by the map legend and the Site panel.  OWNER: workstream A.
const SWATCH_RING = "ring-1 ring-black/10 dark:ring-white/30"; // keeps dark swatches visible on dark panels

/** Filled dot (plants, fuels), white ring (substations), or a dot split between two colors (hybrids). */
export function Dot({ color, size = 10, ring = false, split }: { color: string; size?: number; ring?: boolean; split?: string }) {
  const fill = split ? { backgroundImage: `linear-gradient(90deg, ${color} 50%, ${split} 50%)` } : { backgroundColor: color };
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full ${ring ? "bg-white" : SWATCH_RING}`}
      style={ring ? { width: size, height: size, border: `2px solid ${color}` } : { width: size, height: size, ...fill }}
    />
  );
}

/** Small square (area fills, footprints). */
export function Square({ color, opacity = 1 }: { color: string; opacity?: number }) {
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ${SWATCH_RING}`} style={{ backgroundColor: color, opacity }} />;
}

/** Short line segment (transmission lines, connectors). */
export function LineSwatch({ color, width = 3, dashed = false }: { color: string; width?: number; dashed?: boolean }) {
  return (
    <span aria-hidden className="inline-flex h-3 w-5 shrink-0 items-center">
      <span className="block w-full" style={{ borderTop: `${width}px ${dashed ? "dashed" : "solid"} ${color}` }} />
    </span>
  );
}

/** Recommended-site marker, matching the locally generated map icon. */
export function Star({ color, size = 14 }: { color: string; size?: number }) {
  const points = STAR_POINTS.map((point) => point.join(",")).join(" ");
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 64 64" className="inline-block shrink-0"><polygon points={points} fill={color} stroke="#111827" strokeWidth={8} strokeLinejoin="round" /><polygon points={points} fill={color} stroke="white" strokeWidth={3} strokeLinejoin="round" /></svg>;
}
