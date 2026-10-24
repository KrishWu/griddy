// Building blocks for the About page: section shell, cards, links, code paths and the MathML
// helpers every equation uses. Server components only (no hooks), so /about renders to static
// HTML in the Cloudflare Pages export and the equations are in the page before any JS runs.
import type { CSSProperties, ReactNode } from "react";

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

// Chrome falls back to its own math font when none of these exist; STIX Two Math ships with macOS,
// Cambria Math with Windows.
const MATH_FONT: CSSProperties = { fontFamily: '"STIX Two Math", "Cambria Math", "Latin Modern Math", math' };

type M = ReactNode;

/** A bare token: digits -> <mn>, "k,h" -> k , h, anything else -> <mi> (multi-letter <mi> renders upright). */
function atom(x: M): M {
  if (typeof x === "number") return <mn>{x}</mn>;
  if (typeof x !== "string") return x;
  if (/^[\d.,]+$/.test(x)) return <mn>{x}</mn>;
  if (x.includes(",")) {
    const parts = x.split(",");
    return (
      <mrow>
        {parts.map((p, i) => (
          <Frag key={i} first={i === 0}>
            {atom(p)}
          </Frag>
        ))}
      </mrow>
    );
  }
  return <mi>{x}</mi>;
}

function Frag({ first, children }: { first: boolean; children: M }) {
  return (
    <>
      {!first && <mo>,</mo>}
      {children}
    </>
  );
}

/** A variable with optional subscript s and superscript p: <V b="B" s="h" p="dis" /> is B_h^dis. */
export function V({ b, s, p }: { b: M; s?: M; p?: M }) {
  if (s !== undefined && p !== undefined) return <msubsup>{atom(b)}{atom(s)}{atom(p)}</msubsup>;
  if (s !== undefined) return <msub>{atom(b)}{atom(s)}</msub>;
  if (p !== undefined) return <msup>{atom(b)}{atom(p)}</msup>;
  return <>{atom(b)}</>;
}

export function Frac({ n, d }: { n: M; d: M }) {
  return (
    <mfrac>
      <mrow>{n}</mrow>
      <mrow>{d}</mrow>
    </mfrac>
  );
}

/** Summation with optional limits: <Sum under="h" /> or <Sum under="t=0" over="N" />. */
export function Sum({ under, over }: { under?: M; over?: M }) {
  const u = typeof under === "string" ? <Eqs s={under} /> : under;
  if (under !== undefined && over !== undefined)
    return (
      <munderover>
        <mo>∑</mo>
        <mrow>{u}</mrow>
        {atom(over)}
      </munderover>
    );
  if (under !== undefined)
    return (
      <munder>
        <mo>∑</mo>
        <mrow>{u}</mrow>
      </munder>
    );
  return <mo>∑</mo>;
}

/** "t=1" inside a limit: a variable, =, and a value. */
function Eqs({ s }: { s: string }) {
  const [a, b] = s.split("=");
  if (b === undefined) return <>{atom(a)}</>;
  return (
    <>
      {atom(a)}
      <mo>=</mo>
      {atom(b)}
    </>
  );
}

/** Parentheses that grow with their content. */
export function P({ children, open = "(", close = ")" }: { children: M; open?: string; close?: string }) {
  return (
    <mrow>
      <mo>{open}</mo>
      {children}
      <mo>{close}</mo>
    </mrow>
  );
}

/** An operator. `infix` keeps binary spacing when it starts a continuation row of <Aligned>. */
export function O({ children, infix }: { children: string; infix?: boolean }) {
  return <mo form={infix ? "infix" : undefined}>{children}</mo>;
}

export function N({ children }: { children: string | number }) {
  return <mn>{children}</mn>;
}

/** Upright words inside an equation (units, labels). */
export function T({ children }: { children: string }) {
  return <mtext>{children}</mtext>;
}

/** Inline math in running text. */
export function Mi({ children, label }: { children: M; label?: string }) {
  return (
    <math style={MATH_FONT} aria-label={label}>
      {children}
    </math>
  );
}

/**
 * One display equation. Slightly smaller on phones so most lines fit in ~300 px; anything still
 * wider scrolls inside its own box, never the page.
 */
