"""Offline tests for app.simulate.weather (B).  No network: committed site files or fakes.

Ranges and invariants only; the numbers move whenever the weather source is re-baked.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from app.simulate import weather as W

KERN = (35.40, -119.47)
YEAR = 2024
NIGHT_HOURS = [0, 1, 2, 3, 4, 20, 21, 22, 23]


def _baked(lat: float, lon: float) -> tuple[pd.DataFrame, dict]:
    csv_path, _ = W.site_paths(lat, lon, YEAR, W.SITES_DIR)
    if not csv_path.exists():
        pytest.skip(f"{csv_path.name} not baked; run python -m app.simulate.prep.sites")
    df, meta = W.load_or_fetch(lat, lon, YEAR, allow_network=False)
    assert meta["origin"] == "pre-baked"
    return df, meta


def _baked_sites() -> list[dict]:
    index = W.SITES_DIR / "index.json"
    return json.loads(index.read_text()) if index.exists() else []


def _hod(x: np.ndarray) -> pd.Series:
    return pd.Series(x).groupby(np.arange(len(x)) % 24).mean()


def _centroid_hour(x: np.ndarray) -> float:
    """Energy-weighted mean time of day, using each hour-beginning interval's midpoint (h + 0.5)."""
    hod = _hod(x)
    return float(((hod.index + 0.5) * hod).sum() / hod.sum())


@pytest.fixture(scope="module")
def kern() -> tuple[pd.DataFrame, dict]:
    return _baked(*KERN)


def test_site_key_rounds_to_hundredths() -> None:
    assert W.site_key(35.404, -119.466) == "35.40_-119.47"
    assert W.site_key(35.40, -119.47) == "35.40_-119.47"
    assert W.site_key(-0.001, 0.001) == "0.00_0.00"  # no "-0.00"


def test_wind_power_curve_exact_points() -> None:
    cf = W.wind_cf(np.array([0.0, 2.9, 3.0, 12.0, 20.0, 25.0, 26.0]))
    full = 1.0 - W.WIND_LOSSES
    assert cf[0] == 0 and cf[1] == 0 and cf[2] == 0
    assert cf[3] == pytest.approx(full)
    assert cf[4] == pytest.approx(full) and cf[5] == pytest.approx(full)
    assert cf[6] == 0  # beyond cut-out
    ramp = W.wind_cf(np.linspace(3.0, 12.0, 50))
    assert np.all(np.diff(ramp) >= 0) and ramp.min() >= 0 and ramp.max() <= full + 1e-12
    assert W.wind_cf(np.array([np.nan, -1.0])).tolist() == [0.0, 0.0]


class _FakeOpenMeteo:
    """Stands in for httpx.get: an Open-Meteo archive payload with label k = value k (or given columns)."""

    labels = pd.date_range("2024-01-01", "2025-01-01 23:00", freq="h")

    def __init__(self, offset: int = -28800, columns: dict[str, np.ndarray] | None = None) -> None:
        self.offset = offset
        k = np.arange(len(self.labels), dtype=float)
        self.columns = {v: k for v in W.OPEN_METEO_HOURLY} | (columns or {})
        self.params: dict = {}

    def __call__(self, url: str, params: dict, timeout: float) -> _FakeOpenMeteo:
        self.params = dict(params)
        return self

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        hourly: dict = {"time": self.labels.strftime("%Y-%m-%dT%H:%M").tolist()}
        hourly.update({v: [None if np.isnan(x) else float(x) for x in col] for v, col in self.columns.items()})
        return {"latitude": 35.4, "longitude": -119.5, "elevation": 82.0, "utc_offset_seconds": self.offset,
                "timezone": W.TZ, "hourly": hourly}


