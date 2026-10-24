// Small line icons for the sidebar tabs, rails and header (inline SVG, currentColor, no icon package).
// Decorative: every use sits next to a visible label or carries an aria-label on its button.
import type { ReactNode, SVGProps } from "react";

function Icon({ children, className = "h-4 w-4", ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className} {...rest}>
      {children}
    </svg>
  );
}

type P = { className?: string };

/** Plan: a clipboard with lines. */
export const PlanIcon = (p: P) => (
  <Icon {...p}>
    <rect x="4.5" y="3.5" width="11" height="14" rx="1.5" />
    <path d="M7.5 3.5V2.75h5v.75M7.5 8h5M7.5 11h5M7.5 14h3" />
  </Icon>
);
/** Site: a map pin. */
export const SiteIcon = (p: P) => (
  <Icon {...p}>
    <path d="M10 17.5s5.5-5 5.5-9.25a5.5 5.5 0 1 0-11 0C4.5 12.5 10 17.5 10 17.5Z" />
    <circle cx="10" cy="8.25" r="2" />
  </Icon>
);
/** Layers: stacked sheets. */
export const LayersIcon = (p: P) => (
  <Icon {...p}>
    <path d="M10 3 2.5 7 10 11l7.5-4L10 3Z" />
    <path d="m2.5 10.5 7.5 4 7.5-4M2.5 14l7.5 4 7.5-4" />
  </Icon>
);
/** Build: blocks. */
export const BuildIcon = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="10.5" width="6" height="6" rx="1" />
    <rect x="11" y="10.5" width="6" height="6" rx="1" />
    <rect x="7" y="3.5" width="6" height="6" rx="1" />
  </Icon>
);
/** Summary: a gauge. */
export const SummaryIcon = (p: P) => (
  <Icon {...p}>
    <path d="M3 14.5a7 7 0 1 1 14 0" />
    <path d="m10 14.5 3.25-4.25" />
    <path d="M2.5 17h15" />
  </Icon>
);
/** Simulate: an hourly curve. */
export const SimulateIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 16.5h15" />
    <path d="M3 13c2-6 3.5-8.5 5-8.5S10.5 11 12 11s2.5-3 5-5.5" />
  </Icon>
);
/** Costs: a coin with a dollar sign. */
export const CostsIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M12.25 7.5c-.4-.8-1.2-1.25-2.25-1.25-1.3 0-2.25.7-2.25 1.75 0 2.5 4.5 1.25 4.5 3.9 0 1.05-1 1.85-2.25 1.85-1.1 0-2-.5-2.4-1.35M10 5v1.25M10 13.75V15" />
  </Icon>
);
/** Stress: a lightning bolt. */
export const StressIcon = (p: P) => (
  <Icon {...p}>
    <path d="M11 2.5 4.5 11h5l-1 6.5L15.5 9h-5l.5-6.5Z" />
  </Icon>
);
/** Report: a document. */
export const ReportIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 2.5h6.5L15 6v11.5H5v-15Z" />
    <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" />
  </Icon>
);
export const GearIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="2.5" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    <circle cx="10" cy="10" r="5.25" />
  </Icon>
);
export const CloseIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 5l10 10M15 5 5 15" />
  </Icon>
);
/** Chevron pointing left ("collapse" on a left sidebar, "expand" on a right one). */
export const ChevronLeftIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12.5 4.5 7 10l5.5 5.5" />
  </Icon>
);
export const ChevronRightIcon = (p: P) => (
  <Icon {...p}>
    <path d="M7.5 4.5 13 10l-5.5 5.5" />
  </Icon>
);
export const ChevronUpIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 12.5 10 7l5.5 5.5" />
  </Icon>
);
export const ChevronDownIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4.5 7.5 10 13l5.5-5.5" />
  </Icon>
);
