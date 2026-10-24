# data/evaluate: the cited numbers behind GridForge's costs, emissions and BOM

Workstream C (Evaluate) owns this folder. Every number that `backend/app/evaluate/` uses to turn a
simulated year into CAPEX, OPEX, net present cost (NPC), LCOE, CO2e, NOx, 24/7 CFE, land and a
bill of materials comes from one of the four JSON files below. Each value has a source, a URL, a
note on how it was derived, and a verification record. In the UI, every headline number has a
provenance tooltip that leads back here. `GET /api/evaluate/assumptions` returns the same files.

All model outputs are **real 2024 USD**, and the discount rate is real.

## Files

| File | What it is | Produced by |
|---|---|---|
| `atb_2025_catalog.json` | NLR Annual Technology Baseline 2025 v1.0.0 rows for the five technology kinds (Moderate scenario, 2027 COD, no tax credits; 2023 USD). Includes exact ATB parameter names, the GCC-free CAPEX, the battery $/kW + $/kWh fit, CAPEX trajectories to 2060, lifetimes with their source, PV/wind class rationale, and ATB reference unit sizes (PV ILR, wind turbine, CC block, CT unit). | `backend/app/evaluate/prep_atb.py` |
| `ref_costs.json` | CPI-U deflators, interconnection line and substation unit costs, interconnection lifetime, land use per MW, 2024 PG&E Citygate monthly gas prices. | Hand-curated research with quotes; gas series from `prep_gas.py` |
| `ref_emissions.json` | CO2 factor for natural gas, NOx and PM2.5 factors, CARB unspecified-import factor and transmission-loss factor, eGRID CAMX rates, upstream-methane inputs, CA allowance price. | Hand-curated research with quotes |
| `bom_basis.json` | Equipment unit sizes for the BOM: PV module, inverter skid, BESS PCS and container, power factor, transformers, MV feeders, HV breakers, data-center UPS and unit substations. | Hand-curated research with datasheet citations |
| `raw/` | Raw downloads (ATB CSV, PDFs, spreadsheets) and verifier copies. **Git-ignored; never committed.** | Downloads |

Every entry in the `ref_*.json` and `bom_basis.json` files has this shape:

```json
"key": {"value": 53.06, "units": "kg CO2/MMBtu (HHV)", "kind": "observed|assumption|inferred",
        "source": "short human citation", "url": "https://...", "note": "quotes, derivation, caveats",
        "retrieved": "2026-10-23", "verified": true, "verification_note": "what the verifier re-checked"}
```

`value` is a number, or a list of numbers for a monthly series. `kind` uses the contract's
Provenance kinds: *observed* (read directly from a source), *assumption* (a representative choice),
or *inferred* (derived from observed values; the note shows the math). Every entry was
independently verified on 2026-10-23 (`verified: true`; see each `verification_note`).

## Technology catalog (atb_2025_catalog.json, via catalog.py)

Selection: ATB 2025 v1.0.0, scenario **Moderate**, COD **2027**, `crpyears` "30", no tax credits.
ATB 2025 publishes no "Market" case, so GridForge uses the **Expanded Cost Drivers (Exp)** case
where ATB publishes it (PV, land-based wind, battery) and the **R&D** case for natural gas, the only
case ATB publishes for fossil plants. It never uses a `+ TC` (tax credit) case: GridForge defaults to
no incentives. CSV: <https://oedi-data-lake.s3.amazonaws.com/ATB/electricity/csv/2025/v1.0.0/ATBe.csv>;
docs: <https://atb.nlr.gov/electricity/2025/data>.

**GCC removal (avoids double counting).** ATB's `CAPEX = OCC + GCC + CFC` includes a generic
grid-connection cost (GCC: $104/kW, or $162/kW for PV) and construction finance (CFC, in $/kW).
GridForge costs each site's interconnection explicitly (line km + substation), so the catalog uses
`capex_ex_gcc = OCC + CFC x OCC / (OCC + GCC)`, which drops GCC and GCC's share of CFC.

**Dollar year.** ATB is 2023 USD. `catalog.py` multiplies by `deflator_2023_to_2024` = 1.029494
(BLS CPI-U 313.689 / 304.702).

