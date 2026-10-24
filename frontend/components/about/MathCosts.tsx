// Costs: CAPEX, operating cost, fuel, annuity/CRF, NPC with replacements and salvage, LCOE.
// Mirrors backend/app/evaluate/{economics,finance,catalog}.py and data/evaluate/README.md.
import type { ReactNode } from "react";

import { Aligned, Code, Equation, Ext, Frac, MathBlock, Mi, N, O, P, Sum, SubHeading, V } from "./ui";

const onePlusR = (
  <P>
    <N>1</N>
    <O>+</O>
    <mi>r</mi>
  </P>
);

/** (1+r)^x */
function Pow({ x }: { x: ReactNode }) {
  return (
    <msup>
      {onePlusR}
      <mrow>{x}</mrow>
    </msup>
  );
}

// 2024 USD, ATB 2025 v1.0.0 Moderate, 2027 COD, no tax credits, net of ATB's generic grid-connection cost.
const CATALOG: [tech: string, capex: string, fom: string, life: string][] = [
  ["Solar PV (single-axis tracking)", "$1,235.48 /kWac", "$23.30 /kW-yr", "30 yr"],
  ["Onshore wind", "$1,714.67 /kW", "$39.61 /kW-yr", "30 yr"],
  ["Gas combined cycle (H-frame 2-on-1)", "$1,263.55 /kW", "$30.78 /kW-yr + $2.04 /MWh", "30 yr"],
  ["Gas combustion turbine (F-frame)", "$1,234.71 /kW", "$27.18 /kW-yr + $8.75 /MWh", "30 yr"],
  ["Battery (Li-ion)", "$370.86 /kW + $218.15 /kWh", "$14.35 /kW-yr + $8.44 /kWh-yr", "15 yr"],
  ["New line + substation", "230 kV: $2.43M /km + $22.4M", "—", "47 yr"],
];

