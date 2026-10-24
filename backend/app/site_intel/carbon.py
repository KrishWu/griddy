"""Carbon-aware flexible load ("the campus as a virtual battery") + SCI.  OWNER: workstream E.

Green Software Foundation methods, implemented natively in Python:
- carbon_aware(req): within each PST day, move up to `flexible_share` of each hour's load
  to the same day's cleanest hours, never above the facility peak, conserving each day's
  energy. "Cleanest" is the campus's MARGINAL emissions read off B's dispatch, in B's
  dispatch order: extra load first soaks up curtailed solar/wind (0 kg/MWh), then
  exports, then gas CC, gas CT and import headroom; less load first trims unmet demand,
  then imports (B's hourly grid carbon), gas CT, gas CC. For a grid-only campus this is
  exactly "shift by grid_co2_kg_per_mwh". Hours where the battery is charging accept only
  curtailed or exported energy (the battery's later dispatch is not re-simulated).
- best_window(...): the lowest-carbon N-hour window of a day, shaped like the Carbon Aware
  SDK's EmissionsForecast (optimalDataPoints / forecastData; value in gCO2e/kWh).
- SCI = (E x I + M) per R with R = one GPU-hour (ISO/IEC 21031:2024).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

import numpy as np
from pydantic import BaseModel, Field

from app.contract import Finding, Provenance, Scenario, SimulationResult

log = logging.getLogger(__name__)

MIN_GAIN = 1.0  # kg/MWh: don't move load for less than this
EPS = 1e-6
DEFAULT_SHARE = 0.3
CHART_DAY = 196  # mid-July, B's chart default

# SCI assumptions (labelled as such in the result's provenance).
GPU_KW = 10.2 / 8  # NVIDIA DGX H100: 10.2 kW max for 8 GPUs, incl. CPUs, memory, fans
GPU_EMBODIED_KG = 150 + 2500 / 8  # >=150 kg per GPU + 1/8 of a ~2.5 t server (Luccioni et al. 2023, BLOOM)
HARDWARE_YEARS = 6  # replacement cycle used by the same study
FALLBACK_KG_PER_MWH = {"gas_cc": 6.4 * 53.06, "gas_ct": 9.7 * 53.06}  # heat rate x EPA CO2 factor, if the catalog lacks one

SCI_PROV = [
    Provenance(kind="assumption", source="NVIDIA DGX H100 user guide: 10.2 kW max per 8-GPU system", url="https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html", note="1.275 kW per GPU-hour at full load"),
    Provenance(
        kind="assumption",
        source="Luccioni, Viguier & Ligozat 2023, Estimating the Carbon Footprint of BLOOM (JMLR)",
        url="https://jmlr.org/papers/volume24/23-0069/23-0069.pdf",
        note="Embodied: >=150 kg CO2e per GPU (lower bound) + ~2,500 kg per server (HPE proxy), over a 6-year replacement cycle",
    ),
    Provenance(kind="assumption", source="Green Software Foundation SCI specification (ISO/IEC 21031:2024)", url="https://sci-guide.greensoftware.foundation/"),
]


class CarbonAwareRequest(BaseModel):
    scenario: Scenario
    simulation: SimulationResult
    flexible_share: float | None = Field(default=None, ge=0, le=1, description="None: the scenario's share, or 0.3 if it has none")
    day: int | None = Field(default=None, ge=0, description="0-based PST day for the chart; None: the day that saves the most")
    window_h: int = Field(default=4, ge=1, le=24)


class HourPoint(BaseModel):
    hour: int
    baseline_mw: float
    shifted_mw: float
    marginal_kg_per_mwh: float = Field(description="Emissions of the campus's last MWh this hour at baseline")
    grid_kg_per_mwh: float


class CarbonAwareResult(BaseModel):
    flexible_share: float
    shifted_mwh_per_yr: float
    baseline_t_co2e: float = Field(description="Campus operational CO2: grid imports + on-site gas")
    shifted_t_co2e: float
    avoided_t_co2e: float
    avoided_pct: float
    sci_g_per_gpu_hour_before: float | None = None
    sci_g_per_gpu_hour_after: float | None = None
    sci_inputs: dict[str, float] = Field(default_factory=dict)
    day: int
    hours: list[HourPoint]
    best_window: dict[str, Any]
    notes: list[str] = Field(default_factory=list)
    provenance: list[Provenance] = Field(default_factory=list)


def _gas_factors() -> dict[str, float]:
    out = dict(FALLBACK_KG_PER_MWH)
    try:
        from app.evaluate.catalog import get_catalog

        cat = get_catalog()
        for kind in out:
            s = cat.spec(kind)  # type: ignore[arg-type]
            if s.heat_rate_mmbtu_per_mwh and s.co2_kg_per_mmbtu:
                out[kind] = s.heat_rate_mmbtu_per_mwh * s.co2_kg_per_mmbtu
    except Exception:  # noqa: BLE001 - fall back to the documented constants
        log.warning("catalog unavailable; using fallback gas emission factors")
    return out


def _arrays(scenario: Scenario, sim: SimulationResult) -> dict[str, np.ndarray]:
    h = sim.hourly
    n = len(h.demand_mw)
    gen = h.generation_mw

    def a(x: list[float] | None) -> np.ndarray:
        v = np.zeros(n) if x is None else np.nan_to_num(np.asarray(x[:n], dtype=float))
        return np.pad(v, (0, n - len(v)))

    caps = {k: sum(x.capacity_mw for x in scenario.assets if x.kind == k) for k in ("gas_cc", "gas_ct")}
    g = scenario.grid
    return {
        "demand": a(h.demand_mw),
        "grid": a(h.grid_co2_kg_per_mwh),
        "imports": a(h.imports_mw),
        "exports": a(h.exports_mw),
        "curtailed": a(h.curtailed_mw),
        "unmet": a(h.unmet_mw),
        "charge": a(h.battery_charge_mw),
        "cc": a(gen.get("gas_cc")),
        "ct": a(gen.get("gas_ct")),
        "cc_room": np.clip(caps["gas_cc"] - a(gen.get("gas_cc")), 0, None),
        "ct_room": np.clip(caps["gas_ct"] - a(gen.get("gas_ct")), 0, None),
        "import_room": np.clip((g.import_limit_mw if g.connected else 0.0) - a(h.imports_mw), 0, None),
    }


def _segments(x: dict[str, np.ndarray], t: int, f: dict[str, float]) -> tuple[list[list[float]], list[list[float]]]:
    """(receive, remove) segments for hour t, each [kg/MWh, MW] in B's dispatch order."""
    recv = [[0.0, x["curtailed"][t]], [0.0, x["exports"][t]]]
    if x["charge"][t] <= EPS:
        recv += [[f["gas_cc"], x["cc_room"][t]], [f["gas_ct"], x["ct_room"][t]], [x["grid"][t], x["import_room"][t]]]
    remove = [[0.0, x["unmet"][t]], [x["grid"][t], x["imports"][t]], [f["gas_ct"], x["ct"][t]], [f["gas_cc"], x["cc"][t]]]
    return [s for s in recv if s[1] > EPS], [s for s in remove if s[1] > EPS]


