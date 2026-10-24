"""A shared local-clock month/day/hour view; annual results remain annual."""
import calendar as std_calendar

import numpy as np

from app.household.carbon import intensity_kg_per_kwh
from app.household.data import caiso, calendar


def time_view(req, load, base, solar, plan):
    cal = calendar()
    mask = np.ones(len(load), dtype=bool)
    if req.view_month is not None:
        mask &= cal.month_h == req.view_month - 1
    if req.view_day_type != "all":
        mask &= cal.weekend_h == (1 if req.view_day_type == "weekend" else 0)
    count = np.bincount(cal.local_hod[mask], minlength=24)

    def average(values):
        sums = np.bincount(cal.local_hod[mask], weights=np.asarray(values)[mask], minlength=24)
        return np.round(np.divide(sums, count, out=np.zeros(24), where=count > 0), 6).tolist()

    intensity = intensity_kg_per_kwh()[0]
    rates, period_idx, names = plan.tables()
    grid = caiso()
    mix, clean = {}, [0.] * 24
    if grid is not None:
        mix = {k.removesuffix("_mw"): average(np.clip(v, 0, None)) for k, v in grid.items() if k.endswith("_mw")}
        clean = average(grid["grid_cfe_share"])
    periods = []
    for hour in range(24):
        found = {names[int(i)] for i in period_idx[mask & (cal.local_hod == hour)]}
        periods.append(next(iter(found)) if len(found) == 1 else "mixed")
    month = std_calendar.month_name[req.view_month] if req.view_month else "All months"
    day = {"all": "all days", "weekday": "weekdays", "weekend": "weekends"}[req.view_day_type]
    return {
        "annual_grid_clean_share": float(np.dot(base.grid_import, grid["grid_cfe_share"]) / base.grid_import.sum()) if grid is not None and base.grid_import.sum() > 0 else None,
        "reference_year": 2024, "month": req.view_month, "day_type": req.view_day_type, "hour": req.view_hour,
        "label": f"{month}, {day}", "days": int(mask.sum() // 24),
        "load_kwh": average(load), "grid_import_kwh": average(base.grid_import),
        "solar_kwh": average(solar), "carbon_kg": average(base.grid_import * intensity),
        "intensity_kg_per_kwh": average(intensity), "import_energy_cost_usd": average(base.grid_import * rates),
        "retail_rate_usd_per_kwh": average(rates), "periods_by_hour": periods,
        "mix_mw": mix, "clean_share": clean,
        "basis": "Average of matching 2024 local-clock hours; seasonal tariffs use the loaded rate sheet, not 2024 prices. "
                 "CAISO mix is historical regional context, not live data or the home's physical supplier. "
                 "Solar uses the nearest cached PVWatts typical-year city profile. "
                 "Import energy cost excludes baseline credits, export credits, fixed charges and minimum bills. "
                 "DST uses whole-day shifts; transition days are approximate. Annual totals and what-if savings cover the full year.",
    }