def test_fetch_shifts_open_meteo_labels_to_hour_beginning(monkeypatch: pytest.MonkeyPatch) -> None:
    """Radiation for interval i = label i+1; temperature/wind = mean(label i, label i+1)."""
    fake = _FakeOpenMeteo()
    monkeypatch.setattr(W.httpx, "get", fake)
    df = W.fetch_open_meteo(*KERN, YEAR)
    assert fake.params["timezone"] == "Etc/GMT+8" and fake.params["end_date"] == "2025-01-01"
    assert len(df) == 8784
    assert df.index.equals(pd.date_range("2024-01-01", periods=8784, freq="h", tz="Etc/GMT+8"))
    i = np.arange(8784)
    np.testing.assert_allclose(df["ghi_w_m2"].to_numpy(), i + 1)
    np.testing.assert_allclose(df["temp_c"].to_numpy(), i + 0.5)
    np.testing.assert_allclose(df["wind100_ms"].to_numpy(), i + 0.5)
    assert df.attrs["filled_values"] == 0

    monkeypatch.setattr(W.httpx, "get", _FakeOpenMeteo(offset=-25200))  # PDT offset: reject
    with pytest.raises(W.WeatherUnavailable):
        W.fetch_open_meteo(*KERN, YEAR)


def _gappy_weather() -> pd.DataFrame:
    """Canonical-index weather: radiation 500 W/m2 by day (0 at night), temperature ramp, steady wind."""
    import pvlib

    idx = W.hour_index(YEAR)
    zen = pvlib.solarposition.get_solarposition(idx + pd.offsets.Minute(30), *KERN)["apparent_zenith"].to_numpy()
    rad = np.where(zen < 90, 500.0, 0.0)
    return pd.DataFrame(
        {"ghi_w_m2": rad, "dni_w_m2": rad, "dhi_w_m2": rad / 5,
         "temp_c": np.arange(len(idx), dtype=float), "wind10_ms": 3.0, "wind100_ms": 6.0},
        index=idx,
    )


def _at(day: str, hour: int) -> int:
    """Index of the hour-beginning interval `day` `hour`:00 PST."""
    return int((pd.Timestamp(day) - pd.Timestamp("2024-01-01")) / pd.Timedelta(hours=1)) + hour


def test_fill_gaps_interpolates_at_most_3_hours() -> None:
    wx = _gappy_weather()
    i = _at("2024-03-10", 12)
    for c in ("temp_c", "ghi_w_m2"):
        wx.iloc[i : i + W.MAX_GAP_H, wx.columns.get_loc(c)] = np.nan
    wx.iloc[0, wx.columns.get_loc("wind100_ms")] = np.nan  # gap at the series start: nearest value
    out = W.fill_gaps(wx, *KERN)
    assert not out.isna().to_numpy().any()
    np.testing.assert_allclose(out["temp_c"].to_numpy()[i : i + 3], np.arange(i, i + 3))  # linear
    assert (out["ghi_w_m2"].to_numpy()[i : i + 3] == 500.0).all()  # daytime gap: not zero-filled
    assert out["wind100_ms"].iloc[0] == 6.0

    for n in (W.MAX_GAP_H + 1, 6):  # 4 h and 6 h gaps used to be filled silently
        wx = _gappy_weather()
        wx.iloc[i : i + n, wx.columns.get_loc("temp_c")] = np.nan
        with pytest.raises(W.WeatherUnavailable, match="temp_c"):
            W.fill_gaps(wx, *KERN)


def test_fill_gaps_zero_fills_long_radiation_gaps_only_at_night() -> None:
    rad = list(W.RADIATION_COLUMNS)
    wx = _gappy_weather()
    night = _at("2024-01-15", 0)  # 00:00-06:00 PST in January: sun down at every midpoint
    wx.iloc[night : night + 6, [wx.columns.get_loc(c) for c in rad]] = np.nan
    out = W.fill_gaps(wx, *KERN)
    assert (out[rad].iloc[night : night + 6].to_numpy() == 0).all()

    wx = _gappy_weather()
    day = _at("2024-06-15", 8)  # 08:00-18:00 PST in June: a 10 h daytime outage
    wx.iloc[day : day + 10, wx.columns.get_loc("ghi_w_m2")] = np.nan
    with pytest.raises(W.WeatherUnavailable, match="ghi_w_m2"):
        W.fill_gaps(wx, *KERN)