| Kind | ATB row (case) | ATB 2023$: CAPEX = OCC + GCC + CFC ($/kW) | capex_ex_gcc 2023$ | Catalog 2024$ | Fixed O&M 2024$ | Other |
|---|---|---|---|---|---|---|
| `solar_pv` | Utility PV - Class 2, tracking (Exp) | 1367.91 = 1161.28 + 162.40 + 44.23 | 1200.09 $/kWac | **1235.48 $/kWac** | 23.30 $/kW-yr | CF 0.3085 (display only); ILR 1.32 |
| `onshore_wind` | Land-Based Wind - Class 4 - Technology 1 (Exp) | 1775.40 = 1578.66 + 104.12 + 92.62 | 1665.55 | **1714.67 $/kW** | 39.61 $/kW-yr | CF 0.4481 (display only) |
| `gas_cc` | NG 2-on-1 Combined Cycle (H-Frame) (R&D) | 1341.70 = 1117.50 + 104.12 + 120.08 | 1227.35 | **1263.55 $/kW** | 30.78 $/kW-yr | VOM 2.04 $/MWh; heat rate 6.087 MMBtu/MWh |
| `gas_ct` | NG Combustion Turbine (F-Frame) (R&D) | 1313.69 = 1092.00 + 104.12 + 117.57 | 1199.34 | **1234.71 $/kW** | 27.18 $/kW-yr | VOM 8.75 $/MWh; heat rate 9.717 MMBtu/MWh |
| `battery` | Utility-Scale Battery Storage - 4Hr (Exp) | 1315.49 = 1168.26 + 104.12 + 43.12 (4 h) | 360.24 $/kW + 211.90 $/kWh x h | **370.86 $/kW + 218.15 $/kWh** | 14.35 $/kW-yr + 8.44 $/kWh-yr (48.11 $/kW-yr at 4 h) | RTE 0.85 |

- **Battery split.** A least-squares fit of `capex_ex_gcc(d) = power + energy x d` over the ATB 2, 4,
  6, 8 and 10 h rows is exact (R^2 = 1.0000). ATB's fixed O&M also splits exactly into $/kW-yr and
  $/kWh-yr parts (R^2 = 1.0). GridForge costs battery fixed O&M as `kW x 14.35 + kWh x 8.44`.
  `TechSpec.fixed_om_usd_per_kw_yr` shows the 4 h equivalent, and an asset override of that field
  is applied as `override x kW`.
- **Class choice.** PV Class 2: the Kern County site's NSRDB PSM V3 GHI is 5.53 kWh/m2/day, inside
  ATB's 5.5-5.75 bin. Wind Class 4: 312 WIND Toolkit sites near Tehachapi average 8.36 m/s at 110 m,
  inside the 8.35-8.57 bin. For 2027, ATB CAPEX and O&M do not vary by class, so the class only sets
  the reference CF. The simulation uses hourly weather instead. Full evidence is in
  `class_rationale` / `class_evidence`.
- **Heat rate** is ATB's full-load value and stays constant (no part-load penalty).
- **Gas CO2** comes from `ref_emissions.json` (53.06 kg/MMBtu). **Land** comes from `ref_costs.json`.
- **Replacement cost ratio** = ATB Moderate `capex_ex_gcc` trajectory at (2027 + years) divided by its
  2027 value, clamped to 2060 (battery at year 15, i.e. 2042: 855.35 / 1207.85 = **0.708**).

## Lifetimes

| Asset | Life (years) | Source |
|---|---|---|
| Utility-scale PV | 30 | NLR ATB 2025, Definitions page, table "Technical Lifetimes for Technologies" ("Solar: Utility-scale PV \| 30"), <https://atb.nlr.gov/electricity/2025/definitions> |
| Land-based wind | 30 | Same table ("Land-based wind \| 30"), <https://atb.nlr.gov/electricity/2025/definitions> |
| Gas combined cycle | 30 | Same table ("Natural gas* \| 30"; footnote: design technical life included for comparison), <https://atb.nlr.gov/electricity/2025/definitions> |
| Gas combustion turbine | 30 | Same table ("Natural gas* \| 30"), <https://atb.nlr.gov/electricity/2025/definitions> |
| Utility-scale battery | 15 | Same table ("Utility-scale battery storage* \| 15"), plus the ATB battery page: "The FOM costs include battery augmentation costs, which enables the system to operate at its rated capacity throughout its 15-year lifetime." <https://atb.nlr.gov/electricity/2025/utility-scale_battery_storage> |
| Interconnection line + substation | 47 | PG&E 2027 General Rate Case (CPUC A.25-05-009), Exhibit PG&E-10, depreciation study workpapers: FERC account 353.01 Station Equipment, "The recommendation is to use the 47-R2 survivor curve". Towers (354) use 75-R4 and overhead conductors (356) 65-R1.5. GridForge uses the shortest major component, which gives the least salvage credit. <https://docs.cpuc.ca.gov/PublishedDocs/SupDoc/A2505009/9142/604921261.pdf> |