export function MathCosts() {
  return (
    <div className="space-y-4">
      <SubHeading id="math-costs">2 · Turning the year into money</SubHeading>
      <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        All dollars are <strong>real 2024 US dollars</strong> and the discount rate is real. The campus owner builds and owns every
        on-site asset and the new interconnection, pays O&amp;M and fuel, and buys grid imports. Owned generation is never also counted
        as purchased power, exports earn nothing by default, and there are <strong>no tax credits</strong>.
      </p>

      <Equation
        id="eq-capex"
        title="Up-front cost (CAPEX) and yearly operating cost (OPEX)"
        code={["backend/app/evaluate/economics.py", "backend/app/evaluate/catalog.py"]}
        used={<>Costs tab (cost lines, waterfall), Summary, Report.</>}
        where={[
          [<Mi key="k"><V b="K" s="i" /></Mi>, "CAPEX of asset i, paid in year 0", "$"],
          [<Mi key="pi"><V b="P" s="i" /></Mi>, "capacity of asset i (AC for solar)", "MW"],
          [<Mi key="ck"><V b="c" s="i" p="kW" /></Mi>, "catalog cost per kW of capacity, table below", "$/kW"],
          [<Mi key="ckwh"><V b="c" p="kWh" /></Mi>, "battery cost per kWh of storage; d is its duration in hours (default 4)", "$/kWh"],
          [<Mi key="o"><mi>O</mi></Mi>, "operating cost of the simulated year, repeated in years 1…N", "$/yr"],
          [<Mi key="fom"><mi>FOM</mi></Mi>, "fixed O&M per kW-year (battery: per kW plus per kWh)", "$/yr"],
          [<Mi key="vom"><mi>VOM</mi></Mi>, "variable O&M × simulated MWh (gas only; zero for PV, wind, battery in ATB)", "$/yr"],
          [<Mi key="phi"><mi>φ</mi></Mi>, "share of the hourly price paid for exports, default 0", "0–1"],
          [<Mi key="pc"><V b="p" s="CO₂" /></Mi>, "carbon price, default $0/t, applied to on-site combustion CO₂ only", "$/t"],
        ]}
        note={
          <>
            <p>
              Costs come from <Ext href="https://atb.nlr.gov/electricity/2025/data">NLR (formerly NREL) ATB 2025 v1.0.0</Ext>,
              Moderate scenario, 2027 online date, no tax credits, converted from 2023$ with the BLS CPI-U deflator{" "}
              <strong>1.029494</strong>. ATB&apos;s CAPEX includes a generic grid-connection cost (GCC); Griddy removes it, using{" "}
              <Code>OCC + CFC × OCC/(OCC + GCC)</Code>, because it prices each site&apos;s own line and substation from the CAISO
              participating-utility 2025 unit cost guides (flat rural terrain, 35% line contingency included; 2025$ × 0.974362). POI ≥ 345
              kV uses the 500 kV tier, ≤ 161 kV the 115 kV tier, anything else 230 kV.
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Catalog defaults, 2024$ (per-asset overrides are allowed):</p>
            {/* Phones get a stacked list; a four-column table would not fit in 360 px. */}
            <ul className="space-y-1.5 text-xs sm:hidden">
              {CATALOG.map(([tech, capex, fom, life]) => (
                <li key={tech} className="border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
                  <p className="font-medium">
                    {tech} <span className="font-normal text-zinc-500 dark:text-zinc-400">· {life}</span>
                  </p>
                  <p className="tabular-nums">
                    {capex}
                    {fom !== "—" && <span className="text-zinc-500 dark:text-zinc-400"> · O&amp;M {fom}</span>}
                  </p>
                </li>
              ))}
            </ul>
            <div className="hidden sm:block">
              <table className="w-full text-left text-xs">
                <thead className="text-zinc-500 dark:text-zinc-400">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Asset</th>
                    <th className="py-1 pr-2 font-medium">CAPEX</th>
                    <th className="py-1 pr-2 font-medium">O&amp;M</th>
                    <th className="py-1 font-medium">Life</th>
                  </tr>
                </thead>
                <tbody>
                  {CATALOG.map(([tech, capex, fom, life]) => (
                    <tr key={tech} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                      <td className="py-1 pr-2">{tech}</td>
                      <td className="py-1 pr-2 tabular-nums">{capex}</td>
                      <td className="py-1 pr-2 tabular-nums">{fom}</td>
                      <td className="py-1 tabular-nums">{life}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Lifetimes: ATB 2025 Definitions, &ldquo;Technical Lifetimes for Technologies&rdquo;. Interconnection: PG&amp;E 2027 rate case
              depreciation study, station equipment 47-R2 survivor curve (the shortest major component, so the least salvage credit).
            </p>
          </>
        }
      >
        <MathBlock label="CAPEX = 1000 x MW x dollars per kW">
          <V b="K" s="i" />
          <O>=</O>
          <N>1000</N>
          <O>·</O>
          <V b="P" s="i" />
          <O>·</O>
          <V b="c" s="i" p="kW" />
        </MathBlock>
        <MathBlock label="battery CAPEX = 1000 x MW x (dollars per kW + hours x dollars per kWh)">
          <V b="K" s="battery" />
          <O>=</O>
          <N>1000</N>
          <O>·</O>
          <V b="P" s="B" />
          <O>·</O>
          <P>
            <V b="c" p="kW" />
            <O>+</O>
            <mi>d</mi>
            <O>·</O>
            <V b="c" p="kWh" />
          </P>
        </MathBlock>
        <MathBlock label="OPEX = fixed O&M + variable O&M + fuel + purchased power + carbon − export credit">
          <Aligned
            rows={[
              [
                <mi key="l">O</mi>,
                <>
                  <O infix>=</O>
                  <mi>FOM</mi>
                  <O>+</O>
                  <mi>VOM</mi>
                  <O>+</O>
                  <mi>Fuel</mi>
                  <O>+</O>
                  <Sum under="h" />
                  <V b="I" s="h" />
                  <P>
                    <V b="λ" s="h" />
                    <O>+</O>
                    <mi>a</mi>
                  </P>
                </>,
              ],
              [
                null,
                <>
                  <O infix>+</O>
                  <V b="p" s="CO₂" />
                  <V b="E" s="direct" />
                  <O>−</O>
                  <mi>φ</mi>
                  <Sum under="h" />
                  <V b="X" s="h" />
                  <V b="λ" s="h" />
                </>,
              ],
            ]}
          />
        </MathBlock>
      </Equation>

      <Equation
        id="eq-fuel"
        title="Fuel: MWh × heat rate × gas price"
        code="backend/app/evaluate/economics.py"
        used={<>Costs tab (&ldquo;Natural gas&rdquo; lines), and the gas burn every emission number starts from.</>}
        where={[
          [<Mi key="q"><V b="Q" s="k" /></Mi>, "gas burned by kind k (CC or CT)", "MMBtu/yr"],
          [<Mi key="hr"><V b="HR" s="k" /></Mi>, "full-load heat rate: CC 6.087, CT 9.717 (ATB 2025)", "MMBtu/MWh"],
          [<Mi key="p"><V b="p" s="h" /></Mi>, "gas price in hour h", "$/MMBtu"],
          [<Mi key="pbar"><mover accent="true"><mi>p</mi><mo>¯</mo></mover></Mi>, "your annual-average gas price, default $3.65 (EIA 2024 California citygate, $3.79/Mcf ÷ 1.038)", "$/MMBtu"],
          [<Mi key="m"><V b="m" s="month(h)" /></Mi>, "2024 PG&E Citygate monthly price, used only as a shape (normalized to mean 1)", "$/MMBtu"],
        ]}
        note={
          <p>
            <strong>No part-load penalty:</strong> the code uses ATB&apos;s full-load heat rate at every output level, so a gas unit
            idling at low output burns the same MMBtu per MWh as at full load (real units burn more). The monthly shape (Jan $6.07 … Jun
            $2.14 … Dec $3.39, read from CAISO DMM&apos;s 2024 Annual Report, Fig. 2.7) applies only with weather year 2024, so gas and
            power prices come from the same year; the price you enter stays the authoritative annual average. Dispatch ranks gas by that
            annual average.
          </p>
        }
      >
        <MathBlock label="Gas burn and fuel cost">
          <V b="Q" s="k" />
          <O>=</O>
          <V b="HR" s="k" />
          <Sum under="h" />
          <V b="G" s="k,h" />
        </MathBlock>
        <MathBlock label="fuel cost">
          <mi>Fuel</mi>
          <O>=</O>
          <Sum under="k" />
          <V b="HR" s="k" />
          <Sum under="h" />
          <V b="G" s="k,h" />
          <V b="p" s="h" />
        </MathBlock>
        <MathBlock label="hourly gas price">
          <V b="p" s="h" />
          <O>=</O>
          <mover accent="true">
            <mi>p</mi>
            <mo>¯</mo>
          </mover>
          <O>·</O>
          <Frac
            n={<V b="m" s="month(h)" />}
            d={
              <>
                <mi>mean</mi>
                <P>
                  <mi>m</mi>
                </P>
              </>
            }
          />
        </MathBlock>
      </Equation>

      <Equation
        id="eq-crf"
        title="Annuity factor and capital recovery factor (CRF)"
        code="backend/app/evaluate/finance.py"
        used={<>Costs tab: present value of 20 years of OPEX, and the CRF cross-check on LCOE.</>}
        where={[
          [<Mi key="r"><mi>r</mi></Mi>, "real discount rate, default 7%", "/yr"],
          [<Mi key="n"><mi>N</mi></Mi>, "analysis horizon, default 20 years", "yr"],
          [<Mi key="l"><mi>L</mi></Mi>, "an asset's lifetime", "yr"],
        ]}
        note={
          <p>
            AF is what $1 a year for N years is worth today. CRF is the reverse: the level yearly payment that repays $1 of CAPEX over L
            years. At r = 7%: AF(7%, 20) = <strong>10.594</strong>, CRF(7%, 30) = 0.0806, CRF(7%, 15) = 0.1098.
          </p>
        }
      >
        <MathBlock label="annuity factor and CRF">
          <mi>AF</mi>
          <P>
            <mi>r</mi>
            <O>,</O>
            <mi>N</mi>
          </P>
          <O>=</O>
          <Frac
            n={
              <>
                <N>1</N>
                <O>−</O>
                <Pow
                  x={
                    <>
                      <O>−</O>
                      <mi>N</mi>
                    </>
                  }
                />
              </>
            }
            d={<mi>r</mi>}
          />
        </MathBlock>
        <MathBlock label="capital recovery factor">
          <mi>CRF</mi>
          <P>
            <mi>r</mi>
            <O>,</O>
            <mi>L</mi>
          </P>
          <O>=</O>
          <Frac
            n={
              <>
                <mi>r</mi>
                <Pow x={<mi>L</mi>} />
              </>
            }
            d={
              <>
                <Pow x={<mi>L</mi>} />
                <O>−</O>
                <N>1</N>
              </>
            }
          />
          <O>=</O>
          <Frac n={<N>1</N>} d={<><mi>AF</mi><P><mi>r</mi><O>,</O><mi>L</mi></P></>} />
        </MathBlock>
      </Equation>

      <Equation
        id="eq-npc"
        title="Net present cost (NPC), with replacements and salvage"
        code="backend/app/evaluate/finance.py"
        used={<>Costs tab (NPC headline, year-by-year cash flows, NPC breakdown), Compare view, Report.</>}
        where={[
          [<Mi key="f"><V b="F" s="t" /></Mi>, "net cash flow in year t (t = 0 … N)", "$"],
          [<Mi key="rho"><V b="ρ" s="i" /></Mi>, "replacement cost ratio: ATB Moderate projected CAPEX in 2027 + t ÷ CAPEX in 2027", "×"],
          [<Mi key="tl"><V b="t" s="i" p="last" /></Mi>, "year of asset i's last installation: the largest k·L < N (0 if it outlives the horizon)", "yr"],
          [<Mi key="s"><V b="S" s="i" /></Mi>, "salvage credit for the life left at year N (straight-line)", "$"],
          [<Mi key="ib"><mo>[</mo><mi>t</mi><mo>=</mo><mi>N</mi><mo>]</mo></Mi>, "1 in the final year, 0 otherwise"],
        ]}
        note={
          <>
            <p>
              Year 0 holds all CAPEX; years 1 … N repeat the simulated year&apos;s OPEX; an asset with life L is re-bought in every
              year k·L &lt; N; in year N the unused life of the last installation is credited back. At N = 20: 30-year solar, wind and gas
              get 1/3 back; a 15-year battery is replaced in year 15 at <strong>0.708×</strong> its 2027 cost (ATB Moderate, 2042 ÷
              2027) and gets 2/3 of that back; the 47-year interconnection gets 27/47 back.
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Worked example from <Code>data/evaluate/README.md</Code>: a 300 MW / 1,200 MWh battery costs $373.0M in year 0; its year-15
              replacement is $264.2M (present value $95.7M) and its year-20 salvage $176.1M (present value −$45.5M).
            </p>
          </>
        }
      >
        <MathBlock label="NPC = sum of discounted cash flows">
          <mi>NPC</mi>
          <O>=</O>
          <Sum under="t=0" over="N" />
          <Frac n={<V b="F" s="t" />} d={<Pow x={<mi>t</mi>} />} />
        </MathBlock>
        <MathBlock label="year 0 cash flow">
          <V b="F" s="0" />
          <O>=</O>
          <Sum under="i" />
          <V b="K" s="i" />
        </MathBlock>
        <MathBlock label="cash flow in years 1 to N">
          <V b="F" s="t" />
          <O>=</O>
          <mi>O</mi>
          <O>+</O>
          <Sum under={<><mi>i</mi><mo>:</mo><mi>t</mi><mo>=</mo><mi>k</mi><msub><mi>L</mi><mi>i</mi></msub><mo>&lt;</mo><mi>N</mi></>} />
          <V b="K" s="i" />
          <V b="ρ" s="i" />
          <P>
            <mi>t</mi>
          </P>
          <O>−</O>
          <P open="[" close="]">
            <mi>t</mi>
            <O>=</O>
            <mi>N</mi>
          </P>
          <Sum under="i" />
          <V b="S" s="i" />
        </MathBlock>
        <MathBlock label="salvage">
          <V b="S" s="i" />
          <O>=</O>
          <V b="K" s="i" />
          <V b="ρ" s="i" />
          <P>
            <V b="t" s="i" p="last" />
          </P>
          <O>·</O>
          <Frac
            n={
              <>
                <V b="t" s="i" p="last" />
                <O>+</O>
                <V b="L" s="i" />
                <O>−</O>
                <mi>N</mi>
              </>
            }
            d={<V b="L" s="i" />}
          />
        </MathBlock>
      </Equation>

      <Equation
        id="eq-lcoe"
        title="Levelized cost of energy (LCOE) = NPC ÷ discounted MWh"
        code="backend/app/evaluate/finance.py"
        used={<>Summary and Costs tab headline, Compare view, Report.</>}
        where={[
          [<Mi key="e"><V b="E" s="served" /></Mi>, "energy actually delivered to the campus each year = demand − unmet", "MWh/yr"],
          [<Mi key="lc"><V b="LCOE" s="CRF" /></Mi>, "cross-check: each CAPEX spread over its own life with CRF", "$/MWh"],
        ]}
        note={
          <p>
            Discounting the MWh as well as the dollars is what makes LCOE a fair &ldquo;price per MWh&rdquo; over the project&apos;s life.
            Unmet energy is not counted as served, so a design that leaves load unserved does not look cheaper per MWh.
          </p>
        }
      >
        <MathBlock label="LCOE">
          <mi>LCOE</mi>
          <O>=</O>
          <Frac
            n={<mi>NPC</mi>}
            d={
              <>
                <Sum under="t=1" over="N" />
                <Frac n={<V b="E" s="served" />} d={<Pow x={<mi>t</mi>} />} />
              </>
            }
          />
        </MathBlock>
        <MathBlock label="LCOE = NPC / (served MWh x annuity factor)">
          <mi>LCOE</mi>
          <O>=</O>
          <Frac
            n={<mi>NPC</mi>}
            d={
              <>
                <V b="E" s="served" />
                <O>·</O>
                <mi>AF</mi>
                <P>
                  <mi>r</mi>
                  <O>,</O>
                  <mi>N</mi>
                </P>
              </>
            }
          />
        </MathBlock>
        <MathBlock label="served energy = demand − unmet">
          <V b="E" s="served" />
          <O>=</O>
          <Sum under="h" />
          <P>
            <V b="D" s="h" />
            <O>−</O>
            <V b="U" s="h" />
          </P>
        </MathBlock>
        <MathBlock label="CRF cross-check">
          <V b="LCOE" s="CRF" />
          <O>=</O>
          <Frac
            n={
              <>
                <Sum under="i" />
                <V b="K" s="i" />
                <mi>CRF</mi>
                <P>
                  <mi>r</mi>
                  <O>,</O>
                  <V b="L" s="i" />
                </P>
                <O>+</O>
                <mi>O</mi>
              </>
            }
            d={<V b="E" s="served" />}
          />
        </MathBlock>
      </Equation>
    </div>
  );
}