export function MathBlock({ children, label }: { children: M; label?: string }) {
  return (
    <div className="max-w-full overflow-x-auto overflow-y-hidden py-1">
      <math display="block" style={MATH_FONT} className="text-base sm:text-[1.12rem]" aria-label={label}>
        {children}
      </math>
    </div>
  );
}

const CELL = { padding: "0.18em 0" } as const;

/**
 * A multi-line equation aligned on its first operator, like LaTeX's align: each row is
 * [left side or null, the rest]. Continuation rows should start with <O infix>+</O>.
 */
export function Aligned({ rows }: { rows: [M, M][] }) {
  return (
    <mtable>
      {rows.map(([l, r], i) => (
        <mtr key={i}>
          {/* Table cells default to inline style; keep sums and fractions display-size like the other lines. */}
          <mtd style={{ ...CELL, textAlign: "right" }}>
            <mstyle displaystyle="true">{l ?? <mrow />}</mstyle>
          </mtd>
          <mtd style={{ ...CELL, textAlign: "left" }}>
            <mstyle displaystyle="true">{r}</mstyle>
          </mtd>
        </mtr>
      ))}
    </mtable>
  );
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

export function Section({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 space-y-4">
      <div className="space-y-1.5">
        <h2 id={`${id}-title`} className="text-xl font-bold tracking-tight sm:text-2xl">
          {title}
        </h2>
        {lead && <p className="text-[0.95rem] leading-relaxed text-zinc-600 dark:text-zinc-300">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

export function SubHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="scroll-mt-20 pt-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {children}
    </h3>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-lg border border-zinc-200 bg-white p-3 sm:p-4 dark:border-zinc-800 dark:bg-zinc-950 ${className}`}>{children}</div>;
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-emerald-800 underline decoration-emerald-800/30 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-current dark:text-cyan-300 dark:decoration-cyan-300/40"
    >
      {children}
    </a>
  );
}

/** A repo path or identifier; breaks anywhere so long paths never widen the page on a phone. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-zinc-100 px-1 py-px font-mono text-[0.85em] [overflow-wrap:anywhere] dark:bg-zinc-900">{children}</code>;
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
      {children}
    </span>
  );
}

export type SymbolRow = [symbol: ReactNode, meaning: ReactNode, unit?: string];

/**
 * One equation as a card: what it computes, the math, every symbol with its unit, where the
 * number shows up in the app, and the file it mirrors (so a judge can check it against the code).
 */
export function Equation({
  id,
  title,
  children,
  where,
  used,
  code,
  note,
}: {
  id: string;
  title: string;
  children: ReactNode;
  where: SymbolRow[];
  used: ReactNode;
  code: string | string[];
  note?: ReactNode;
}) {
  const files = Array.isArray(code) ? code : [code];
  return (
    <article id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <Card className="space-y-3">
        <h4 id={`${id}-title`} className="font-semibold">
          {title}
        </h4>
        <div className="rounded-md bg-zinc-50 px-2 py-1 sm:px-3 dark:bg-zinc-900/60">{children}</div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          {where.map(([sym, meaning, unit], i) => (
            <div key={i} className="contents">
              <dt className="text-right">{sym}</dt>
              <dd className="min-w-0 text-zinc-700 dark:text-zinc-300">
                {meaning}
                {unit && <span className="whitespace-nowrap text-zinc-500 dark:text-zinc-400"> [{unit}]</span>}
              </dd>
            </div>
          ))}
        </dl>
        {note && <div className="space-y-1.5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{note}</div>}
        <div className="flex flex-col gap-1 border-t border-zinc-100 pt-2 text-xs text-zinc-500 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-4 dark:border-zinc-800 dark:text-zinc-400">
          <p className="min-w-0">
            <span className="font-semibold text-zinc-600 dark:text-zinc-300">Used in: </span>
            {used}
          </p>
          <p className="min-w-0">
            <span className="font-semibold text-zinc-600 dark:text-zinc-300">Code: </span>
            {files.map((f, i) => (
              <span key={f}>
                {i > 0 && ", "}
                <Code>{f}</Code>
              </span>
            ))}
          </p>
        </div>
      </Card>
    </article>
  );
}