def _marginal(x: dict[str, np.ndarray], f: dict[str, float]) -> np.ndarray:
    """kg/MWh of the last MWh served each hour at baseline (0 when renewables are spilling)."""
    m = np.zeros(len(x["demand"]))
    m = np.where(x["cc"] > EPS, f["gas_cc"], m)
    m = np.where(x["ct"] > EPS, f["gas_ct"], m)
    m = np.where(x["imports"] > EPS, x["grid"], m)
    return np.where((x["curtailed"] > EPS) | (x["exports"] > EPS), 0.0, m)


def _shift_day(x: dict[str, np.ndarray], day: int, share: float, peak: float, f: dict[str, float]) -> tuple[np.ndarray, float]:
    """Greedy pairing of the dearest removable MWh with the cheapest receivable MWh (different hours)."""
    hours = range(day * 24, min(day * 24 + 24, len(x["demand"])))
    segs = {t: _segments(x, t, f) for t in hours}
    recv = {t: s[0] for t, s in segs.items()}
    rem = {t: s[1] for t, s in segs.items()}
    recv_cap = {t: max(0.0, peak - x["demand"][t]) for t in hours}
    rem_cap = {t: share * x["demand"][t] for t in hours}
    delta = np.zeros(24)
    avoided_kg = 0.0
    while True:
        givers = [t for t in hours if rem[t] and rem_cap[t] > EPS]
        takers = [t for t in hours if recv[t] and recv_cap[t] > EPS]
        if not givers or not takers:
            break
        tr = max(givers, key=lambda t: rem[t][0][0])
        others = [t for t in takers if t != tr]
        if not others:
            rem[tr] = []  # nowhere to put this hour's load
            continue
        tc = min(others, key=lambda t: recv[t][0][0])
        gain = rem[tr][0][0] - recv[tc][0][0]
        if gain <= MIN_GAIN:
            break
        mw = min(rem[tr][0][1], rem_cap[tr], recv[tc][0][1], recv_cap[tc])
        delta[tr - day * 24] -= mw
        delta[tc - day * 24] += mw
        avoided_kg += mw * gain
        rem[tr][0][1] -= mw
        rem_cap[tr] -= mw
        recv[tc][0][1] -= mw
        recv_cap[tc] -= mw
        if rem[tr][0][1] <= EPS:
            rem[tr].pop(0)
        if recv[tc][0][1] <= EPS:
            recv[tc].pop(0)
    return delta[: len(hours)], avoided_kg


