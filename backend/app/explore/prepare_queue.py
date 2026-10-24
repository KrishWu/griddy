"""Interconnection-queue context per California county ("what's already proposed nearby").  OWNER: workstream A.

Source: Lawrence Berkeley National Laboratory "Queued Up: 2026 Edition" data file (project-level
interconnection requests through the end of 2025, compiled with GridTracker; CC BY 4.0). The queue
lists a county per request but no coordinates, so this script aggregates ACTIVE requests located in
California (state == "CA") by county and writes data/explore/queue_ca_by_county.json:

    {"source", "url", "page_url", "as_of", "license", "note",
     "statewide": {"active_projects", "active_mw", "generation_mw", "storage_mw", "ia_executed_projects",
                   "ia_executed_mw", "by_type_mw", "by_entity_mw"},
     "counties": {"Kern": {"active_projects", "active_mw", "generation_mw", "storage_mw", "ia_executed_projects",
                           "ia_executed_mw", "by_type_mw",
                           "largest": [{"name", "type", "tech", "mw", "queue_year", "phase", "entity", "poi"}]}, ...}}

All 58 counties of data/explore/counties_ca.geojson are present (zeros where nothing is queued), keyed
by that layer's `name`. Counties are matched by 5-digit FIPS code (fallback: normalized name). A request
listing several counties ("Kern/Los Angeles") is split equally across them (LBNL already keeps only the
first listed county, so this is a safeguard). `active_mw` is nameplate generation + storage
(mw_1 + mw_2 + mw_3); a multi-technology request counts wholly in the "hybrid" bucket.

Run from backend/:  .venv/Scripts/python -m app.explore.prepare_queue
Idempotent: reuses the cached raw download in data/explore/raw/.
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import pandas as pd

from app.explore._prep_utils import OUT_DIR, RAW_DIR, download

SOURCE = "LBNL Queued Up: 2026 Edition data file (interconnection requests through 2025)"
SOURCE_URL = "https://eta-publications.lbl.gov/sites/default/files/2026-05/lbnl_ix_queue_data_file_thru2025.xlsx"
PAGE_URL = "https://emp.lbl.gov/queues"
AS_OF = "2025-12-31"
LICENSE = "CC BY 4.0; attribute Lawrence Berkeley National Laboratory and GridTracker"
SHEET = "03. Complete Queue Data"
RAW_PATH = RAW_DIR / "lbnl_ix_queue_data_file_thru2025.xlsx"
COUNTIES_PATH = OUT_DIR / "counties_ca.geojson"
OUT_PATH = OUT_DIR / "queue_ca_by_county.json"
BUDGET_BYTES = 300_000
TOP_N = 3

BUCKETS: tuple[str, ...] = ("solar", "battery", "wind", "gas", "geothermal", "hybrid", "other")
STORAGE_TYPES = {"battery", "other storage"}
SINGLE_TYPE_BUCKET: dict[str, str] = {
    "solar": "solar",
    "battery": "battery",
    "other storage": "battery",
    "wind": "wind",
    "offshore wind": "wind",
    "gas": "gas",
    "geothermal": "geothermal",
}
REQUIRED_COLUMNS = {
    "q_id", "q_status", "IA_phase_clean", "county", "state", "fips_code", "poi_name", "project_name", "entity",
    "type_1", "type_2", "type_3", "type_clean", "mw_1", "mw_2", "mw_3", "q_year",
}
COUNTY_SPLIT_RE = re.compile(r"\s*(?:/|,|;|&|\+|\band\b)\s*", flags=re.IGNORECASE)
NAME_ALIASES: dict[str, str] = {"san bernadino": "san bernardino", "los angles": "los angeles", "san louis obispo": "san luis obispo"}


def bucket_for(type_clean: str) -> str:
    """Map LBNL's standardized resource type to one of BUCKETS ("Solar+Battery" -> "hybrid")."""
    t = type_clean.strip().lower()
    if "+" in t:
        return "hybrid"
    return SINGLE_TYPE_BUCKET.get(t, "other")


def _num(v: Any) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    return x if math.isfinite(x) else 0.0


def _str_or_none(v: Any) -> str | None:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    s = str(v).strip()
    return s or None


def _norm_name(s: str) -> str:
    s = re.sub(r"\s+(county|co\.?)$", "", s.strip(), flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).lower()
    return NAME_ALIASES.get(s, s)


def load_counties() -> tuple[dict[str, str], dict[str, str]]:
    """Counties layer -> ({geoid: name}, {normalized name: name})."""
    fc = json.loads(COUNTIES_PATH.read_text(encoding="utf-8"))
    by_fips = {f["properties"]["geoid"]: f["properties"]["name"] for f in fc["features"]}
    by_name = {_norm_name(n): n for n in by_fips.values()}
    if len(by_fips) != 58:
        raise SystemExit(f"{COUNTIES_PATH.name}: expected 58 California counties, found {len(by_fips)}")
    return by_fips, by_name


