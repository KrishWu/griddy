// "Data sources": every dataset the backend reads, grouped by what it feeds, with links. Copied
// from the data READMEs (data/explore, data/evaluate, data/simulate meta, backend/app/site_intel,
// ml/*); keep in step with them.
import { Card, Ext, Section } from "./ui";

type Source = { name: string; href: string; use: string };

const GROUPS: { title: string; items: Source[] }[] = [
  {
    title: "Grid and map",
    items: [
      { name: "EIA-860 2024 (plants and generators)", href: "https://www.eia.gov/electricity/data/eia860/", use: "Power plants on the map; where each technology was built (site model labels)" },
      { name: "CEC California Electric Transmission Lines", href: "https://cecgis-caenergy.opendata.arcgis.com/datasets/CAEnergy::california-electric-transmission-lines-1", use: "Lines ≥ 69 kV, distances to the grid (CC BY 4.0)" },
      { name: "OpenStreetMap substations (Overpass API)", href: "https://www.openstreetmap.org/copyright", use: "Substations; volunteer-mapped (ODbL)" },
      { name: "CEC utility and balancing-authority areas", href: "https://services3.arcgis.com/bWPjFyq029ChCGur/arcgis/rest/services/ElectricLoadServingEntities_IOU_POU/FeatureServer/0", use: "Utility territory → which CAISO price node a site buys at" },
      { name: "LBNL Queued Up, 2026 edition", href: "https://emp.lbl.gov/queues", use: "Interconnection requests by county (CC BY 4.0)" },
      { name: "US Census 2020 block groups and 2024 Gazetteer", href: "https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/", use: "Population near a site, county demand split, map search" },
      { name: "California LCI statewide zoning (North and South)", href: "https://publish.data.ca.gov/dataset/california-statewide-zoning-south", use: "Highlight area → zoning: historical local zoning, collected mostly 2021–23" },
      { name: "OpenFreeMap basemap", href: "https://openfreemap.org", use: "Background map tiles (OpenStreetMap data)" },
    ],
  },
  {
    title: "Weather, prices and grid carbon",
    items: [
      { name: "Open-Meteo historical weather API", href: "https://open-meteo.com/en/docs/historical-weather-api", use: "2024 hourly irradiance, 100 m wind and temperature at each site; forecast-model weather; ERA5 2024 mean GHI and 100 m wind for the site model" },
      { name: "pvlib", href: "https://pvlib-python.readthedocs.io", use: "Solar tracker model (output per MW)" },
      { name: "CAISO OASIS day-ahead LMP (via gridstatus)", href: "http://oasis.caiso.com", use: "2024 hourly prices at the PG&E, SCE and SDG&E load points" },
      { name: "CAISO Today's Outlook fuel mix", href: "https://www.caiso.com/todays-outlook/supply", use: "2024 hourly grid CO₂ intensity and clean share" },
      { name: "EIA-930 Hourly Electric Grid Monitor", href: "https://www.eia.gov/electricity/gridmonitor/", use: "Community load shape; training data for the demand forecast" },
    ],
  },
  {
    title: "Costs",
    items: [
      { name: "NLR (formerly NREL) Annual Technology Baseline 2025", href: "https://atb.nlr.gov/electricity/2025/data", use: "CAPEX, O&M, heat rates, battery efficiency, lifetimes, cost trajectories" },
      { name: "CAISO participating-TO 2025 unit cost guides (PG&E, SCE)", href: "https://www.caiso.com/documents/pge-2025-per-unit-cost-guide-final.xlsx", use: "New line ($/km) and substation costs" },
      { name: "PG&E 2027 General Rate Case depreciation study", href: "https://docs.cpuc.ca.gov/PublishedDocs/SupDoc/A2505009/9142/604921261.pdf", use: "47-year interconnection life" },
      { name: "CAISO DMM 2024 Annual Report", href: "https://www.caiso.com/documents/2024-annual-report-on-market-issues-and-performance-aug-07-2025.pdf", use: "Monthly PG&E Citygate gas price shape" },
      { name: "EIA California citygate gas price (N3050CA3)", href: "https://www.eia.gov/dnav/ng/hist/n3050ca3a.htm", use: "Default gas price" },
      { name: "BLS CPI-U", href: "https://www.bls.gov/cpi/", use: "2023$ and 2025$ to 2024$" },
      { name: "LBNL (Bolinger) and NREL (Denholm) land-use studies; EIA / Sargent & Lundy", href: "https://www.energy.gov/sites/default/files/2022-01/lbnl_ieee-land-requirements-for-utility-scale-pv.pdf", use: "Acres per MW" },
    ],
  },
  {
    title: "Emissions and air",
    items: [
      { name: "EPA 40 CFR 98, Table C-1", href: "https://www.ecfr.gov/current/title-40/chapter-I/subchapter-C/part-98/subpart-C/appendix-Table%20C-1%20to%20Subpart%20C%20of%20Part%2098", use: "53.06 kg CO₂/MMBtu" },
      { name: "CARB Mandatory Reporting Regulation, 17 CCR 95111", href: "https://www.law.cornell.edu/regulations/california/17-CCR-95111", use: "Unspecified-import factor" },
      { name: "EPA AP-42 §3.1 (stationary gas turbines)", href: "https://www.epa.gov/sites/default/files/2020-10/documents/c03s01.pdf", use: "NOx and PM factors" },
      { name: "BAAQMD BACT guidelines 89.1.3 and 89.1.6", href: "https://www.baaqmd.gov/~/media/files/engineering/bact-tbact-workshop/combustion/89-1-6.pdf?rev=1a8ca31ab5f2494299e6bb7907f734d9&sc_lang=en", use: "SCR NOx alternative" },
      { name: "EPA eGRID2023", href: "https://www.epa.gov/egrid/summary-data", use: "CAMX cross-check" },
      { name: "Alvarez et al. 2018 (Science); IPCC AR6 WG1 ch. 7", href: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6223263/", use: "Upstream methane leakage and GWP" },
      { name: "EPA Green Book nonattainment areas", href: "https://www.epa.gov/green-book", use: "Air-permit risk for on-site gas" },
      { name: "AirNow (EPA and partners)", href: "https://www.airnow.gov/", use: "Current air quality at the site" },
    ],
  },
  {
    title: "Site screening, forecast and siting",
    items: [
      { name: "Google Earth Engine data catalog", href: "https://developers.google.com/earth-engine/datasets/catalog/", use: "ESA WorldCover, USDA Cropland Data Layer, USGS 3DEP slope, WDPA protected areas, JRC surface water, ERA5-Land sunshine" },
      { name: "Copernicus Sentinel-2 (harmonized surface reflectance)", href: "https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED", use: "2024 satellite imagery overlay" },
      { name: "CA Department of Finance P-2A projections", href: "https://dof.ca.gov/forecasting/demographics/projections/", use: "County population growth in the forecast" },
      { name: "Green Software Foundation SCI (ISO/IEC 21031:2024)", href: "https://sci-guide.greensoftware.foundation/", use: "Carbon per GPU-hour for carbon-aware load" },
      { name: "NVIDIA DGX H100 user guide", href: "https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html", use: "SCI assumption: 10.2 kW per 8-GPU system (1.275 kW per GPU)" },
      { name: "Luccioni, Viguier & Ligozat 2023 (JMLR), the carbon footprint of BLOOM", href: "https://jmlr.org/papers/volume24/23-0069/23-0069.pdf", use: "SCI assumption: embodied carbon per GPU and per server" },
      { name: "XGBoost and HiGHS (via SciPy)", href: "https://xgboost.readthedocs.io", use: "Forecast and suitability models; the siting linear program" },
    ],
  },
];

export function DataSources() {
  return (
    <Section
      id="data"
      title="Data sources"
      lead="All public. Processed files are committed with their source, license and vintage. The app runs without any API key; Earth Engine and AirNow only refresh the site screening when keys are set."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {GROUPS.map((g) => (
          <Card key={g.title}>
            <h3 className="font-semibold">{g.title}</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {g.items.map((s) => (
                <li key={s.name} className="min-w-0">
                  <Ext href={s.href}>{s.name}</Ext>
                  <p className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">{s.use}</p>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </Section>
  );
}