def best_window(signal_kg_per_mwh: np.ndarray, start: datetime, day: int, window_h: int, location: str) -> dict[str, Any]:
    """Lowest-mean window of `window_h` hours within one day, shaped like the Carbon Aware SDK's EmissionsForecast."""
    s = np.asarray(signal_kg_per_mwh[day * 24 : day * 24 + 24], dtype=float)
    w = max(1, min(window_h, len(s)))
    means = [float(s[i : i + w].mean()) for i in range(len(s) - w + 1)]
    t0 = start + timedelta(days=day)

    def point(i: int, v: float) -> dict[str, Any]:
        return {"location": location, "timestamp": (t0 + timedelta(hours=i)).isoformat(), "duration": w * 60, "value": round(v, 1)}

    best = int(np.argmin(means)) if means else 0
    return {
        "location": location,
        "dataStartAt": t0.isoformat(),
        "dataEndAt": (t0 + timedelta(hours=len(s))).isoformat(),
        "windowSize": w * 60,
        "optimalDataPoints": [point(best, means[best])] if means else [],
        "forecastData": [point(i, v) for i, v in enumerate(means)],
    }


def _sci(scenario: Scenario, demand_mwh: float, operational_t: float) -> tuple[float | None, dict[str, float]]:
    d = scenario.demand
    if d.kind != "data_center" or demand_mwh <= 0:
        return None, {}
    gpu_hours = demand_mwh * 1000 / d.pue / GPU_KW  # IT energy / IT kW per GPU
    gpus = d.peak_mw * 1000 / d.pue / GPU_KW
    embodied_g = gpus * GPU_EMBODIED_KG * 1000 / HARDWARE_YEARS
    inputs = {
        "gpus": round(gpus),
        "gpu_hours_per_yr": round(gpu_hours),
        "energy_kwh_per_gpu_hour": round(GPU_KW * d.pue, 3),
        "embodied_g_per_gpu_hour": round(embodied_g / gpu_hours, 1),
    }
    return (operational_t * 1e6 + embodied_g) / gpu_hours, inputs


