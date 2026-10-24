// Plain-language definitions for the jargon on Griddy's panels, read by <Term> (components/glossary/Term.tsx).
// Each entry says what the word means in everyday terms AND how Griddy itself uses it, so the numbers in the
// tooltip match the model: they come from data/evaluate/README.md (costs, emissions, CFE), data/explore/README.md
// (map layers), ml/README.md (forecast + siting) and backend/app/simulate + evaluate. If one of those changes
// (a default, a factor, a data vintage), update the sentence here too.
// Rules for writing an entry: `def` is one or two short sentences a 12-year-old can follow; `why` is one line on
// why the number matters for a project; `unit` is how Griddy reports it. No entry may promise more precision
// than the model has (screening estimates, not engineering).

export interface GlossaryEntry {
  /** Short display name, e.g. "LCOE". */
  term: string;
  /** Spelled-out name when `term` is an abbreviation. */
  long?: string;
  /** One or two plain sentences. */
  def: string;
  /** One simple sentence for the dashboard information card. */
  summary: string;
  /** Optional "why it matters" line. */
  why?: string;
  /** Unit as Griddy reports it. */
  unit?: string;
}

const GWH_TWH: GlossaryEntry = {
  term: "GWh / TWh",
  long: "Gigawatt-hour / terawatt-hour",
  def: "Bigger buckets of energy: 1 GWh = 1,000 MWh and 1 TWh = 1,000,000 MWh. They are handy for yearly totals.",
  summary: "GWh and TWh measure large amounts of electrical energy.",
  why: "A 1,000 MW campus running flat out all year uses about 8.8 TWh.",
  unit: "GWh, TWh",
};