def read_queue(path: Path) -> pd.DataFrame:
    """Read the project-level sheet, locating the header row (the sheet starts with a nav link)."""
    raw = pd.read_excel(path, sheet_name=SHEET, header=None)
    header_rows = raw.index[raw.iloc[:, 0].astype(str).str.strip() == "q_id"]
    if len(header_rows) == 0:
        raise SystemExit(f"{path.name}: no 'q_id' header row in sheet {SHEET!r}")
    h = int(header_rows[0])
    df = raw.iloc[h + 1 :].copy()
    df.columns = [str(c).strip() for c in raw.iloc[h]]
    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise SystemExit(f"{path.name}: missing columns {sorted(missing)}")
    return df.reset_index(drop=True)


def resolve_counties(county: Any, fips: Any, by_fips: dict[str, str], by_name: dict[str, str]) -> tuple[list[str], list[str]]:
    """Return (matched county names, unmatched raw parts) for one request."""
    text = _str_or_none(county) or ""
    parts = [p for p in COUNTY_SPLIT_RE.split(text) if p.strip()]
    fips_name = None
    if _num(fips) > 0:
        fips_name = by_fips.get(f"{int(_num(fips)):05d}")
    if len(parts) <= 1 and fips_name:
        return [fips_name], []
    matched: list[str] = []
    unmatched: list[str] = []
    for p in parts:
        name = by_name.get(_norm_name(p))
        if name and name not in matched:
            matched.append(name)
        elif not name:
            unmatched.append(p)
    if not matched and fips_name:
        matched = [fips_name]
    return matched, unmatched


def _empty_agg() -> dict[str, Any]:
    return {"projects": 0, "mw": 0.0, "gen": 0.0, "sto": 0.0, "ia_n": 0, "ia_mw": 0.0, "types": dict.fromkeys(BUCKETS, 0.0), "items": []}


