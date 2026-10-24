"""Land screening: the stats every source produces, and the findings they imply.  OWNER: workstream E.

Pure functions only. Earth Engine (land.py) and the open-data prep script
(prep/land.py) both produce a LandStats for the 2 km buffer around a site, so the
thresholds below apply the same way whichever source answered.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.contract import Finding, Provenance

# ESA WorldCover v200 (2021) class values -> labels used as SiteIntel.land_cover keys.
WORLDCOVER = {
    10: "Tree cover",
    20: "Shrubland",
    30: "Grassland",
    40: "Cropland",
    50: "Built-up",
    60: "Bare / sparse vegetation",
    70: "Snow and ice",
    80: "Permanent water bodies",
    90: "Herbaceous wetland",
    95: "Mangroves",
    100: "Moss and lichen",
}

# USDA NASS Cropland Data Layer codes. 61 = Fallow/Idle Cropland; "active" = cultivated
# crop classes (field crops 1-60, tree crops/vineyards 66-80, specialty + double crops 204-254).
CDL_FALLOW = 61
CDL_ACTIVE = frozenset([*range(1, 61), *range(66, 81), *range(204, 255)])

# Screening thresholds (shares are fractions of the buffer area).
SLOPE_WARN_DEG = 5.0  # utility PV is graded/tracked on <~5 deg; steeper raises cost and grading
ACTIVE_CROP_WARN = 0.25
FALLOW_PASS = 0.10
PROTECTED_WARN, PROTECTED_FAIL = 0.01, 0.10
WATER_WARN, WATER_FAIL = 0.02, 0.10
BUILT_WARN, BUILT_FAIL = 0.10, 0.30
GHI_GOOD = 5.0  # kWh/m2/day; the Central Valley is ~5.5, the national average ~4.5


class LandStats(BaseModel):
    """Screening statistics for the buffer around one site (shares are 0-1)."""

    land_cover: dict[str, float] = Field(default_factory=dict, description="WorldCover label -> share of buffer")
    mean_slope_deg: float | None = None
    fallow_share: float | None = Field(default=None, description="CDL Fallow/Idle Cropland (61) share")
    active_crop_share: float | None = Field(default=None, description="CDL cultivated-crop share")
    protected_share: float | None = Field(default=None, description="Protected-area overlap share")
    water_share: float | None = Field(default=None, description="Surface water (JRC GSW occurrence >= 50%) share")
    solar_ghi_kwh_m2_day: float | None = None
    cdl_year: int | None = None
    buffer_km: float = 2.0
    method: Literal["earth_engine", "open_data"]
    computed_at: str = Field(description="ISO date the stats were computed")
    sources: list[Provenance] = Field(default_factory=list)


def _share(stats: LandStats, label: str) -> float:
    return stats.land_cover.get(label, 0.0)


def land_findings(s: LandStats) -> list[Finding]:
    """Turn screening stats into pass/warn/fail findings (thresholds above)."""
    out: list[Finding] = []
    km = f"{s.buffer_km:g} km"

    def add(id_: str, severity: str, title: str, detail: str, metric: float | None = None, threshold: float | None = None) -> None:
        out.append(Finding(id=id_, module="site", severity=severity, title=title, detail=detail, metric=metric, threshold=threshold))  # type: ignore[arg-type]

    if s.protected_share is not None:
        p = s.protected_share
        if p >= PROTECTED_FAIL:
            add("land_protected", "fail", "Protected land", f"{p:.0%} of the {km} buffer is a protected area; avoid or re-site.", p, PROTECTED_FAIL)
        elif p >= PROTECTED_WARN:
            add("land_protected", "warn", "Protected land nearby", f"{p:.0%} of the {km} buffer overlaps a protected area; keep the footprint clear of it.", p, PROTECTED_WARN)

    if s.water_share is not None:
        w = s.water_share
        if w >= WATER_FAIL:
            add("land_water", "fail", "Surface water on site", f"{w:.0%} of the {km} buffer is surface water.", w, WATER_FAIL)
        elif w >= WATER_WARN:
            add("land_water", "warn", "Surface water nearby", f"{w:.0%} of the {km} buffer is surface water (canal, pond or wetland); set it back.", w, WATER_WARN)

    built = _share(s, "Built-up")
    if s.land_cover and built >= BUILT_FAIL:
        add("land_built_up", "fail", "Built-up area", f"{built:.0%} of the {km} buffer is built-up; not open land.", built, BUILT_FAIL)
    elif s.land_cover and built >= BUILT_WARN:
        add("land_built_up", "warn", "Partly built-up", f"{built:.0%} of the {km} buffer is built-up.", built, BUILT_WARN)

    if s.mean_slope_deg is not None:
        sl = s.mean_slope_deg
        if sl > SLOPE_WARN_DEG:
            add("land_slope", "warn", "Steep for PV", f"Mean slope {sl:.1f} deg across the {km} buffer; PV needs grading above ~{SLOPE_WARN_DEG:g} deg.", sl, SLOPE_WARN_DEG)
        else:
            add("land_slope", "pass", "Flat terrain", f"Mean slope {sl:.1f} deg across the {km} buffer: good for single-axis trackers.", sl, SLOPE_WARN_DEG)

    year = f"CDL {s.cdl_year}" if s.cdl_year else "CDL"
    if s.fallow_share is not None and s.fallow_share >= FALLOW_PASS:
        add(
            "land_fallow",
            "pass",
            "Build on degraded land",
            f"{s.fallow_share:.0%} of the {km} buffer is fallowed/idle cropland ({year}); siting here avoids taking active farmland.",
            s.fallow_share,
            FALLOW_PASS,
        )
    if s.active_crop_share is not None and s.active_crop_share >= ACTIVE_CROP_WARN:
        add(
            "land_farmland_conversion",
            "warn",
            "Farmland conversion",
            f"{s.active_crop_share:.0%} of the {km} buffer is actively cultivated ({year}); expect county ag-land review.",
            s.active_crop_share,
            ACTIVE_CROP_WARN,
        )

    if s.solar_ghi_kwh_m2_day is not None:
        g = s.solar_ghi_kwh_m2_day
        sev = "pass" if g >= GHI_GOOD else "info"
        add("land_solar_resource", sev, "Solar resource", f"{g:.1f} kWh/m2/day average global horizontal irradiance.", g, GHI_GOOD)

    if s.land_cover:
        top = sorted(s.land_cover.items(), key=lambda kv: -kv[1])[:3]
        add("land_cover_summary", "info", "Land cover", ", ".join(f"{k} {v:.0%}" for k, v in top) + f" (ESA WorldCover, {km} buffer).")
    return out