export const GLOSSARY = {
  // ---- Units ----------------------------------------------------------------
  mw: {
    term: "MW",
    long: "Megawatt",
    def: "A rate of power: how fast electricity is being made or used right now, like speed for a car. 1 MW = 1,000 kW.",
    summary: "MW measures how much power is produced or used at a moment.",
    why: "Plants, batteries and loads are sized in MW. At 6,500 kWh per home per year, 1 MW is about the average draw of 1,300 California homes.",
    unit: "MW",
  },
  mwh: {
    term: "MWh",
    long: "Megawatt-hour",
    def: "An amount of energy: 1 MW running for one hour makes 1 MWh. It is what you actually pay for, like gallons rather than speed.",
    summary: "One MWh is the energy used by one MW over one hour.",
    why: "1 MWh is roughly two months of electricity for a typical California home.",
    unit: "MWh",
  },
  gwh: GWH_TWH,
  twh: GWH_TWH,
  kw: {
    term: "kW",
    long: "Kilowatt",
    def: "One thousandth of a MW, about what a microwave oven draws. Build costs are usually quoted per kW.",
    summary: "One kW is one thousandth of a MW.",
    why: "Griddy's catalog prices each plant in $/kW (and batteries also in $/kWh), from NLR's ATB 2025.",
    unit: "kW",
  },
  kv: {
    term: "kV",
    long: "Kilovolt",
    def: "Voltage: the electrical push that moves power along a wire. Big transmission lines run at 115 to 500 kV, and higher voltage carries more power farther.",
    summary: "kV measures the voltage of an electrical connection.",
    why: "Griddy prices the new line and substation by the voltage at the point of interconnection (115, 230 or 500 kV class).",
    unit: "kV",
  },
  mmbtu: {
    term: "MMBtu",
    long: "Million British thermal units",
    def: "The standard unit for natural-gas energy. Gas is bought in $/MMBtu, the way gasoline is bought by the gallon.",
    summary: "MMBtu measures the energy in natural gas.",
    why: "Griddy's default gas price is $3.65/MMBtu, EIA's 2024 California citygate average. Fuel cost = MWh × heat rate × gas price.",
    unit: "$/MMBtu",
  },

  // ---- Carbon --------------------------------------------------------------
  co2e: {
    term: "CO2e",
    long: "Carbon dioxide equivalent",
    def: "Different greenhouse gases converted into the amount of CO2 that would warm the planet as much over 100 years.",
    summary: "CO₂e expresses greenhouse gases as an equivalent amount of carbon dioxide.",
    why: "Griddy counts CO2 from burning gas on site and from grid imports; leaked methane (1 kg ≈ 29.8 kg CO2e) is reported separately.",
    unit: "t CO2e",
  },
  t_co2e: {
    term: "t CO2e",
    long: "Metric tons of CO2 equivalent",
    def: "A metric ton (1,000 kg) of greenhouse gas, counted as CO2. A typical US car emits about 4.6 t of CO2 a year.",
    summary: "A metric ton of CO₂e measures greenhouse gas emissions.",
    why: "Griddy reports a design's yearly emissions in t CO2e (kt = 1,000 t, Mt = 1,000,000 t).",
    unit: "t CO2e/yr",
  },
  co2_intensity: {
    term: "CO2 intensity",
    long: "kg CO2e per MWh",
    def: "How much greenhouse gas comes with each MWh of electricity. Griddy divides the year's CO2e by the MWh of demand actually served.",
    summary: "Carbon intensity measures emissions per MWh of electricity supplied.",
    why: "Lower is cleaner. Gas burned in a combined-cycle plant is about 320 kg/MWh, which can be dirtier than average CAISO grid power.",
    unit: "kg CO2e/MWh",
  },
  carbon_price: {
    term: "Carbon price",
    def: "A cost per ton of CO2 emitted, added to the bill. Griddy applies it only to CO2 from burning gas on site.",
    summary: "This charge applies to each ton of on-site carbon emissions.",
    why: "Grid imports already carry California's cap-and-trade cost inside CAISO prices, so charging them again would count it twice.",
    unit: "$/t CO2",
  },
  upstream_methane: {
    term: "Upstream methane",
    def: "Natural gas (methane) that leaks from wells and pipelines before it reaches the plant. Methane traps far more heat than CO2.",
    summary: "Upstream methane is gas that leaks before reaching the plant.",
    why: "Griddy assumes a 2.3% leak rate, about 12.5 kg CO2e per MMBtu burned. It is reported but left out of the total; it is added only if the scenario option include_upstream_methane is set.",
    unit: "t CO2e/yr",
  },
  egrid: {
    term: "eGRID",
    long: "EPA Emissions & Generation Resource Integrated Database",
    def: "The EPA's database of emissions from US power plants, averaged by region. California's region is called CAMX.",
    summary: "eGRID reports average emissions from power plants by region.",
    why: "Shown only as a cross-check (about 194 kg CO2/MWh in eGRID2023). It counts power made in the region, not imports into California.",
    unit: "kg CO2/MWh",
  },

  // ---- Money ---------------------------------------------------------------
  lcoe: {
    term: "LCOE",
    long: "Levelized cost of energy",
    def: "The average cost of each MWh over the whole project: net present cost divided by all the MWh served, with future MWh discounted like future dollars.",
    summary: "LCOE is the project’s discounted lifetime cost per MWh supplied.",
    why: "One number to compare designs of any size. Griddy cross-checks it by annualizing each asset's build cost with its own CRF.",
    unit: "$/MWh",
  },
  npc: {
    term: "NPC",
    long: "Net present cost",
    def: "Everything the project costs over the analysis period, with future dollars shrunk to today's value: build cost, replacements, O&M, fuel and grid power, minus salvage and any export credit.",
    summary: "NPC is the total project cost expressed in today’s dollars.",
    why: "The total behind LCOE. Griddy's default is 20 years at a 7% real discount rate.",
    unit: "$",
  },
  capex: {
    term: "CAPEX",
    long: "Capital expenditure",
    def: "The one-time cost to build everything, paid in year 0: plants, batteries, the new grid line and the substation.",
    summary: "CAPEX is the upfront cost of building the project.",
    why: "Plant costs come from NLR's ATB 2025 with ATB's generic grid-connection cost removed, because Griddy prices the site's own line and substation.",
    unit: "$ (year 0)",
  },
  opex: {
    term: "OPEX",
    long: "Operating expenditure",
    def: "What it costs to run the project each year: maintenance (fixed and variable O&M), gas, power bought from the grid and any carbon price, minus export credit.",
    summary: "OPEX is the yearly cost of running the project.",
    why: "Griddy shows the year-1 amount. In real dollars it stays the same every year of the analysis.",
    unit: "$/yr",
  },
  om: {
    term: "O&M",
    long: "Operations and maintenance",
    def: "Upkeep. Fixed O&M is paid every year per kW (or kWh) installed, even if the plant sits idle; variable O&M is paid per MWh produced.",
    summary: "O&M covers the cost of operating and maintaining equipment.",
    why: "Rates come from NLR's ATB 2025 for each technology.",
    unit: "$/kW-yr, $/MWh",
  },
  discount_rate: {
    term: "Discount rate",
    def: "How much less a future dollar counts than a dollar today. At 7%, $1 a year from now is worth about $0.93 now.",
    summary: "The discount rate converts future costs into today’s value.",
    why: "Griddy's rate is real (inflation removed). A higher rate makes up-front build costs weigh more than future fuel savings.",
    unit: "% per year (real)",
  },
  real_dollars: {
    term: "Real dollars",
    def: "Dollars with inflation taken out, so a dollar in 2040 buys the same as a dollar in 2024.",
    summary: "Real dollars exclude the effects of inflation.",
    why: "Every Griddy cost is in real 2024 US dollars, so years can be added together fairly.",
    unit: "2024 USD",
  },
  crf: {
    term: "CRF",
    long: "Capital recovery factor (annualized cost)",
    def: "Turns a one-time build cost into an equal yearly payment over the asset's life, like a mortgage payment. CRF = r(1+r)^L ÷ ((1+r)^L − 1).",
    summary: "CRF converts a build cost into an equivalent annual payment.",
    why: "Griddy uses it only as a cross-check on LCOE: annualized CAPEX plus yearly OPEX, divided by MWh served.",
    unit: "fraction per year",
  },
  salvage: {
    term: "Salvage value",
    def: "A credit for equipment life left over when the analysis ends. A 30-year solar farm in a 20-year study still has a third of its life, so a third of its cost comes back.",
    summary: "Salvage is a credit for equipment life remaining after the study.",
    why: "Griddy credits it in the final year (discounted), so long-lived assets aren't charged for years past the study.",
    unit: "$ (credit)",
  },
  replacement: {
    term: "Replacement",
    def: "Buying an asset again when it wears out before the analysis ends.",
    summary: "Replacement covers equipment that wears out during the study.",
    why: "Batteries last 15 years, so in a 20-year study Griddy re-buys them in year 15 at ATB's projected future price (about 71% of today's).",
    unit: "$ (in the replacement year)",
  },

  // ---- Demand and operation ------------------------------------------------
  capacity_factor: {
    term: "Capacity factor",
    long: "CF",
    def: "How much a plant actually produced compared with running at full power every hour of the year. 30% means it made as much as 30% of the hours at full output.",
    summary: "Capacity factor compares actual production with continuous full-power operation.",
    why: "Griddy measures it from the simulated year: MWh produced ÷ (MW × hours). For solar and wind, the weather sets it.",
    unit: "%",
  },
  curtailment: {
    term: "Curtailment",
    def: "Solar or wind power that is thrown away because nobody can use it at that moment: demand is met, the battery is full and exports are capped or the price is negative.",
    summary: "Curtailment is available solar or wind power that goes unused.",
    why: "Griddy shows it as a share of all solar and wind output. High curtailment means paying for energy you can't use.",
    unit: "% of renewable output",
  },
  load_factor: {
    term: "Load factor",
    def: "Average demand divided by peak demand. 0.9 means the load runs at 90% of its peak on average, almost flat day and night.",
    summary: "Load factor is average demand divided by peak demand.",
    why: "With the peak fixed, a higher load factor means more MWh per year. Griddy's data-center default is 0.9.",
    unit: "0–1",
  },
  pue: {
    term: "PUE",
    long: "Power usage effectiveness",
    def: "A data center's total power divided by the power its computers (IT) use. 1.2 means 20% extra for cooling, lights and power conversion.",
    summary: "PUE compares total facility power with the power used by its computers.",
    why: "Griddy sets the facility peak = IT load × PUE, and for AI loads cooling rises on hot days.",
    unit: "ratio (≥ 1)",
  },
  it_load: {
    term: "IT load",
    def: "The power drawn by the computers themselves (servers, GPUs, storage and network), before cooling and other overhead.",
    summary: "IT load is the power used by computers before cooling and other overhead.",
    why: "Multiply by PUE to get the facility's draw at the meter.",
    unit: "MW",
  },
  peak_demand: {
    term: "Peak demand",
    def: "The most power the load draws in any one hour of the year.",
    summary: "Peak demand is the highest hourly power demand in the year.",
    why: "The grid link, gas and battery must cover the peak hour, so they are sized against it. Griddy's data-center peak includes cooling.",
    unit: "MW",
  },
  unmet: {
    term: "Unmet demand",
    long: "Unmet hours / unserved energy",
    def: "Hours when on-site plants, the battery and the allowed grid imports together couldn't cover demand, and how many MWh went missing.",
    summary: "Unmet demand is electricity the design cannot supply.",
    why: "Each unmet hour is an outage for the campus. A reliable design shows 0.",
    unit: "hours, MWh",
  },
  imports: {
    term: "Grid imports",
    def: "Electricity bought from the utility grid through the site's connection, never more than the import limit.",
    summary: "Imports are electricity purchased from the grid.",
    why: "Griddy pays the hourly price plus the import adder for each MWh and counts its CO2 at that hour's grid intensity.",
    unit: "MWh",
  },
  exports: {
    term: "Grid exports",
    def: "Extra on-site power sent out to the grid, up to the export limit and only when the price isn't negative.",
    summary: "Exports are surplus electricity sent to the grid.",
    why: "By default a behind-the-meter campus isn't paid for exports and earns no emission credit for them.",
    unit: "MWh",
  },
  lmp: {
    term: "LMP",
    long: "Locational marginal price (hourly price)",
    def: "The wholesale price of electricity at one place for one hour, set by the CAISO market.",
    summary: "LMP is the hourly wholesale electricity price at a location.",
    why: "Griddy uses CAISO's 2024 day-ahead hourly price for the site's utility area (PG&E, SCE or SDG&E), unless you choose a flat price. Sites outside SCE and SDG&E territory, municipal utilities included, use the PG&E price.",
    unit: "$/MWh",
  },
  import_adder: {
    term: "Import adder",
    long: "Grid delivery adder",
    def: "A fixed charge added to the hourly wholesale price for every MWh imported, standing in for transmission and delivery charges.",
    summary: "This charge adds delivery costs to the wholesale electricity price.",
    why: "Default $20/MWh. It raises the cost of leaning on the grid compared with on-site supply.",
    unit: "$/MWh",
  },
  onsite_clean_share: {
    term: "On-site clean share",
    def: "The part of demand served by on-site solar and wind, either directly or through the battery.",
    summary: "This share measures demand supplied by on-site solar and wind.",
    why: "Grid power isn't counted here, even when it is clean; 24/7 CFE gives the grid credit for its clean share.",
    unit: "% of demand",
  },
  flexible_load: {
    term: "Flexible load",
    def: "Work that can wait a few hours, like some AI training jobs, so it can move to the cleanest hours of the same day.",
    summary: "Flexible work can move to cleaner hours of the same day.",
    why: "Griddy moves it within the same day, never above the facility peak and without changing the day's energy. In the forecast it adds energy but not peak.",
    unit: "% of load",
  },
  marginal_emissions: {
    term: "Marginal CO2",
    def: "The extra CO2 from using one more MWh in that hour: zero if it soaks up solar that would be thrown away, much higher if it makes gas burn.",
    summary: "Marginal emissions measure the extra carbon from using more electricity.",
    why: "Moving flexible load to low-marginal hours is what actually cuts emissions.",
    unit: "kg CO2/MWh",
  },
  scenario: {
    term: "Scenario",
    def: "One complete design: the site, demand, equipment, grid connection and cost assumptions. Griddy simulates it hour by hour for a full year.",
    summary: "A scenario combines a site, demand, equipment and planning assumptions.",
    why: "Change one thing at a time and compare scenarios side by side.",
  },
  forecast_scenario: {
    term: "Forecast scenario",
    def: "A story about the future (low, mid or high growth in population, electrification and data centers), not a prediction.",
    summary: "A forecast scenario describes one possible path for future demand.",
    why: "Plan against a range of futures. Every slider is an assumption you can change.",
  },
  n_minus_1: {
    term: "N-1",
    def: "A reliability test: does the site still have enough firm supply if its single biggest piece (the largest grid tie or gas unit) fails?",
    summary: "N-1 checks supply after the largest grid connection or gas unit fails.",
    why: "Batteries are left out because they run out of energy in a long outage.",
    unit: "MW, % of critical peak",
  },

  // ---- Battery -------------------------------------------------------------
  rte: {
    term: "Round-trip efficiency",
    long: "RTE",
    def: "Of the energy put into a battery, the share you get back out. At 85%, storing 100 MWh gives back 85 MWh.",
    summary: "Round-trip efficiency is the share of stored energy returned by a battery.",
    why: "Griddy uses ATB's 85% and splits the loss evenly between charging and discharging.",
    unit: "%",
  },
  soc: {
    term: "SOC",
    long: "State of charge",
    def: "How full the battery is, from 0% (empty) to 100% (full).",
    summary: "State of charge measures how full a battery is.",
    why: "The dispatch chart draws it on the right axis. A battery that sits at 0% in the evening ran out too early.",
    unit: "% or MWh",
  },
  battery_cycles: {
    term: "Battery cycles",
    def: "How many times a year the battery's full energy is used. Griddy divides all the MWh it discharged by its MWh size.",
    summary: "Battery cycles count equivalent full discharges over a year.",
    why: "About 365 means one full discharge a day. Cycles wear a battery out, and some come from charging off cheap grid power.",
    unit: "cycles per year",
  },

  // ---- Gas plants ----------------------------------------------------------
  heat_rate: {
    term: "Heat rate",
    def: "How much fuel a gas plant burns to make one MWh. Lower is more efficient.",
    summary: "Heat rate measures the fuel needed to produce one MWh.",
    why: "From ATB: about 6.1 MMBtu/MWh for combined cycle and 9.7 for a peaker. Griddy keeps it at the full-load value every hour.",
    unit: "MMBtu/MWh",
  },
  gas_cc: {
    term: "Gas CC",
    long: "Combined-cycle gas plant",
    def: "A gas turbine whose hot exhaust also boils water to spin a steam turbine, so the same fuel makes more power.",
    summary: "Combined-cycle gas reuses turbine exhaust heat to generate more electricity.",
    why: "The most efficient gas option (about 320 kg CO2/MWh). Griddy runs it before the peaker whenever gas is needed.",
    unit: "MW",
  },
  gas_ct: {
    term: "Gas CT",
    long: "Combustion turbine, or peaker",
    def: "A jet-engine-like gas turbine that starts fast to cover peaks. It burns about 60% more fuel per MWh than a combined cycle.",
    summary: "A gas peaker starts quickly to cover periods of high demand.",
    why: "In Griddy's ATB 2025 catalog it costs about the same per kW as a combined cycle (about 2% less), so it suits a few hours a year. Griddy runs it after the combined-cycle plant.",
    unit: "MW",
  },

  // ---- 24/7 CFE ------------------------------------------------------------
  cfe_247: {
    term: "24/7 CFE",
    long: "24/7 carbon-free energy (hourly matching)",
    def: "The share of hours in which clean supply covers all of that hour's demand. Clean supply is on-site solar and wind, the clean part of battery output and the clean share of grid imports.",
    summary: "This score counts hours when clean supply covers all demand.",
    why: "Stricter than annual netting: a sunny noon surplus can't cover a dark night.",
    unit: "% of hours",
  },
  annual_netting: {
    term: "Annual netting",
    def: "Counting clean energy over the whole year: if you made or bought as many clean MWh as you used, you claim 100%, even if nights ran on gas.",
    summary: "Annual netting compares total clean energy with total yearly demand.",
    why: "Shown for contrast. The gap to hourly matching is how much clean energy was in the wrong hours.",
    unit: "% of demand",
  },
  grid_clean_share: {
    term: "Grid clean share",
    def: "The fraction of grid power that is carbon-free in a given hour.",
    summary: "Grid clean share is the carbon-free fraction of hourly grid power.",
    why: "From CAISO's 2024 hourly fuel mix: solar, wind, geothermal, nuclear and hydro, out of all supply including imports.",
    unit: "% per hour",
  },

  // ---- Air quality ---------------------------------------------------------
  nox: {
    term: "NOx",
    long: "Nitrogen oxides",
    def: "Gases made when fuel burns very hot. They help form smog (ozone) and fine particles that harm lungs.",
    summary: "NOx is a group of combustion pollutants that contribute to smog.",
    why: "Griddy estimates NOx from the gas burned with EPA's AP-42 factor (no exhaust cleanup), and shows the lower SCR case beside it.",
    unit: "t/yr",
  },
  pm25: {
    term: "PM2.5",
    long: "Fine particulate matter",
    def: "Particles 2.5 micrometers or smaller, about 30 times thinner than a hair, small enough to reach deep into the lungs.",
    summary: "PM2.5 is fine airborne pollution that can reach deep into the lungs.",
    why: "Griddy estimates it from the gas burned using EPA's AP-42 factor and counts all particles as PM2.5, an upper bound.",
    unit: "t/yr",
  },
  ap42: {
    term: "AP-42",
    def: "The EPA's standard book of emission factors: how much of a pollutant comes out per unit of fuel burned.",
    summary: "AP-42 provides EPA estimates of pollution from fuel combustion.",
    why: "Griddy uses its natural-gas turbine tables for NOx and PM2.5.",
  },
  scr_bact: {
    term: "SCR / BACT",
    long: "Selective catalytic reduction / best available control technology",
    def: "SCR is exhaust cleanup that turns NOx into nitrogen and water. BACT is the strict limit air districts set for new plants.",
    summary: "SCR removes NOx from exhaust to help meet strict air permit limits.",
    why: "Griddy's 'with SCR' NOx uses the Bay Area air district's BACT limits: 2 ppm for combined cycle, 2.5 ppm for peakers.",
  },
  nonattainment: {
    term: "Nonattainment area",
    def: "A place where the air fails a federal health standard, here ozone or PM2.5. New gas turbines there need tougher permits and emission offsets.",
    summary: "A nonattainment area fails a federal air quality standard.",
    why: "Griddy checks the site against EPA's Green Book and flags an air-permit risk if on-site gas adds NOx there.",
  },
  aqi: {
    term: "AQI",
    long: "Air Quality Index",
    def: "The EPA's 0–500 scale for today's air: 0–50 is good, above 100 is unhealthy for sensitive groups.",
    summary: "AQI rates air quality on the EPA’s health scale.",
    why: "Shows current conditions near the site. Permits depend on the area's long-term attainment status, not today's AQI.",
  },

  // ---- Grid and siting -----------------------------------------------------
  interconnection: {
    term: "Interconnection",
    def: "Hooking a project up to the utility grid: the new line, the substation and the studies and agreements to get there.",
    summary: "Interconnection connects a project to the utility grid.",
    why: "Griddy prices the line (km × $/km) and a new substation from the 2025 PG&E and SCE unit-cost guides. Grid upgrades beyond that need a utility study.",
  },
  poi: {
    term: "POI",
    long: "Point of interconnection",
    def: "The exact spot, usually a substation or a line, where the project's own line joins the grid.",
    summary: "The point of interconnection is where a project joins the grid.",
    why: "Its voltage sets which line and substation costs Griddy uses.",
    unit: "kV",
  },
  substation: {
    term: "Substation",
    def: "A fenced yard of transformers and switches that changes voltage and links power lines together.",
    summary: "A substation changes voltage and connects power lines.",
    why: "Griddy's substations come from OpenStreetMap, which is volunteer-mapped: many have no voltage tag and some are missing. A new 230 kV substation costs about $22M (2024 dollars).",
  },
  transmission_line: {
    term: "Transmission line",
    def: "High-voltage power lines that carry bulk electricity over long distances. Griddy's map shows lines of 69 kV and up.",
    summary: "Transmission lines carry large amounts of electricity over long distances.",
    why: "Distance to the nearest line drives the cost of the new connection. Griddy measures straight lines, so real routes are longer.",
    unit: "kV, km",
  },
  gen_tie: {
    term: "Gen-tie",
    long: "Generator tie line",
    def: "The private power line that connects a new plant to the grid.",
    summary: "A gen-tie is the private line connecting a plant to the grid.",
    why: "Its cost grows with distance, so far-away sites cost more to hook up.",
    unit: "$",
  },
  interconnection_queue: {
    term: "Interconnection queue",
    def: "The waiting list of projects that have asked to connect to the grid. Griddy shows active requests in the site's county from LBNL's Queued Up data.",
    summary: "The queue lists projects seeking permission to connect to the grid.",
    why: "It is requested capacity, not a forecast: only about 13% of what was requested in 2000–2020 was built. A crowded county can mean longer waits.",
    unit: "MW requested",
  },
  utility_study: {
    term: "Utility study",
    long: "Interconnection study",
    def: "The engineering study a utility (or CAISO, for big projects) runs before a new project may connect: can the wires and substations take it, and what upgrades would they need?",
    summary: "A utility study checks connection feasibility and required grid upgrades.",
    why: "Public maps don't show how much spare capacity the grid has, so Griddy flags every result that only this study can settle.",
  },
  iou: {
    term: "Investor-owned utility",
    long: "IOU",
    def: "A utility owned by shareholders, such as PG&E, SCE or SDG&E. The state's utility commission (CPUC) sets its rates.",
    summary: "An investor-owned utility is a power company owned by shareholders.",
    why: "PG&E, SCE and SDG&E each have a CAISO price zone. Griddy prices a site at its territory's zone, and at PG&E's for any other utility.",
  },
  pou: {
    term: "Publicly owned utility",
    long: "POU",
    def: "A utility run by a city or a public district, such as LADWP, SMUD or IID, instead of a company.",
    summary: "A public utility is run by a city or public district.",
    why: "Several run their own grid area outside CAISO. Griddy still prices their sites at the PG&E load point.",
  },
  utility_territory: {
    term: "Utility territory",
    def: "The area where one utility, such as PG&E, SCE or SDG&E, delivers power to homes and businesses.",
    summary: "A utility territory is the area served by one electricity provider.",
    why: "It decides which utility you'd work with, and Griddy uses it to pick which CAISO price zone the site buys at. Sites outside SCE and SDG&E territory, municipal utilities included, use the PG&E price.",
  },
  balancing_authority: {
    term: "Balancing authority",
    def: "The organization that keeps supply and demand balanced second by second across an area, such as CAISO, LADWP or BANC.",
    summary: "A balancing authority keeps electricity supply and demand in balance.",
    why: "Most of California is in CAISO; a site elsewhere would deal with a different grid operator.",
  },
  caiso: {
    term: "CAISO",
    long: "California Independent System Operator",
    def: "Runs most of California's high-voltage grid and its wholesale power market.",
    summary: "CAISO operates most of California’s transmission grid and wholesale power market.",
    why: "Griddy uses CAISO's 2024 hourly prices, fuel mix and grid CO2 for every simulation.",
  },
  carb: {
    term: "CARB",
    long: "California Air Resources Board",
    def: "California's air and climate regulator.",
    summary: "CARB is California’s air quality and climate regulator.",
    why: "Its reporting rule uses 0.428 t CO2e/MWh for imported power of unknown origin (0.437 with line losses). Griddy offers this as the stricter way to count grid imports.",
    unit: "t CO2e/MWh",
  },
  atb: {
    term: "ATB",
    long: "Annual Technology Baseline",
    def: "A free yearly set of cost and performance numbers for power plants and batteries from NLR (formerly NREL), a US national lab.",
    summary: "ATB provides national estimates of energy technology costs and performance.",
    why: "Griddy uses ATB 2025 (Moderate case, plants online in 2027, no tax credits) for build costs, O&M, heat rates and lifetimes.",
  },
  basemap: {
    term: "Basemap",
    def: "The background map under Griddy's layers: land, water, roads, towns and their names.",
    summary: "The basemap shows geography beneath the energy infrastructure layers.",
    why: "Plants, lines and sites are drawn on top of it. The tiles come from OpenFreeMap (OpenStreetMap data).",
  },
  zoning: {
    term: "Zoning",
    def: "Local rules for what land may be used for: homes, industry, farming, open space and so on.",
    summary: "Zoning sets the permitted uses of land.",
    why: "Griddy can load historical zoning (mostly 2021–23) for a highlighted area. It doesn't prove what's allowed today; check with the city or county.",
  },
  ghi: {
    term: "GHI",
    long: "Global horizontal irradiance",
    def: "How much sunlight lands on flat ground over a day.",
    summary: "GHI measures daily sunlight reaching flat ground.",
    why: "More sun means more solar output. Griddy's site screening counts 5.0 kWh/m²/day or more as a good solar resource (the Central Valley gets about 5.5).",
    unit: "kWh/m²/day",
  },
  capacity_credit: {
    term: "Capacity credit",
    long: "Like ELCC (effective load carrying capability)",
    def: "The share of a plant's MW you can count on during the grid's tightest hours.",
    summary: "Capacity credit estimates dependable power during the grid’s tightest hours.",
    why: "Griddy measures solar and wind from their 2024 output in CAISO's 100 highest net-load hours: a few percent for solar, more for wind. A screening estimate, not a full ELCC study.",
    unit: "% of MW",
  },
  load_region: {
    term: "Load region",
    def: "One of the seven areas whose hourly demand California reports to EIA: the PG&E, SCE and SDG&E parts of CAISO, plus LADWP, BANC, IID and TID.",
    summary: "A load region groups locations with reported hourly electricity demand.",
    why: "The forecast model runs per region, then splits each region's demand into counties by population.",
  },
  p50_p90: {
    term: "P10 / P50 / P90",
    def: "A forecast range. P50 is the middle case (about half of outcomes come in higher), P10 a low case and P90 a high case.",
    summary: "P50 is the middle forecast and P90 is a higher-demand estimate.",
    why: "Griddy's P90 peak is a hot-weather planning case: the 90th percentile, over weather years 2019–2024, of the model's high peak. Plan for it so a heat wave doesn't cause shortfalls. When only the observed 2024 baseline is loaded, P50 = P90.",
    unit: "MW",
  },
  spatial_cv: {
    term: "Spatial cross-validation",
    def: "Testing the siting model on map areas it never trained on (whole 50 km blocks), so look-alike neighbors can't flatter the score.",
    summary: "Spatial validation tests the model on areas excluded from training.",
    why: "It is a fairer test of how the model does in a new place.",
  },
  roc_auc: {
    term: "ROC-AUC",
    def: "A 0-to-1 score for how well a model ranks real plant sites above random land. 0.5 is a coin flip, 1.0 is perfect.",
    summary: "ROC-AUC measures how well a model ranks existing plant sites above random land.",
    why: "Compare technologies with each other: random land is easy to rule out, so scores look high.",
  },
  sci: {
    term: "SCI",
    long: "Software Carbon Intensity",
    def: "The Green Software Foundation's score for software emissions: electricity CO2 plus a share of the hardware's manufacturing, per unit of work.",
    summary: "SCI measures software emissions per unit of work.",
    why: "Griddy reports it per GPU-hour, so you can compare before and after shifting flexible load.",
    unit: "g CO2e/GPU-hour",
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;

export function isGlossaryKey(k: string): k is GlossaryKey {
  return Object.prototype.hasOwnProperty.call(GLOSSARY, k);
}

export function glossaryEntry(k: string): GlossaryEntry | undefined {
  return isGlossaryKey(k) ? GLOSSARY[k] : undefined;
}