def main() -> None:
    raw_path = download(SOURCE_URL, RAW_PATH)
    by_fips, by_name = load_counties()
    df = read_queue(raw_path)

    ca = df[df["state"].astype(str).str.strip().str.upper() == "CA"]
    status = ca["q_status"].astype(str).str.strip().str.lower()
    active = ca[status == "active"]
    print(f"{raw_path.name}: {len(df):,} requests; CA {len(ca):,} ({status.value_counts().to_dict()}); active CA {len(active)}")

    counties: dict[str, dict[str, Any]] = {name: _empty_agg() for name in sorted(by_fips.values())}
    state = _empty_agg()
    by_entity: dict[str, float] = defaultdict(float)
    unmatched: dict[str, int] = defaultdict(int)
    n_split = 0
    n_zero_mw = 0
    n_hybrid_no_storage = 0

    for row in active.itertuples(index=False):
        r = row._asdict()
        comps = [(_str_or_none(r[f"type_{i}"]) or "", _num(r[f"mw_{i}"])) for i in (1, 2, 3)]
        mw = sum(m for _, m in comps)
        sto = sum(m for t, m in comps if t.lower() in STORAGE_TYPES)
        gen = mw - sto
        tech = _str_or_none(r["type_clean"]) or _str_or_none(r["type_1"]) or "Other"
        bucket = bucket_for(tech)
        if mw <= 0:
            n_zero_mw += 1
        if bucket == "hybrid" and sto == 0 and any(t.lower() in STORAGE_TYPES for t in tech.lower().split("+")):
            n_hybrid_no_storage += 1
        entity = _str_or_none(r["entity"]) or "unknown"
        phase = _str_or_none(r["IA_phase_clean"])
        ia = 1 if phase == "IA Executed" else 0

        state["projects"] += 1
        state["mw"] += mw
        state["gen"] += gen
        state["sto"] += sto
        state["ia_n"] += ia
        state["ia_mw"] += mw * ia
        state["types"][bucket] += mw
        by_entity[entity] += mw

        names, bad = resolve_counties(r["county"], r["fips_code"], by_fips, by_name)
        for b in bad:
            unmatched[b] += 1
        if not names:
            unmatched[_str_or_none(r["county"]) or "<blank>"] += 1
            continue
        if len(names) > 1:
            n_split += 1
        share = 1.0 / len(names)
        q_year = _num(r["q_year"])
        for name in names:
            c = counties[name]
            c["projects"] += 1
            c["mw"] += mw * share
            c["gen"] += gen * share
            c["sto"] += sto * share
            c["ia_n"] += ia
            c["ia_mw"] += mw * share * ia
            c["types"][bucket] += mw * share
            item: dict[str, Any] = {
                "name": _str_or_none(r["project_name"]),
                "type": bucket,
                "tech": tech,
                "mw": round(mw * share, 1),
                "queue_year": int(q_year) if q_year > 0 else None,
                "phase": phase,
                "entity": entity,
                "poi": _str_or_none(r["poi_name"]),
            }
            if len(names) > 1:
                item["shared_with"] = [n for n in names if n != name]
            c["items"].append(item)

    def finish(a: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {
            "active_projects": int(a["projects"]),
            "active_mw": round(a["mw"], 1),
            "generation_mw": round(a["gen"], 1),
            "storage_mw": round(a["sto"], 1),
            "ia_executed_projects": int(a["ia_n"]),
            "ia_executed_mw": round(a["ia_mw"], 1),
            "by_type_mw": {b: round(a["types"][b], 1) for b in BUCKETS},
        }
        return out

    county_out: dict[str, Any] = {}
    for name, a in counties.items():
        entry = finish(a)
        entry["largest"] = sorted(a["items"], key=lambda it: (-it["mw"], it["name"] or "", it["poi"] or ""))[:TOP_N]
        county_out[name] = entry
    statewide = finish(state)
    statewide["by_entity_mw"] = {k: round(v, 1) for k, v in sorted(by_entity.items(), key=lambda kv: -kv[1])}

    note = (
        "Active interconnection requests only (q_status = active; withdrawn, suspended and operational excluded) "
        "located in California (state = CA), across CAISO and non-CAISO balancing areas (IID, LADWP, SMUD, WAPA, ...); "
        "CAISO requests sited in AZ, NV or Mexico are excluded. "
        "ia_executed_* counts requests whose standardized study phase is 'IA Executed' (signed interconnection agreement). "
        "Transmission-level generation/storage requests only: distribution-connected and behind-the-meter projects are not in LBNL's scope. "
        "MW is requested nameplate generation + storage (mw_1+mw_2+mw_3); multi-technology requests (e.g. Solar+Battery) count wholly as 'hybrid'. "
        f"{n_hybrid_no_storage} hybrid requests have no storage MW in the public file (LBNL omits its imputed values), so hybrid MW is understated. "
        "Counties matched by FIPS to the Census counties layer; LBNL keeps only the first listed county for multi-county requests, "
        f"and any remaining multi-county entries are split equally ({n_split} split). "
        "Queue MW is not a build forecast: LBNL finds only ~13% of capacity requested 2000-2020 reached commercial operation by end of 2025."
    )
    out = {
        "source": SOURCE,
        "url": SOURCE_URL,
        "page_url": PAGE_URL,
        "as_of": AS_OF,
        "license": LICENSE,
        "note": note,
        "statewide": statewide,
        "counties": county_out,
    }
    text = json.dumps(out, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    OUT_PATH.write_text(text, encoding="utf-8")
    size = OUT_PATH.stat().st_size

    # ---- validation ----
    print(f"wrote {OUT_PATH.name}: {size / 1024:.1f} KB ({len(county_out)} counties)")
    assert size < BUDGET_BYTES, f"{OUT_PATH.name} is {size} bytes, over the {BUDGET_BYTES} budget"
    print(f"statewide: {statewide['active_projects']} active projects, {statewide['active_mw'] / 1000:.1f} GW "
          f"(generation {statewide['generation_mw'] / 1000:.1f} GW, storage {statewide['storage_mw'] / 1000:.1f} GW)")
    print(f"  with executed IA: {statewide['ia_executed_projects']} projects, {statewide['ia_executed_mw'] / 1000:.1f} GW")
    print("  by type (GW):", {k: round(v / 1000, 1) for k, v in statewide["by_type_mw"].items()})
    print("  by entity (GW):", {k: round(v / 1000, 1) for k, v in statewide["by_entity_mw"].items()})
    print(f"  zero-MW requests: {n_zero_mw}; multi-county split: {n_split}; hybrids without storage MW: {n_hybrid_no_storage}")
    county_mw = sum(c["active_mw"] for c in county_out.values())
    print(f"  sum of county MW {county_mw:,.1f} vs statewide {statewide['active_mw']:,.1f}")
    print("top 10 counties by active MW:")
    for name, c in sorted(county_out.items(), key=lambda kv: -kv[1]["active_mw"])[:10]:
        print(f"  {name:<16} {c['active_projects']:>4} projects {c['active_mw'] / 1000:>7.1f} GW")
    print(f"counties with no active requests: {sum(1 for c in county_out.values() if c['active_projects'] == 0)}")
    print(f"unmatched county strings: {dict(unmatched) or 'none'}")
    for name in ("Kern", "San Joaquin", "Merced"):
        print(f"{name}: {json.dumps(county_out[name], ensure_ascii=False)}")


if __name__ == "__main__":
    main()
