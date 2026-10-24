// The math of one simulated year (workstream B's engine), equation by equation. Every constant here
// is the one in backend/app/simulate/*.py; if a constant changes there, change it here too.
import { Aligned, Code, Equation, Frac, MathBlock, Mi, N, O, P, Sum, SubHeading, T, V } from "./ui";

const hMinus1 = (
  <mrow>
    <mi>h</mi>
    <mo>−</mo>
    <mn>1</mn>
  </mrow>
);
// Piecewise cases: left-aligned, with room between rows so a fraction never touches the next case.
const left = { textAlign: "left" as const, padding: "0.3em 0 0.3em 0.75em" };

export function MathSimulate() {
  return (
    <div className="space-y-4">
      <SubHeading id="math-simulate">1 · Simulating the year, hour by hour</SubHeading>
      <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        The simulator walks through all <strong>8,784 hours of 2024</strong> (a leap year; other weather years drop Feb 29). Hour{" "}
        <Mi>
          <mi>h</mi>
        </Mi>{" "}
        starts at Jan 1 00:00 PST + <Mi><mi>h</mi></Mi> hours, fixed UTC−8 with no daylight saving. Each hour lasts one hour, so a
        power in MW held for that hour is the same number in MWh.
      </p>

      <Equation
        id="eq-demand"
        title="Campus demand each hour"
        code="backend/app/simulate/demand.py"
        used={<>Plan tab (facility peak, load factor) and Build tab (profile, PUE); the first input to every hour.</>}
        where={[
          [<Mi key="d"><V b="D" s="h" /></Mi>, "demand at the meter in hour h, cooling included", "MW"],
          [<Mi key="p"><V b="P" s="peak" /></Mi>, "facility peak you enter (IT load × PUE)", "MW"],
          [<Mi key="lf"><mi>LF</mi></Mi>, "load factor = average ÷ peak", "0–1"],
          [<Mi key="r"><V b="r" s="h" /></Mi>, "raw shape: AI training, AI inference, or the EIA-930 PG&E 2024 community load", "relative"],
          [<Mi key="t"><V b="T" s="h" /></Mi>, "outdoor 2 m temperature at the site (Open-Meteo, 2024)", "°C"],
        ]}
        note={
          <>
            <p>
              The shape is stretched so its maximum is exactly the peak and its average is peak × LF. If clipping at zero lifts the
              average, <Mi><mi>b</mi></Mi> is raised by bisection until the mean is within 0.01% of the target; a load factor the shape
              cannot reach is flagged. For the AI profiles, cooling adds 0.6% of load per °C above 18 °C (about +13% at 40 °C). The flat
              profile is simply peak × LF every hour.
            </p>
          </>
        }
      >
        <MathBlock label="D_h = P_peak times clip of 1 + b (z_h − 1) between 0 and 1">
          <V b="D" s="h" />
          <O>=</O>
          <V b="P" s="peak" />
          <O>·</O>
          <mi>clip</mi>
          <P>
            <N>1</N>
            <O>+</O>
            <mi>b</mi>
            <P>
              <V b="z" s="h" />
              <O>−</O>
              <N>1</N>
            </P>
            <O>,</O>
            <N>0</N>
            <O>,</O>
            <N>1</N>
          </P>
        </MathBlock>
        <MathBlock label="z_h = (r_h − mean r) / (max r − mean r), b = 1 − LF">
          <V b="z" s="h" />
          <O>=</O>
          <Frac
            n={
              <>
                <V b="r" s="h" />
                <O>−</O>
                <mi>mean</mi>
                <P>
                  <mi>r</mi>
                </P>
              </>
            }
            d={
              <>
                <mi>max</mi>
                <P>
                  <mi>r</mi>
                </P>
                <O>−</O>
                <mi>mean</mi>
                <P>
                  <mi>r</mi>
                </P>
              </>
            }
          />
        </MathBlock>
        <MathBlock label="b = 1 − LF">
          <mi>b</mi>
          <O>=</O>
          <N>1</N>
          <O>−</O>
          <mi>LF</mi>
        </MathBlock>
        <MathBlock label="PUE_h = PUE_0 (1 + 0.006 max(T_h − 18, 0))">
          <V b="PUE" s="h" />
          <O>=</O>
          <V b="PUE" s="0" />
          <P>
            <N>1</N>
            <O>+</O>
            <N>0.006</N>
            <O>·</O>
            <mi>max</mi>
            <P>
              <V b="T" s="h" />
              <O>−</O>
              <N>18</N>
              <O>,</O>
              <N>0</N>
            </P>
          </P>
        </MathBlock>
      </Equation>

      <Equation
        id="eq-renewables"
        title="Solar and wind output"
        code={["backend/app/simulate/dispatch.py", "backend/app/simulate/weather.py"]}
        used={<>Simulate tab (dispatch chart), every cost and carbon number downstream.</>}
        where={[
          [<Mi key="g"><V b="G" s="solar,h" /></Mi>, "solar output in hour h, before any curtailment", "MW"],
          [<Mi key="p"><V b="P" s="solar" /></Mi>, "installed solar capacity (AC)", "MW"],
          [<Mi key="cf"><V b="cf" s="h" /></Mi>, "output per MW installed that hour, from real 2024 weather", "0–1"],
          [<Mi key="v"><mi>v</mi></Mi>, "wind speed at 100 m hub height", "m/s"],
        ]}
        note={
          <>
            <p>
              Solar per MW comes from <strong>pvlib</strong>: a single-axis tracker (±60°, backtracking, ground-coverage ratio 0.35,
              albedo 0.2), PVWatts temperature coefficient −0.37%/°C, 14% system losses, DC/AC ratio 1.2 and a 96% inverter, run on
              Open-Meteo&apos;s 2024 hourly irradiance at the site. Wind uses a generic utility turbine curve (cut-in 3, rated 12, cut-out
              25 m/s) with 12% availability, wake and electrical losses. Wind output is the same formula with{" "}
              <Mi><V b="P" s="wind" /></Mi>. Both are must-take: the simulator never turns them down on purpose; surplus is stored,
              exported or curtailed.
            </p>
          </>
        }
      >
        <MathBlock label="G solar h = P solar times clip(cf_h, 0, 1)">
          <V b="G" s="solar,h" />
          <O>=</O>
          <V b="P" s="solar" />
          <O>·</O>
          <mi>clip</mi>
          <P>
            <V b="cf" s="h" />
            <O>,</O>
            <N>0</N>
            <O>,</O>
            <N>1</N>
          </P>
        </MathBlock>
        <MathBlock label="wind capacity factor = (1 − 0.12) f(v)">
          <V b="cf" s="wind" />
          <P>
            <mi>v</mi>
          </P>
          <O>=</O>
          <P>
            <N>1</N>
            <O>−</O>
            <N>0.12</N>
          </P>
          <O>·</O>
          <mi>f</mi>
          <P>
            <mi>v</mi>
          </P>
        </MathBlock>
        <MathBlock label="turbine power curve f(v)">
          <mi>f</mi>
          <P>
            <mi>v</mi>
          </P>
          <O>=</O>
          <mrow>
            <mo>{"{"}</mo>
            <mtable>
              <mtr>
                <mtd style={left}>
                  <mstyle displaystyle="true">
                  <Frac
                    n={
                      <>
                        <V b="v" p="3" />
                        <O>−</O>
                        <V b="3" p="3" />
                      </>
                    }
                    d={
                      <>
                        <V b="12" p="3" />
                        <O>−</O>
                        <V b="3" p="3" />
                      </>
                    }
                  />
                  </mstyle>
                </mtd>
                <mtd style={left}>
                  <N>3</N>
                  <O>≤</O>
                  <mi>v</mi>
                  <O>&lt;</O>
                  <N>12</N>
                </mtd>
              </mtr>
              <mtr>
                <mtd style={left}>
                  <N>1</N>
                </mtd>
                <mtd style={left}>
                  <N>12</N>
                  <O>≤</O>
                  <mi>v</mi>
                  <O>≤</O>
                  <N>25</N>
                </mtd>
              </mtr>
              <mtr>
                <mtd style={left}>
                  <N>0</N>
                </mtd>
                <mtd style={left}>
                  <T>otherwise</T>
                </mtd>
              </mtr>
            </mtable>
          </mrow>
        </MathBlock>
      </Equation>

      <Equation
        id="eq-balance"
        title="Power balance, every hour"
        code={["backend/app/simulate/dispatch.py", "backend/app/simulate/engine.py"]}
        used={<>Simulate tab (dispatch chart and totals); checked for every hour of every preset by <Code>backend/tests/test_contract.py</Code>.</>}
        where={[
          [<Mi key="g"><V b="G" s="k,h" /></Mi>, "generation of kind k (solar, wind, gas CC, gas CT); solar and wind include curtailed output", "MW"],
          [<Mi key="bd"><V b="B" s="h" p="dis" /></Mi>, "battery discharge", "MW"],
          [<Mi key="bc"><V b="B" s="h" p="ch" /></Mi>, "battery charge", "MW"],
          [<Mi key="i"><V b="I" s="h" /></Mi>, "grid imports, at most the import limit", "MW"],
          [<Mi key="x"><V b="X" s="h" /></Mi>, "grid exports, at most the export limit, only when the price is ≥ 0", "MW"],
          [<Mi key="u"><V b="U" s="h" /></Mi>, "unmet (unserved) demand", "MW"],
          [<Mi key="c"><V b="C" s="h" /></Mi>, "curtailed solar and wind (made, then thrown away)", "MW"],
          [<Mi key="l"><V b="λ" s="h" /></Mi>, "CAISO 2024 day-ahead hourly price at your utility's load point (PG&E, SCE or SDG&E DLAP); sites outside SCE and SDG&E territory, municipal utilities included, use the PG&E price", "$/MWh"],
          [<Mi key="a"><mi>a</mi></Mi>, "import delivery adder (transmission access + delivery), default 20", "$/MWh"],
          [<Mi key="hr"><mi>HR</mi></Mi>, "gas heat rate at full load (ATB 2025): CC 6.087, CT 9.717", "MMBtu/MWh"],
        ]}
        note={
          <>
            <p>
              <strong>Dispatch order.</strong> A surplus hour charges the battery, then exports (if the price is not negative), then
              curtails. A deficit hour discharges the battery, then runs firm supply in merit order of this hour&apos;s cost: gas
              combined cycle always before the gas peaker, and imports jump ahead of a gas tier only when strictly cheaper. Whatever is
              still missing is unmet. At the default $3.65/MMBtu gas price, CC costs ≈ $24.3/MWh and CT ≈ $44.2/MWh to run.
            </p>
            <p>
              <strong>Grid charging (on by default when grid-connected).</strong> In a &ldquo;cheap&rdquo; hour, where{" "}
              <Mi>
                <Frac n={<V b="c" s="imp,h" />} d={<mi>RTE</mi>} />
                <O>+</O>
                <N>$5</N>
              </Mi>{" "}
              per MWh is below the value of stored energy over the next 24 h, the battery may also charge from spare import capacity.
              That uses perfect day-ahead foresight (an upper bound), and the year is kept only if it costs no more than the same year
              without grid charging, with unserved energy valued at $1,000/MWh. The year is cyclic: a first pass from 50% charge finds
              the Dec 31 state of charge, and the real pass starts from it.
            </p>
            <p>
              Carbon is not priced on imports because CAISO prices already include California cap-and-trade costs. Results are rounded
              to 0.001 MW, so the balance holds to within a few kW.
            </p>
          </>
        }
      >
        <MathBlock label="Power balance: demand = generation + discharge + imports + unmet − charge − exports − curtailed">
          <Aligned
            rows={[
              [
                <V key="l" b="D" s="h" />,
                <>
                  <O infix>=</O>
                  <Sum under="k" />
                  <V b="G" s="k,h" />
                  <O>+</O>
                  <V b="B" s="h" p="dis" />
                  <O>+</O>
                  <V b="I" s="h" />
                  <O>+</O>
                  <V b="U" s="h" />
                </>,
              ],
              [
                null,
                <>
                  <O infix>−</O>
                  <V b="B" s="h" p="ch" />
                  <O>−</O>
                  <V b="X" s="h" />
                  <O>−</O>
                  <V b="C" s="h" />
                </>,
              ],
            ]}
          />
        </MathBlock>
        <MathBlock label="gas marginal cost">
          <V b="c" s="gas" />
          <O>=</O>
          <mi>HR</mi>
          <O>·</O>
          <V b="p" s="gas" />
          <O>+</O>
          <mi>VOM</mi>
          <O>+</O>
          <V b="p" s="CO₂" />
          <O>·</O>
          <mi>HR</mi>
          <O>·</O>
          <Frac n={<N>53.06</N>} d={<N>1000</N>} />
        </MathBlock>
        <MathBlock label="import cost">
          <V b="c" s="imp,h" />
          <O>=</O>
          <V b="λ" s="h" />
          <O>+</O>
          <mi>a</mi>
        </MathBlock>
      </Equation>

      <Equation
        id="eq-battery"
        title="Battery state of charge, with round-trip efficiency"
        code={["backend/app/simulate/dispatch.py", "backend/app/simulate/engine.py"]}
        used={<>Simulate tab (charge, discharge and state of charge in the dispatch chart; battery cycles), Stress tab (storage duration, grid outage).</>}
        where={[
          [<Mi key="s"><V b="SOC" s="h" /></Mi>, "energy stored at the end of hour h", "MWh"],
          [<Mi key="rte"><mi>RTE</mi></Mi>, "round-trip efficiency, 0.85 (ATB 2025 utility-scale battery)", "0–1"],
          [<Mi key="eta"><mi>η</mi></Mi>, "one-way efficiency; losses split evenly between charging and discharging", "0–1"],
          [<Mi key="pb"><V b="P" s="B" /></Mi>, "battery power rating (charge and discharge limit)", "MW"],
          [<Mi key="d"><mi>d</mi></Mi>, "duration, default 4 h", "h"],
          [<Mi key="e"><mi>E</mi></Mi>, "energy capacity", "MWh"],
        ]}
        note={
          <>
            <p>
              A surplus hour only charges and a deficit hour only discharges, so the battery never does both at once. It charges from
              on-site solar and wind surplus (and, with grid charging, spare imports), never from gas. Battery cycles per year ={" "}
              <Mi>
                <Sum under="h" />
                <V b="B" s="h" p="dis" />
                <O>/</O>
                <mi>E</mi>
              </Mi>
              .
            </p>
          </>
        }
      >
        <MathBlock label="SOC_h = SOC_(h−1) + eta B_ch − B_dis / eta">
          <V b="SOC" s="h" />
          <O>=</O>
          <V b="SOC" s={hMinus1} />
          <O>+</O>
          <mi>η</mi>
          <V b="B" s="h" p="ch" />
          <O>−</O>
          <Frac n={<V b="B" s="h" p="dis" />} d={<mi>η</mi>} />
        </MathBlock>
        <MathBlock label="eta = square root of RTE">
          <mi>η</mi>
          <O>=</O>
          <msqrt>
            <mi>RTE</mi>
          </msqrt>
          <O>=</O>
          <msqrt>
            <N>0.85</N>
          </msqrt>
          <O>≈</O>
          <N>0.922</N>
        </MathBlock>
        <MathBlock label="limits">
          <N>0</N>
          <O>≤</O>
          <V b="SOC" s="h" />
          <O>≤</O>
          <mi>E</mi>
          <O>=</O>
          <V b="P" s="B" />
          <O>·</O>
          <mi>d</mi>
        </MathBlock>
        <MathBlock label="charge and discharge limits">
          <V b="B" s="h" p="ch" />
          <O>≤</O>
          <mi>min</mi>
          <P>
            <V b="P" s="B" />
            <O>,</O>
            <Frac
              n={
                <>
                  <mi>E</mi>
                  <O>−</O>
                  <V b="SOC" s={hMinus1} />
                </>
              }
              d={<mi>η</mi>}
            />
          </P>
        </MathBlock>
        <MathBlock label="discharge limit">
          <V b="B" s="h" p="dis" />
          <O>≤</O>
          <mi>min</mi>
          <P>
            <V b="P" s="B" />
            <O>,</O>
            <mi>η</mi>
            <V b="SOC" s={hMinus1} />
          </P>
        </MathBlock>
      </Equation>

      <Equation
        id="eq-cf"
        title="Capacity factor and curtailment"
        code="backend/app/simulate/engine.py"
        used={<>Simulate tab; the site recommender&apos;s sizing (annual solar and wind capacity factors from the same 2024 profiles).</>}
        where={[
          [<Mi key="cf"><V b="CF" s="k" /></Mi>, "capacity factor of kind k: average output ÷ nameplate", "0–1"],
          [<Mi key="p"><V b="P" s="k" /></Mi>, "installed capacity of kind k", "MW"],
          [<Mi key="h"><mi>H</mi></Mi>, "hours in the year (8,784 in 2024)", "h"],
        ]}
        note={
          <p>
            Generation counts curtailed output, so CF says what the weather allowed, not what was used; the curtailment share says how
            much was thrown away. ATB&apos;s reference CFs (PV 0.3085, wind 0.4481) are shown for comparison only: the simulation uses
            the site&apos;s hourly weather.
          </p>
        }
      >
        <MathBlock label="CF_k = sum G / (P_k H)">
          <V b="CF" s="k" />
          <O>=</O>
          <Frac
            n={
              <>
                <Sum under="h" />
                <V b="G" s="k,h" />
              </>
            }
            d={
              <>
                <V b="P" s="k" />
                <O>·</O>
                <mi>H</mi>
              </>
            }
          />
        </MathBlock>
        <MathBlock label="curtailment share">
          <mtext>curtailment share</mtext>
          <O>=</O>
          <Frac
            n={
              <>
                <Sum under="h" />
                <V b="C" s="h" />
              </>
            }
            d={
              <>
                <Sum under="h" />
                <P>
                  <V b="G" s="solar,h" />
                  <O>+</O>
                  <V b="G" s="wind,h" />
                </P>
              </>
            }
          />
        </MathBlock>
      </Equation>

      <Equation
        id="eq-firm"
        title="Firm capacity margin (stress test)"
        code="backend/app/simulate/stress.py"
        used={<>Stress tab, &ldquo;Firm capacity&rdquo; finding (pass at ≥ 15% margin, warn below, fail below 0%).</>}
        where={[
          [<Mi key="f"><mi>Firm</mi></Mi>, "capacity you can count on at the peak", "MW"],
          [<Mi key="cb"><V b="c" s="B" /></Mi>, "battery credit = min(0.9, duration ÷ the typical daily deficit, at least 4 h)", "0–0.9"],
          [<Mi key="cs"><V b="c" s="solar" /></Mi>, "solar (or wind) credit: its average output in the year's 100 highest net-load hours", "0–1"],
          [<Mi key="i"><V b="I" s="max" /></Mi>, "grid import limit", "MW"],
        ]}
        note={
          <p>
            Gas is derated by approximate NERC GADS forced-outage rates (5% CC, 8% CT). The 15% target is in line with the CPUC
            planning reserve margin (~15–17%). This is a screening proxy, not an ELCC or resource-adequacy study. The other stress tests
            rerun the hottest July week (+2 °C, gas derated 0.4–0.6%/°C) and the tightest week without the largest gas unit (400 MW CC /
            100 MW CT blocks), check the year&apos;s lowest 72 h of solar + wind, and dispatch critical load through a full grid outage.
          </p>
        }
      >
        <MathBlock label="Firm capacity">
          <Aligned
            rows={[
              [
                <mi key="l">Firm</mi>,
                <>
                  <O infix>=</O>
                  <N>0.95</N>
                  <V b="P" s="CC" />
                  <O>+</O>
                  <N>0.92</N>
                  <V b="P" s="CT" />
                  <O>+</O>
                  <V b="c" s="B" />
                  <V b="P" s="B" />
                </>,
              ],
              [
                null,
                <>
                  <O infix>+</O>
                  <V b="c" s="solar" />
                  <V b="P" s="solar" />
                  <O>+</O>
                  <V b="c" s="wind" />
                  <V b="P" s="wind" />
                  <O>+</O>
                  <V b="I" s="max" />
                </>,
              ],
            ]}
          />
        </MathBlock>
        <MathBlock label="margin">
          <mtext>margin</mtext>
          <O>=</O>
          <Frac n={<mi>Firm</mi>} d={<V b="D" s="peak" />} />
          <O>−</O>
          <N>1</N>
          <O>≥</O>
          <N>15%</N>
        </MathBlock>
      </Equation>
    </div>
  );
}