def test_fetch_rejects_long_daytime_radiation_outage(monkeypatch: pytest.MonkeyPatch) -> None:
    """End to end through fetch_open_meteo: a short gap is filled and counted, a long daytime gap raises."""
    n = len(_FakeOpenMeteo.labels)
    for gap_h, ok in ((3, True), (8, False)):
        ghi = np.full(n, 400.0)
        label = _at("2024-06-15", 9) + 1  # radiation for interval i comes from label i+1
        ghi[label : label + gap_h] = np.nan
        monkeypatch.setattr(W.httpx, "get", _FakeOpenMeteo(columns={"shortwave_radiation": ghi}))
        if ok:
            df = W.fetch_open_meteo(*KERN, YEAR)
            assert df.attrs["filled_values"] == gap_h and np.isfinite(df.to_numpy()).all()
        else:
            with pytest.raises(W.WeatherUnavailable, match="longer than 3 h"):
                W.fetch_open_meteo(*KERN, YEAR)


def test_pvwatts_baseline_is_labelled_and_reused(tmp_path) -> None:
    """The sidecar says which PVWatts tracker it compared against; a matching earlier result survives a re-bake."""
    from app.simulate.prep import sites as S

    assert S.pvwatts_params(*KERN)["array_type"] == S.PVWATTS_ARRAY_TYPE
    assert "array_type=3" in S.pvwatts_request_url(*KERN, array_type=3)
    raw = {"ac_annual_kwh": 2440.0, "capacity_factor_pct": 23.2, "array_type": 2,
           "request_url": S.pvwatts_request_url(*KERN, array_type=2)}
    cmp_ = S.compare(0.2778, raw)
    assert "without backtracking" in cmp_["note"] and abs(cmp_["diff_cf_points_dc"]) < 1.0

    sidecar = tmp_path / "site.json"
    sidecar.write_text(json.dumps({"pvwatts": cmp_}))
    kept = S._previous_pvwatts(sidecar, *KERN, array_type=2)
    assert kept is not None and kept["reused_from_previous_bake"] and kept["capacity_factor_pct"] == 23.2
    assert S._previous_pvwatts(sidecar, *KERN, array_type=3) is None  # different request: not reused
    assert S._previous_pvwatts(tmp_path / "missing.json", *KERN, array_type=2) is None


def test_tracker_model_on_clear_sky_is_bounded_and_centered() -> None:
    import pvlib

    idx = W.hour_index(YEAR)
    mid = idx + pd.offsets.Minute(30)
    sp = pvlib.solarposition.get_solarposition(mid, *KERN)
    cs = pvlib.clearsky.simplified_solis(90 - sp["apparent_zenith"])
    up = sp["apparent_zenith"].to_numpy() < 90

    def irr(name: str) -> np.ndarray:
        return np.where(up, np.nan_to_num(np.asarray(cs[name], dtype=float)), 0.0)

    wx = pd.DataFrame(
        {"ghi_w_m2": irr("ghi"), "dni_w_m2": irr("dni"), "dhi_w_m2": irr("dhi"),
         "temp_c": 25.0, "wind10_ms": 2.0, "wind100_ms": 6.0},
        index=idx,
    )
    cf = W.solar_cf_tracker(wx, *KERN, elevation_m=82.0)
    assert cf.shape == (8784,) and np.isfinite(cf).all()
    assert cf.min() >= 0 and cf.max() <= 1
    assert np.all(cf[np.isin(np.arange(8784) % 24, NIGHT_HOURS)] == 0)
    assert 0.28 < cf.mean() < 0.40  # clear-sky upper bound for a tracker per MW_ac
    assert abs(_centroid_hour(cf) - 12.0) < 0.5


def test_kern_frame_shape_and_bounds(kern: tuple[pd.DataFrame, dict]) -> None:
    df, _ = kern
    assert len(df) == 8784
    assert list(df.columns) == W.CSV_COLUMNS
    assert df["hour"].tolist() == list(range(8784))
    assert np.isfinite(df.to_numpy(dtype=float)).all()
    for c in ("solar_cf", "wind_cf"):
        assert df[c].between(0, 1).all()


def test_kern_solar_cf_in_expected_range(kern: tuple[pd.DataFrame, dict]) -> None:
    df, meta = kern
    cf = float(df["solar_cf"].mean())
    assert 0.20 <= cf <= 0.30  # AC basis, per MW_ac
    assert meta["solar_cf"] == pytest.approx(cf, abs=1e-3)


