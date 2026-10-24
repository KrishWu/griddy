"""2024 monthly PG&E Citygate natural-gas prices.  OWNER: workstream C (Evaluate).

Run from backend/:  .venv/bin/python -m app.evaluate.prep_gas

Input   data/evaluate/raw/costs/2024-annual-report-on-market-issues-and-performance-aug-07-2025.pdf
        (git-ignored; download it from DMM_PDF_URL)
Output  printed only. The printed values are copied into data/evaluate/ref_costs.json as
        gas_price_pge_citygate_2024_monthly_usd_per_mmbtu and ..._avg_usd_per_mmbtu.

Why this source
---------------
The plan was to average EIA's republished ICE daily hub prices
(https://www.eia.gov/electricity/wholesale/). That page only has natural-gas files for 2014-2017.
The last one, xls/archive/ice_natgas-2017final.xlsx, ends on trade date 2017-12-28. From 2018 on
the page posts electricity hubs only, and ice_electric-2024final.xlsx has no gas hubs. We found
no free daily PG&E Citygate series for 2024.

CAISO's Department of Market Monitoring (DMM) publishes monthly average PG&E Citygate prices in
its 2024 Annual Report on Market Issues and Performance. Figure 2.7, on printed page 128, covers
Jan 2023 to Dec 2024. Figure 1.70, on printed page 88, covers Jan 2022 to Dec 2024. Both charts
are vector graphics, so the PDF holds each plotted point as a path vertex. This script reads the
PG&E Citygate polyline from each figure. It identifies the polyline by matching the stroke colour
and dash of the legend sample next to the "PG&E Citygate" label, then converts the vertices to
$/MMBtu with the chart's own gridlines and tick labels.

Accuracy
--------
The PDF stores the vertices on a 0.8 pt grid. Figure 2.7 has 11.34 pt per $/MMBtu, so each month
is good to about +/-0.035 $/MMBtu. Figure 1.70 has about 4.97 pt per $/MMBtu, about +/-0.08.
Figure 2.7 is the primary series and Figure 1.70 is a cross-check. The script stops with an
error unless two checks pass:
- the 12-month mean of Figure 2.7 is within 0.03 of the 2024 average that DMM states in the
  text ($3.08/MMBtu);
- Figure 1.70 agrees with Figure 2.7 within 0.15 in every 2024 month.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass

from pypdf import PdfReader
from pypdf.generic import ContentStream

from app import DATA_DIR

DMM_PDF_URL = (
    "https://www.caiso.com/documents/"
    "2024-annual-report-on-market-issues-and-performance-aug-07-2025.pdf"
)
DMM_PDF = (
    DATA_DIR / "evaluate" / "raw" / "costs"
    / "2024-annual-report-on-market-issues-and-performance-aug-07-2025.pdf"
)

YEAR = 2024
MONTHS = [calendar.month_abbr[m] for m in range(1, 13)]

Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


@dataclass(frozen=True)
class FigureSpec:
    name: str
    page_index: int        # 0-based PDF page where the figure was found (checked, then searched)
    caption: str           # text that must appear on the page
    n_points: int          # monthly vertices in the plotted series
    axis_side: str         # "right" or "left": which tick labels carry $/MMBtu
    max_abs_error: float   # quantisation bound, $/MMBtu, reported only


FIG_2_7 = FigureSpec(
    name="DMM 2024 annual report, Figure 2.7 (Jan 2023 - Dec 2024)",
    page_index=139,
    caption="Figure 2.7 Monthly average PG&E Citygate gas price",
    n_points=24,
    axis_side="right",
    max_abs_error=0.035,
)
FIG_1_70 = FigureSpec(
    name="DMM 2024 annual report, Figure 1.70 (Jan 2022 - Dec 2024)",
    page_index=99,
    caption="Figure 1.70 Monthly average natural gas prices",
    n_points=36,
    axis_side="left",
    max_abs_error=0.08,
)
STATED_AVG_RE = re.compile(r"averaging\s+about\s+\$(\d+\.\d+)/MMBtu\s+in\s+2024")


@dataclass
class Polyline:
    pts: list[tuple[float, float]]
    color: tuple[float, ...]
    dash: tuple[float, ...]


def _concat(m: Matrix, ctm: Matrix) -> Matrix:
    """PDF `cm`: the new CTM is m x ctm (row-vector convention)."""
    a1, b1, c1, d1, e1, f1 = m
    a2, b2, c2, d2, e2, f2 = ctm
    return (
        a1 * a2 + b1 * c2, a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2,
    )


def _apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def stroked_polylines(reader: PdfReader, page_index: int) -> list[Polyline]:
    """Every stroked subpath on the page in page coordinates (y up), with its colour and dash."""
    page = reader.pages[page_index]
    ops = ContentStream(page.get_contents(), reader).operations
    ctm, color, dash = IDENTITY, (0.0,), ()
    stack: list[tuple[Matrix, tuple[float, ...], tuple[float, ...]]] = []
    subpaths: list[list[tuple[float, float]]] = []
    out: list[Polyline] = []
    for operands, op in ops:
        if op == b"q":
            stack.append((ctm, color, dash))
        elif op == b"Q":
            ctm, color, dash = stack.pop()
        elif op == b"cm":
            a, b, c, d, e, f = (float(v) for v in operands)
            ctm = _concat((a, b, c, d, e, f), ctm)
        elif op in (b"G", b"RG", b"K", b"SC", b"SCN"):
            color = tuple(float(v) for v in operands if not isinstance(v, str))
        elif op == b"d":
            dash = tuple(float(v) for v in operands[0])
        elif op == b"m":
            subpaths.append([_apply(ctm, float(operands[0]), float(operands[1]))])
        elif op in (b"l", b"c", b"v", b"y") and subpaths:
            subpaths[-1].append(_apply(ctm, float(operands[-2]), float(operands[-1])))
        elif op in (b"S", b"s", b"B", b"B*", b"b", b"b*"):
            out.extend(Polyline(pts=p, color=color, dash=dash) for p in subpaths if len(p) > 1)
            subpaths = []
        elif op in (b"f", b"F", b"f*", b"n"):
            subpaths = []
    return out


def text_items(reader: PdfReader, page_index: int) -> list[tuple[float, float, str]]:
    """(x, y, text) of every text run on the page, at its baseline origin in page coordinates."""
    items: list[tuple[float, float, str]] = []

    def visit(text, cm, tm, _font, _size):  # pypdf visitor_text callback
        if text.strip():
            x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
            y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
            items.append((x, y, text.strip()))

    reader.pages[page_index].extract_text(visitor_text=visit)
    return items


def _is_horizontal(p: Polyline) -> bool:
    return len(p.pts) == 2 and abs(p.pts[0][1] - p.pts[1][1]) < 0.01


def _length(p: Polyline) -> float:
    return abs(p.pts[-1][0] - p.pts[0][0])


def find_page(reader: PdfReader, fig: FigureSpec) -> int:
    """The page that has the caption and a polyline with fig.n_points vertices."""

    def ok(i: int) -> bool:
        text = reader.pages[i].extract_text() or ""
        if fig.caption not in " ".join(text.split()):
            return False
        return any(len(p.pts) == fig.n_points for p in stroked_polylines(reader, i))

    if fig.page_index < len(reader.pages) and ok(fig.page_index):
        return fig.page_index
    for i in range(len(reader.pages)):
        if ok(i):
            return i
    raise SystemExit(f"{fig.name}: page not found in {DMM_PDF.name}")


def read_series(reader: PdfReader, page_index: int, fig: FigureSpec) -> list[float]:
    """The PG&E Citygate series of one DMM figure, $/MMBtu, one value per month."""
    polys = stroked_polylines(reader, page_index)
    texts = text_items(reader, page_index)
    series = [p for p in polys if len(p.pts) == fig.n_points]
    if not series:
        raise SystemExit(f"{fig.name}: no {fig.n_points}-point series found")
    x_lo = min(x for p in series for x, _ in p.pts)
    x_hi = max(x for p in series for x, _ in p.pts)

    # Legend: the short horizontal sample line just left of the "PG&E Citygate" label.
    label = next((t for t in texts if "PG&E Citygate" in t[2] and len(t[2]) < 40), None)
    if label is None:
        raise SystemExit(f"{fig.name}: legend label 'PG&E Citygate' not found")
    samples = [p for p in polys if _is_horizontal(p) and _length(p) < 40]
    sample = min(
        (p for p in samples if max(x for x, _ in p.pts) <= label[0] + 1),
        key=lambda p: abs(p.pts[0][1] - label[1]) + (label[0] - max(x for x, _ in p.pts)) * 0.1,
        default=None,
    )
    if sample is None:
        raise SystemExit(f"{fig.name}: legend sample line not found")
    matches = [p for p in series if p.color == sample.color and p.dash == sample.dash]
    if len(matches) != 1:
        raise SystemExit(f"{fig.name}: {len(matches)} series match the legend style")
    line = matches[0]

    # Y axis: pair the gridlines (bottom to top) with the $ tick labels on the chosen side.
    gridlines = sorted(
        {round(p.pts[0][1], 3) for p in polys if _is_horizontal(p) and _length(p) > 0.6 * (x_hi - x_lo)}
    )
    tick_re = re.compile(r"^(-?)\$(\d+)$")
    ticks = []
    for x, y, t in texts:
        m = tick_re.match(t)
        on_side = x > x_hi if fig.axis_side == "right" else x < x_lo
        if m and on_side:
            ticks.append((y, (-1 if m.group(1) else 1) * float(m.group(2))))
    ticks.sort()
    if len(ticks) != len(gridlines) or len(ticks) < 3:
        raise SystemExit(f"{fig.name}: {len(ticks)} tick labels vs {len(gridlines)} gridlines")
    values = [v for _, v in ticks]
    # Least-squares line value = a + b * y through (gridline y, tick value).
    n = len(values)
    my, mv = sum(gridlines) / n, sum(values) / n
    b = sum((y - my) * (v - mv) for y, v in zip(gridlines, values)) / sum((y - my) ** 2 for y in gridlines)
    a = mv - b * my
    resid = max(abs(a + b * y - v) for y, v in zip(gridlines, values))
    if resid > 0.1 * abs(values[1] - values[0]):
        raise SystemExit(f"{fig.name}: gridlines do not line up with tick labels")

    xs = [x for x, _ in line.pts]
    if any(x2 <= x1 for x1, x2 in zip(xs, xs[1:])):
        raise SystemExit(f"{fig.name}: series x values are not increasing")
    return [a + b * y for _, y in line.pts]


def stated_average(reader: PdfReader, page_index: int) -> float:
    text = " ".join((reader.pages[page_index].extract_text() or "").split())
    m = STATED_AVG_RE.search(text)
    if not m:
        raise SystemExit("DMM's stated 2024 PG&E Citygate average not found next to Figure 2.7")
    return float(m.group(1))


def main() -> None:
    if not DMM_PDF.exists():
        raise SystemExit(f"Missing {DMM_PDF}\nDownload it from {DMM_PDF_URL}")
    reader = PdfReader(DMM_PDF)

    p27 = find_page(reader, FIG_2_7)
    p170 = find_page(reader, FIG_1_70)
    fig27 = read_series(reader, p27, FIG_2_7)[-12:]      # Jan..Dec 2024
    fig170 = read_series(reader, p170, FIG_1_70)[-12:]
    stated = stated_average(reader, p27)

    days = [calendar.monthrange(YEAR, m)[1] for m in range(1, 13)]
    mean = sum(fig27) / 12
    day_weighted = sum(p * d for p, d in zip(fig27, days)) / sum(days)
    worst = max(abs(x - y) for x, y in zip(fig27, fig170))

    print(f"Source: {DMM_PDF_URL}")
    print(f"  {FIG_2_7.name}: PDF page {p27 + 1} (primary, +/-{FIG_2_7.max_abs_error} $/MMBtu)")
    print(f"  {FIG_1_70.name}: PDF page {p170 + 1} (cross-check, +/-{FIG_1_70.max_abs_error} $/MMBtu)")
    print()
    print(f"{'month':<6}{'Fig 2.7':>10}{'Fig 1.70':>10}{'diff':>8}")
    for name, x, y in zip(MONTHS, fig27, fig170):
        print(f"{name:<6}{x:>10.3f}{y:>10.3f}{x - y:>8.3f}")
    print()
    print(f"12-month mean (Fig 2.7)       {mean:.4f} $/MMBtu")
    print(f"day-weighted mean (Fig 2.7)   {day_weighted:.4f} $/MMBtu  (366 days in 2024)")
    print(f"DMM stated 2024 average       {stated:.2f} $/MMBtu")
    print(f"max |Fig 2.7 - Fig 1.70|      {worst:.3f} $/MMBtu")

    if abs(mean - stated) > 0.03:
        raise SystemExit(f"FAIL: mean {mean:.3f} differs from DMM's stated {stated:.2f}")
    if worst > 0.15:
        raise SystemExit(f"FAIL: figures disagree by {worst:.3f} $/MMBtu")
    print("checks passed")
    print()
    print("ref_costs.json values (2 dp):")
    print("  monthly:", [round(v, 2) for v in fig27])
    print(f"  mean:    {round(mean, 2)}   day-weighted: {round(day_weighted, 2)}")


if __name__ == "__main__":
    main()
