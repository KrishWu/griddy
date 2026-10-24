// Griddy's logo mark: a "G" drawn as one transmission line on a 3x3 grid, from a substation
// node to the center. Drawn in currentColor so the header can theme it.  OWNER: workstream D.
// app/icon.svg, favicon.ico and apple-icon.png are the same mark on an emerald tile.
export function GriddyMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className={className}>
      <path d="M50 14H14V50H50V32H32" stroke="currentColor" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="50" cy="14" r="6.5" fill="currentColor" />
      <circle cx="32" cy="32" r="6.5" fill="currentColor" />
    </svg>
  );
}