def carbon_aware(req: CarbonAwareRequest) -> CarbonAwareResult:
    scenario, sim = req.scenario, req.simulation
    share = req.flexible_share if req.flexible_share is not None else (scenario.demand.flexible_share or DEFAULT_SHARE)
    f = _gas_factors()
    x = _arrays(scenario, sim)
    n = len(x["demand"])
    days = (n + 23) // 24
    shifted = x["demand"].copy()
    avoided_by_day = np.zeros(days)
    if share > 0:
        for day in range(days):
            delta, kg = _shift_day(x, day, share, scenario.demand.peak_mw, f)
            shifted[day * 24 : day * 24 + len(delta)] += delta
            avoided_by_day[day] = kg

    baseline_t = float((x["imports"] * x["grid"]).sum() + x["cc"].sum() * f["gas_cc"] + x["ct"].sum() * f["gas_ct"]) / 1000
    avoided_t = float(avoided_by_day.sum()) / 1000
    demand_mwh = float(x["demand"].sum())
    sci_before, sci_inputs = _sci(scenario, demand_mwh, baseline_t)
    sci_after, _ = _sci(scenario, demand_mwh, baseline_t - avoided_t)

    day = req.day if req.day is not None and req.day < days else (int(avoided_by_day.argmax()) if avoided_by_day.any() else min(CHART_DAY, days - 1))
    marginal = _marginal(x, f)
    sl = slice(day * 24, min(day * 24 + 24, n))
    hours = [
        HourPoint(hour=i, baseline_mw=round(b, 1), shifted_mw=round(s, 1), marginal_kg_per_mwh=round(m, 1), grid_kg_per_mwh=round(g, 1))
        for i, (b, s, m, g) in enumerate(zip(x["demand"][sl], shifted[sl], marginal[sl], x["grid"][sl]))
    ]
    try:
        start = datetime.fromisoformat(sim.hourly.start)
    except ValueError:
        start = datetime.fromisoformat(f"{scenario.assumptions.weather_year}-01-01T00:00:00-08:00")
    location = f"{scenario.site.balancing_authority} at {scenario.site.name}"

    notes = [
        f"Moves up to {share:.0%} of each hour's load to other hours of the same day, capped at the {scenario.demand.peak_mw:,.0f} MW facility peak.",
        "Signal: the campus's marginal emissions from the simulated dispatch (curtailed solar/wind 0, gas at its heat rate, imports at the hourly CAISO grid average).",
        "Estimate: the dispatch is not re-run with the shifted load, and battery state of charge is held as simulated.",
        f"Best window values are {scenario.assumptions.weather_year} simulated hours, not a live forecast.",
    ]
    return CarbonAwareResult(
        flexible_share=share,
        shifted_mwh_per_yr=round(float(np.clip(x["demand"] - shifted, 0, None).sum()), 1),
        baseline_t_co2e=round(baseline_t, 1),
        shifted_t_co2e=round(baseline_t - avoided_t, 1),
        avoided_t_co2e=round(avoided_t, 1),
        avoided_pct=round(avoided_t / baseline_t, 4) if baseline_t > 0 else 0.0,
        sci_g_per_gpu_hour_before=round(sci_before, 1) if sci_before is not None else None,
        sci_g_per_gpu_hour_after=round(sci_after, 1) if sci_after is not None else None,
        sci_inputs=sci_inputs,
        day=day,
        hours=hours,
        best_window=best_window(marginal, start, day, req.window_h, location),
        notes=notes,
        provenance=[
            Provenance(kind="simulated", source="Griddy hourly dispatch (workstream B) + carbon-aware shift (workstream E)", note=notes[2]),
            *(SCI_PROV if sci_before is not None else []),
        ],
    )


def carbon_findings(scenario: Scenario, sim: SimulationResult) -> list[Finding]:
    """One 'info' finding for scenarios that declare a flexible share. Never raises."""
    share = scenario.demand.flexible_share
    if not share:
        return []
    try:
        r = carbon_aware(CarbonAwareRequest(scenario=scenario, simulation=sim, flexible_share=share))
    except Exception:  # noqa: BLE001
        log.exception("carbon-aware shift failed")
        return []
    sci = f" SCI {r.sci_g_per_gpu_hour_before:,.0f} -> {r.sci_g_per_gpu_hour_after:,.0f} g CO2e per GPU-hour." if r.sci_g_per_gpu_hour_before else ""
    return [
        Finding(
            id="carbon_aware_shift",
            module="site",
            severity="info",
            title="Carbon-aware scheduling",
            detail=f"Shifting the {share:.0%} flexible load within each day to its cleanest hours avoids ~{r.avoided_t_co2e:,.0f} t CO2e/yr "
            f"({r.avoided_pct:.1%} of operational emissions; estimate).{sci}",
            metric=r.avoided_t_co2e,
        )
    ]