`TechSpec.lifetime_years` is checked against `atb_2025_catalog.json` in `backend/tests/test_evaluate.py`,
and every TechSpec provenance note cites the ATB lifetimes table. Asset overrides may change
`lifetime_years`.

## Sources for every reference number

ATB values are in the table above. Long citations are shortened here; the JSON has the full source,
quotes and derivations.

### ref_costs.json

| Key | Value | Units | Kind | Source |
|---|---|---|---|---|
| `deflator_2023_to_2024` | 1.029494 | CPI-U 2024 / 2023 (313.689 / 304.702) | inferred | [BLS CPI-U, CUUR0000SA0 annual averages](https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0?startyear=2023&endyear=2024&annualaverage=true) |
| `deflator_2025_to_2024` | 0.974362 | CPI-U 2024 / 2025 (313.689 / 321.943) | inferred | [BLS CPI-U, CUUR0000SA0 annual averages](https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0?startyear=2023&endyear=2025&annualaverage=true) |
| `transmission_line_230kv_usd_per_km` | 2,489,834 | $/km, 2025$ (230 kV double circuit, lattice; $4,007k/mile) | observed | [PG&E 2025 Generator Interconnection Unit Cost Guide (CAISO), Cost Details](https://www.caiso.com/documents/pge-2025-per-unit-cost-guide-final.xlsx) |
| `transmission_line_500kv_usd_per_km` | 4,158,216 | $/km, 2025$ (500 kV single circuit, lattice; $6,692k/mile) | observed | [SCE 2025 Generator Interconnection Unit Cost Guide (CAISO); PG&E publishes no 500 kV line cost](https://www.caiso.com/documents/sce-2025-per-unit-cost-guide-final.xlsx) |
| `transmission_line_115kv_usd_per_km` | 2,107,691 | $/km, 2025$ (115 kV double circuit, lattice; $3,392k/mile) | observed | [PG&E 2025 unit cost guide](https://www.caiso.com/documents/pge-2025-per-unit-cost-guide-final.xlsx) |
| `substation_230kv_usd` | 23,000,000 | $ per new loop-in substation, 2025$ (breaker-and-a-half, 8 CB) | observed | [PG&E 2025 unit cost guide](https://www.caiso.com/documents/pge-2025-per-unit-cost-guide-final.xlsx) |
| `substation_500kv_usd` | 65,000,000 | $ per new loop-in substation, 2025$ (same layout; PG&E rough estimate) | observed | [PG&E 2025 unit cost guide](https://www.caiso.com/documents/pge-2025-per-unit-cost-guide-final.xlsx) |
| `interconnection_lifetime_years` | 47 | years | inferred | [PG&E 2027 GRC depreciation study, account 353.01 (47-R2)](https://docs.cpuc.ca.gov/PublishedDocs/SupDoc/A2505009/9142/604921261.pdf) |
| `land_acres_per_mw_solar_pv` | 5.56 | acres/MWac, direct array area (single-axis tracking) | observed | [LBNL, Bolinger & Bolinger 2022, IEEE J. Photovoltaics](https://www.energy.gov/sites/default/files/2022-01/lbnl_ieee-land-requirements-for-utility-scale-pv.pdf) |
| `land_acres_per_mw_onshore_wind` | 85.25 | acres/MW, total project area | observed | [NREL, Denholm et al. 2009, TP-6A2-45834, Table 1](https://docs.nlr.gov/docs/fy09osti/45834.pdf) |
| `land_acres_per_mw_onshore_wind_direct` | 2.47 | acres/MW, direct impact (permanent + temporary) | observed | [NREL, Denholm et al. 2009, Section 4.2](https://docs.nlr.gov/docs/fy09osti/45834.pdf) |
| `land_acres_per_mw_gas_cc` | 0.0245 | acres/MW | assumption | [EIA / Sargent & Lundy, Capital Cost study (AEO2025), Case 5](https://www.eia.gov/analysis/studies/powerplants/capitalcost/pdf/capital_cost_AEO2025.pdf) |
| `land_acres_per_mw_gas_ct` | 0.0477 | acres/MW | assumption | [EIA / Sargent & Lundy (AEO2025), Case 4](https://www.eia.gov/analysis/studies/powerplants/capitalcost/pdf/capital_cost_AEO2025.pdf) |
| `land_acres_per_mw_battery` | 0.04 | acres/MW at 4 h (0.01 acres/MWh; scaled by energy) | assumption | [EIA / Sargent & Lundy (AEO2025), Case 19](https://www.eia.gov/analysis/studies/powerplants/capitalcost/pdf/capital_cost_AEO2025.pdf) |
| `gas_price_pge_citygate_2024_monthly_usd_per_mmbtu` | 6.07, 2.97, 2.47, 2.26, 2.19, 2.14, 3.11, 2.69, 2.54, 4.10, 2.97, 3.39 | $/MMBtu, Jan-Dec 2024 (used only as a shape) | inferred | [CAISO DMM 2024 Annual Report, Fig. 2.7 (vector points read by prep_gas.py)](https://www.caiso.com/documents/2024-annual-report-on-market-issues-and-performance-aug-07-2025.pdf) |
| `gas_price_pge_citygate_2024_avg_usd_per_mmbtu` | 3.08 | $/MMBtu (matches DMM's stated 2024 average) | inferred | [CAISO DMM 2024 Annual Report](https://www.caiso.com/documents/2024-annual-report-on-market-issues-and-performance-aug-07-2025.pdf) |
| `eia_citygate_ca_2024_avg_usd_per_mmbtu` | 3.65 | $/MMBtu (3.79 $/Mcf) | inferred | [EIA California citygate price, N3050CA3](https://www.eia.gov/dnav/ng/hist/n3050ca3a.htm) |

### ref_emissions.json

| Key | Value | Units | Kind | Source |
|---|---|---|---|---|
| `co2_kg_per_mmbtu_natural_gas` | 53.06 | kg CO2/MMBtu (HHV) | observed | [EPA 40 CFR 98 Subpart C, Table C-1](https://www.ecfr.gov/current/title-40/chapter-I/subchapter-C/part-98/subpart-C/appendix-Table%20C-1%20to%20Subpart%20C%20of%20Part%2098) |
| `nox_lb_per_mmbtu_gas_turbine_lean_premix` | 0.099 | lb NOx/MMBtu, lean-premix, no SCR (**primary NOx**) | observed | [EPA AP-42 Sec. 3.1, Table 3.1-1](https://www.epa.gov/sites/default/files/2020-10/documents/c03s01.pdf) |
| `nox_lb_per_mmbtu_gas_turbine_scr_bact` | 0.00737 | lb NOx/MMBtu, combined cycle with SCR, 2.0 ppm @ 15% O2 via EPA Method 19 | inferred | [BAAQMD BACT Guideline 89.1.6](https://www.baaqmd.gov/~/media/files/engineering/bact-tbact-workshop/combustion/89-1-6.pdf?rev=1a8ca31ab5f2494299e6bb7907f734d9&sc_lang=en) |
| `nox_lb_per_mmbtu_gas_ct_scr_bact` | 0.00921 | lb NOx/MMBtu, simple cycle with SCR, 2.5 ppm (2.5 x 1.194e-7 x 8710 x 20.9/5.9) | inferred | [BAAQMD BACT Guideline 89.1.3](https://www.baaqmd.gov/~/media/files/engineering/bact-tbact-workshop/combustion/89-1-3.pdf?rev=57f31d07ea51454587124a64e8349bab&sc_lang=en) |
| `pm25_lb_per_mmbtu_gas_turbine` | 0.0066 | lb/MMBtu, total PM treated as PM2.5 (upper bound) | inferred | [EPA AP-42 Sec. 3.1, Table 3.1-2a](https://www.epa.gov/sites/default/files/2020-10/documents/c03s01.pdf) |
| `carb_unspecified_import_t_co2_per_mwh` | 0.428 | t CO2e/MWh | observed | [CARB MRR, 17 CCR 95111(b)(1)](https://www.law.cornell.edu/regulations/california/17-CCR-95111) |
| `carb_transmission_loss_factor` | 1.02 | multiplier (TL) in CO2e = MWh x TL x 0.428 | observed | [CARB MRR, 17 CCR 95111(b)(1)](https://www.law.cornell.edu/regulations/california/17-CCR-95111) |
| `egrid_camx_co2_lb_per_mwh` | 428.464 | lb CO2/MWh (= 194.3 kg/MWh), total output rate, eGRID2023 | observed | [EPA eGRID summary data](https://www.epa.gov/egrid/summary-data) |
| `egrid_camx_gas_co2_lb_per_mwh` | 870.757 | lb CO2/MWh (= 395.0 kg/MWh), gas-fired output rate, eGRID2023 | observed | [EPA eGRID2023 data file, SRL23](https://www.epa.gov/system/files/documents/2025-06/egrid2023_data_rev2.xlsx) |
| `upstream_methane_leak_rate` | 0.023 | CH4 emitted / CH4 produced | assumption | [Alvarez et al. 2018, Science](https://pmc.ncbi.nlm.nih.gov/articles/PMC6223263/) |
| `ch4_gwp100` | 29.8 | kg CO2e / kg CH4 (fossil) | observed | [IPCC AR6 WG1 Ch. 7, Table 7.15](https://www.ipcc.ch/report/ar6/wg1/chapter/chapter-7/) |
| `ch4_kg_per_mmbtu_gas` | 17.78 | kg CH4 contained per MMBtu | inferred | [40 CFR 98.233 + Table C-1](https://www.ecfr.gov/current/title-40/chapter-I/subchapter-C/part-98/subpart-W/section-98.233) |
| `upstream_methane_kg_co2e_per_mmbtu` | 12.47 | kg CO2e/MMBtu = 0.023/0.977 x 17.78 x 29.8 | inferred | [Derived; Alvarez et al. 2018](https://pmc.ncbi.nlm.nih.gov/articles/PMC6223263/) |
| `ca_allowance_price_usd_per_t` | 32.48 | $/t, **nominal 2026**, Aug 2026 auction settlement (UI hint only) | observed | [CARB Joint Auction #48 summary results](https://ww2.arb.ca.gov/sites/default/files/2026-08/nc-aug_2026_summary_results_report.pdf) |

### bom_basis.json

| Key | Value | Units | Kind | Source |
|---|---|---|---|---|
| `pv_module_w` | 550 | W per bifacial module | assumption | [Utility bifacial module datasheet](https://www.bilasolar.com/wp-content/uploads/2026/02/Bila-Solar-AA550US6x24GG_DataSheet_V2.5.pdf) |
| `pv_inverter_mva` | 4.6 | MVA per central inverter / MV skid | assumption | [1,500 VDC MV power-station datasheet](https://files.sma.de/downloads/MVPS-S2-SC4-0-4-6-UP-US-DS-en_us-29.pdf) |
| `bess_pcs_mw` | 4.37 | MW per BESS PCS skid (4.6 MVA x 0.95) | inferred | [Same datasheet](https://files.sma.de/downloads/MVPS-S2-SC4-0-4-6-UP-US-DS-en_us-29.pdf) |
| `battery_container_mwh` | 5.0 | MWh per 20-ft LFP container | assumption | [5 MWh BESS container datasheet](https://www.chintpowersystems.com/wp-content/uploads/2024/03/CPS-5-MWh-BESS-Datasheet-3-15-2024.pdf) |
| `power_factor` | 0.95 | MW to MVA | observed | [FERC Order No. 827](https://www.ferc.gov/sites/default/files/2020-06/RM16-1-000.pdf) |
| `mpt_mva` | 200 | MVA per 230/34.5 kV main power transformer | assumption | [Collector step-up transformer catalog](https://www.prolec.energy/transformers/renewable-transformers/collector-step-up-transformers/) |
| `mv_feeder_mw` | 30 | MW per 34.5 kV feeder | assumption | [Built 34.5 kV collector systems](https://eciusa.com/projects/mccoy-solar-34-5-kv-collection-system/) |
| `mv_feeders_per_switchgear_lineup` | 4 | feeders per 34.5 kV lineup | inferred | [Built 34.5 kV collector substations](https://eciusa.com/projects/mccoy-solar-34-5-kv-collection-system/) |
| `hv_breakers_per_element` | 1.5 | breakers per element (breaker-and-a-half) | observed | [National Academies (2012), App. F](https://www.nationalacademies.org/read/12050/chapter/19) |
| `dc_ups_module_mw` | 1.5 | MW per data-center UPS module | assumption | [Large 3-phase UPS product page](https://www.vertiv.com/en-us/products-catalog/critical-power/uninterruptible-power-supplies-ups/1.5mw-ul/) |
| `dc_ups_redundancy_factor` | 4/3 | installed / IT load (4-to-make-3 distributed redundant) | assumption | [UPS design configurations white paper](https://advancedpower.co.uk/wp-content/uploads/2024/12/Comparing-UPS-System-Designs.pdf) |
| `dc_unit_substation_mva` | 3.0 | MVA per 34.5 kV / 480 V unit substation | assumption | [Data-center power-chain reference](https://fabtekindustries.com/post-data-center-electrical-room-power-chain) |
| `dc_service_transformer_mva` | 100 | MVA per 230/34.5 kV service transformer | assumption | [Data-center transformer article](https://northfieldtransformers.com/blog/the-evolving-role-of-transformers-in-data-centers/) |

ATB reference units used by the BOM (in `atb_2025_catalog.json`, with quotes): PV ILR 1.32; wind
turbine 3.4 MW (2023 market average; ATB's 2035 T1 turbine is 6 MW); CC block 1,118 MW-net with
2 GTs + 1 ST; CT unit 233 MW-net.

## Horizon method (finance.py)

The analysis runs N = `analysis_years` (default 20), while PV, wind and gas last 30 years, batteries 15
and the interconnection 47. GridForge uses **explicit cash flows**, in real dollars at a real discount
rate r (default 7%):

```
year 0        all CAPEX
years 1..N    constant annual OPEX = fixed O&M + variable O&M + fuel + purchased power + carbon - export credit
k*L < N       an asset with life L is re-bought at each k*L (k >= 1), cost x ATB Moderate cost ratio for that year
year N        salvage credit = cost of the last installation x (t_last + L - N) / L,  t_last = largest k*L < N (k >= 0)

NPC  = sum_{t=0..N} CF_t / (1+r)^t
LCOE = NPC / sum_{t=1..N} MWh_served / (1+r)^t          (MWh_served = demand - unmet)
Cross-check (extras.lcoe_crf_usd_per_mwh): (sum_i CAPEX_i x CRF(r, L_i) + OPEX) / MWh_served,  CRF = r(1+r)^L / ((1+r)^L - 1)
```

Salvage fractions at N = 20: life 30 gives 1/3; life 15 (replaced in year 15) gives 10/15 = 2/3;
life 10 gives 0; life 20 gives 0; life 47 gives 27/47.

**Worked example** (hybrid preset battery, 300 MW / 1,200 MWh, r = 7%, N = 20):

- Year 0 CAPEX: 300,000 kW x $370.86 + 1,200,000 kWh x $218.15 = **$373.0M**
- Year 15 replacement: $373.0M x 0.708 (ATB 2042 / 2027) = $264.2M, PV = 264.2 x 1.07^-15 (0.3624) = **$95.7M**
- Year 20 salvage: $264.2M x (15 + 15 - 20)/15 = $176.1M, PV credit = 176.1 x 1.07^-20 (0.2584) = **-$45.5M**
- Fixed O&M: 300,000 x $14.35 + 1,200,000 x $8.44 = $14.4M/yr, PV = 14.4 x annuity factor 10.594 = **$152.9M**

The hybrid preset's 1,300 MWac of PV costs $1,606.1M, and its salvage credit is
1,606.1 / 3 x 0.2584 = **-$138.4M**. `extras.npc_breakdown` lists every such present value. The
entries sum to `npc_usd` (to within $1) and `extras.cash_flows` holds the year-by-year table.

## Double-counting rules

1. **Owned generation is never purchased power.** On-site PV, wind, gas and battery output is costed
   only through CAPEX + O&M + fuel. `purchased_power = sum_h imports_h x (price_h + import_adder)`, where
   `price_h` is the simulation's hourly price, or `flat_price_usd_per_mwh` when `price_source` is "flat".
   The test suite checks that doubling on-site output leaves purchased power unchanged.
2. **Interconnection is costed once.** ATB's generic grid-connection cost (GCC, and GCC's share of
   construction finance) is removed from every technology's CAPEX. The site's line (km x $/km) and
   new substation are costed explicitly instead.
3. **Carbon is priced on on-site combustion CO2 only.** CAISO LMPs already embed California
   cap-and-invest allowance costs, so pricing imports again would count them twice. Upstream
   methane is reported but never priced.
4. **Exports earn nothing by default.** A behind-the-meter campus is not paid for exports
   (`options.export_credit_fraction`, default 0). Exports also earn no emission credit.
5. **The gas price scalar is authoritative.** The 2024 Citygate monthly shape is normalized to mean
   1, so fuel cost is linear in `assumptions.gas_price_usd_per_mmbtu`. The shape applies only when
   `weather_year == 2024` and `options.gas_price_shape != "flat"`; otherwise the price is flat.

## Emissions and import accounting

- **Direct CO2** for each gas kind = MWh x heat rate x 53.06 kg/MMBtu / 1000. Combustion CH4 and N2O
  (<0.1% of CO2e) are omitted. Batteries and exports carry no direct emissions or credits.
- **Imports, primary method: CAISO hourly average.** `sum_h imports_h x grid_co2_h / 1000`, using the
  simulation's hourly average intensity. This rewards importing when the grid is clean.
- **Imports, alternative: CARB unspecified.** 17 CCR 95111(b)(1): `CO2e = MWh x TL x EF` =
  imports MWh x 1.02 x 0.428 = imports x **0.43656 t/MWh**. This is the regulatory proxy for marginal,
  dispatchable WECC imports. It is reported in `extras.emissions_import_methods.carb_unspecified`, and
  the UI can switch to it.
- **Cross-check:** eGRID2023 CAMX total output rate is 194.3 kg/MWh. eGRID is generation-based, so it
  excludes imports into California. Shown next to the simulation's import-weighted intensity.
- **Upstream methane** (optional, `options.include_upstream_methane`, default off): gas MMBtu x 12.47
  kg CO2e/MMBtu. Always reported in `extras.upstream_methane_t_co2e`.
- **NOx / PM2.5** (metric t/yr) = gas MMBtu x lb/MMBtu x 0.45359237 / 1000. The primary NOx case is
  AP-42 lean-premix, 0.099 lb/MMBtu with no SCR (conservative). The CA BACT SCR alternative uses
  0.00737 lb/MMBtu for CC (2.0 ppm) and 0.00921 lb/MMBtu for CT (2.5 ppm). PM2.5 is AP-42 total PM,
  0.0066 lb/MMBtu. All are 0.0 without gas.
- **Honest ordering:** factors are never tuned to make one preset look better. On-site gas CC
  (6.087 x 53.06 = 323 kg/MWh) can be dirtier than CAISO's average imports.

## 24/7 carbon-free energy (cfe.py)

For each hour, with demand D:

```
R_used      = max(solar + wind - curtailed - exports, 0)
R_to_load   = min(R_used, D);   R_to_charge = min(charge, R_used - R_to_load)
rest of the charge comes from imports and gas, pro rata to their output that hour
CL          = R_to_load + discharge x f + (imports - imports_to_charge) x g_h
matched     = D > 0 and CL >= D (1e-6 tolerance)
```

- `g_h`, the grid's clean share, comes from `sim.extras["grid_cfe_share"]` (a per-hour list or a
  scalar). If that is missing or invalid, it is inferred as `clip(1 - grid_co2_h / 395 kg/MWh, 0, 1)`,
  where 395 = eGRID2023 CAMX gas-fired rate 870.757 lb/MWh x 0.45359237. `extras.cfe_grid_share_source`
  records which was used.
- `f` is the battery's clean fraction. The battery is modeled as a well-mixed energy pool that starts
  at the clean share of the year's charging energy.
- **cfe_score_24_7** = matched hours / hours with demand (SVCE's hourly-matching question).
  `cfe_hourly_energy_share` = sum min(CL, D) / sum D. `cfe_annual_netting_share` =
  min(1, (sum(solar + wind - curtailed) + sum(imports x g)) / sum D) is shown for contrast.
  `cfe_by_month` and `cfe_by_hour_of_day` break the score down by month and by hour.

## Land

- PV uses 5.56 acres/MWac. This is LBNL's **direct array area**, not the fenced site.
- Wind uses 85.25 acres/MW of **total project area**, including turbine spacing, most of which stays
  farmable. The direct footprint is 2.47 acres/MW.
- Gas and battery rates come from EIA/Sargent & Lundy. Battery land scales with energy (0.01 acres/MWh).
- `extras.land_acres_total` is the project area. `extras.land_acres_direct_total` uses wind's direct
  footprint (exclusive use). `extras.land_acres_by_kind` is the project area by kind.

## Bill of materials (bom.py)

The BOM gives screening counts from nameplate and the unit sizes above. Every row's `basis` string
shows the formula with its numbers. Row names carry a group prefix:

- **Generation:**
  - PV MWdc = MWac x 1.32.
  - PV modules = ceil(MWac x 1.32 x 1000 / 0.55).
  - PV inverter skids = ceil(MWac / (4.6 x 0.95)).
  - Wind turbines = ceil(MW / 3.4). The basis also shows the 6 MW T1 count.
  - Battery containers = ceil(MWh / 5.0). BESS PCS = ceil(MW / 4.37).
  - CC GT/HRSG trains = ceil(MW / (1,118 / 2)). STs = ceil(GTs x 1/2).
  - CTs = ceil(MW / 233).
- **Land:** one row per kind at project area, plus totals (project area and direct footprint).
- **Interconnection:** line km for the voltage tier, and the new substation if one is built.
  Voltage tiers: POI >= 345 kV uses the 500 kV tier; POI <= 161 kV uses the 115 kV tier (priced with
  the 230 kV substation); unknown POI voltage uses the 230 kV tier.
- **Electrical:**
  - Main power transformers = ceil((PV + wind + battery MW) / 0.95 / 200). Gas units step up
    through their own GSUs, one per GT and per ST.
  - MV pad-mount transformers: one per PV skid, one per BESS PCS and one per wind turbine.
  - Data-center service transformers = ceil(peak / 0.95 / 100) + 1 (N+1).
  - HV breakers = ceil(1.5 x (MPTs + GSUs + service transformers + line terminals)).
  - MV feeders = ceil(collector MW / 30) + ceil(peak / 30). Switchgear lineups = ceil(feeders / 4).
  - UPS modules = ceil(IT MW / 1.5 x 4/3), where IT MW = peak / PUE.
  - Unit substations = ceil(ceil(peak / 0.95 / 3.0) x 4/3).
  - UPS modules, unit substations and service transformers appear only for `demand.kind == "data_center"`.

These are screening estimates, not an engineered design. The interconnection cost and any network
upgrades need a utility interconnection study.

## Regenerating the data

```bash
# ATB catalog: download the 320 MB CSV into the git-ignored raw/ folder, then extract
curl -o data/evaluate/raw/ATBe_2025_v1.0.0.csv https://oedi-data-lake.s3.amazonaws.com/ATB/electricity/csv/2025/v1.0.0/ATBe.csv
(cd backend && .venv/bin/python -m app.evaluate.prep_atb)      # rewrites data/evaluate/atb_2025_catalog.json

# 2024 PG&E Citygate monthly gas prices (needs pypdf from requirements/c-evaluate.txt)
curl -o data/evaluate/raw/costs/2024-annual-report-on-market-issues-and-performance-aug-07-2025.pdf \
  https://www.caiso.com/documents/2024-annual-report-on-market-issues-and-performance-aug-07-2025.pdf
(cd backend && .venv/bin/python -m app.evaluate.prep_gas)      # prints values to copy into ref_costs.json

# After any change: the tests check ranges, lifetimes, provenance and invariants
(cd backend && .venv/bin/pytest -q tests/test_evaluate.py)
```

`ref_costs.json`, `ref_emissions.json` and `bom_basis.json` are curated by hand. When you edit them,
keep the entry shape, quote the source in `note`, set `verified` to false until someone re-checks
the value, and keep the 2-space JSON formatting. `catalog.py` caches the files on first load, so
restart the server after editing them.