def test_kern_solar_peaks_at_noon_pst(kern: tuple[pd.DataFrame, dict]) -> None:
    """Catches UTC/DST misalignment. Tracker output is flat-topped (09-14 h within a few %), so its
    argmax is noise; use the energy-weighted centroid (tight: +/-0.5 h also catches a 1 h DST slip)
    and the argmax of the peaked GHI profile."""
    df, _ = kern
    assert abs(_centroid_hour(df["solar_cf"].to_numpy()) - 12.0) <= 0.5
    assert abs(_centroid_hour(df["ghi_w_m2"].to_numpy()) - 12.0) <= 0.5
    assert abs(int(_hod(df["ghi_w_m2"].to_numpy()).idxmax()) - 12) <= 1
    hod = _hod(df["solar_cf"].to_numpy())
    assert abs(int(hod.idxmax()) - 12) <= 3 and hod[12] >= 0.95 * hod.max()


def test_kern_night_hours_are_dark(kern: tuple[pd.DataFrame, dict]) -> None:
    df, _ = kern
    night = np.isin(df["hour"].to_numpy() % 24, NIGHT_HOURS)
    assert (df.loc[night, "solar_cf"] == 0).all()


def test_kern_july_clear_day_noon(kern: tuple[pd.DataFrame, dict]) -> None:
    df, _ = kern
    t = W.hour_index(YEAR)
    july = df[t.month == 7].copy()
    july["day"] = t[t.month == 7].day
    daily_ghi = july.groupby("day")["ghi_w_m2"].sum()
    clear_days = daily_ghi[daily_ghi >= daily_ghi.quantile(0.5)].index
    noon = july[(july["hour"] % 24 == 12) & july["day"].isin(clear_days)]["solar_cf"]
    assert len(noon) >= 10 and (noon > 0.7).all()


def test_kern_hottest_month_is_summer(kern: tuple[pd.DataFrame, dict]) -> None:
    df, _ = kern
    monthly = df.groupby(W.hour_index(YEAR).month)["temp_c"].mean()
    assert int(monthly.idxmax()) in (6, 7, 8)
    assert int(monthly.idxmin()) in (11, 12, 1, 2)


def test_kern_meta_provenance(kern: tuple[pd.DataFrame, dict]) -> None:
    _, meta = kern
    assert meta["site_key"] == "35.40_-119.47" and meta["n_hours"] == 8784
    assert abs(meta["grid_lat"] - KERN[0]) < 0.1 and abs(meta["grid_lon"] - KERN[1]) < 0.1
    assert "timezone=Etc%2FGMT%2B8" in meta["source_url"] and "api_key" not in json.dumps(meta)


@pytest.mark.parametrize("site", _baked_sites(), ids=lambda s: s["key"])
def test_every_baked_site_is_valid(site: dict) -> None:
    df, meta = _baked(site["lat"], site["lon"])
    assert len(df) == 8784 and np.isfinite(df.to_numpy(dtype=float)).all()
    assert df["solar_cf"].between(0, 1).all() and df["wind_cf"].between(0, 1).all()
    assert 0.18 <= df["solar_cf"].mean() <= 0.34
    assert abs(_centroid_hour(df["solar_cf"].to_numpy()) - 12.0) <= 0.5
    pv = meta.get("pvwatts")
    if pv is not None:  # PVWatts uses a TMY year: agreement within a few CF points, not exact
        assert abs(pv["diff_cf_points_dc"]) <= 3.0


def test_pvwatts_failure_never_prints_the_api_key(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    from app.simulate.prep import sites as S

    secret = "sk-test-not-a-real-key-123"
    monkeypatch.setenv("NLR_API_KEY", secret)

    def fake_get(url: str, params: dict, timeout: float) -> None:
        req = S.httpx.Request("GET", url, params=params)
        raise S.httpx.HTTPStatusError(f"429 Too Many Requests for url '{req.url}'", request=req, response=S.httpx.Response(429))

    monkeypatch.setattr(S.httpx, "get", fake_get)
    assert S.fetch_pvwatts(*KERN) is None
    err = capsys.readouterr().err
    assert "429" in err and secret not in err


def test_offline_miss_raises_clear_error() -> None:
    with pytest.raises(W.WeatherUnavailable):
        W.load_or_fetch(-89.99, 179.99, 1999, allow_network=False)
