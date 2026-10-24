// Phase 2: the demand forecast (ml/demand_forecast + backend/app/forecast) and where to build
// (ml/site_location + backend/app/sites). States plainly which mode the committed artifacts run in.
import type { ReactNode } from "react";

import { Aligned, Code, Equation, Frac, MathBlock, Mi, N, O, P, Sum, SubHeading, T, V } from "./ui";

const alpha = (
  <mrow>
    <mo>(</mo>
    <mi>α</mi>
    <mo>)</mo>
  </mrow>
);
const Lbar = (
  <mover accent="true">
    <mi>L</mi>
    <mo>¯</mo>
  </mover>
);
const dP = (
  <mrow>
    <mi mathvariant="normal">Δ</mi>
    <mi>P</mi>
  </mrow>
);
const dE = (
  <mrow>
    <mi mathvariant="normal">Δ</mi>
    <mi>E</mi>
  </mrow>
);

const exp = (d: string, scale: string) => (
  <>
    <msup>
      <mi>e</mi>
      <mrow>
        <mo>−</mo>
        <msub>
          <mi>d</mi>
          <mi>{d}</mi>
        </msub>
        <mo>/</mo>
        <mn>{scale}</mn>
      </mrow>
    </msup>
  </>
);

function Clip({ children }: { children: ReactNode }) {
  return (
    <>
      <mi>clip</mi>
      <P>
        {children}
        <O>,</O>
        <N>0</N>
        <O>,</O>
        <N>1</N>
      </P>
    </>
  );
}

export function MathForecast() {
  return (
    <div className="space-y-4">
      <SubHeading id="math-forecast">4 · Demand forecast and where to build</SubHeading>
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <strong>Which models are live.</strong> The trained ones. The forecast is the XGBoost model below (API mode <Code>ml</Code>; on
        held-out test data its P50 misses hourly load by 8.7% on average (given the year&apos;s mean load), against 11.2% for a climatology baseline, and its P10–P90
        band held 50% of hours against a nominal 80%, so read P10 and P90 as a planning range, not calibrated odds). Site suitability is
        the trained classifier (mode <Code>model</Code>; spatial cross-validation ROC-AUC 0.92–0.96 by technology). Each has a
        fallback for when no trained artifact has been exported: the <em>observed 2024 baseline</em> (mode{" "}
        <Code>scenario_on_observed</Code>: the same scenario formulas, with 2024&apos;s observed peak-to-mean ratio in every year, so
        P50 = P90) and the documented <em>screening score</em> <Code>heuristic-v1</Code> (mode <Code>heuristic</Code>, shown below).
        The API&apos;s <Code>mode</Code> field always says which one answered.
      </div>

      <Equation
        id="eq-forecast-model"
        title="Hourly demand shape: XGBoost quantile model (P10 / P50 / P90)"
        code={["ml/demand_forecast/train.py", "ml/demand_forecast/dataset.py", "ml/demand_forecast/export.py"]}
        used={<>Forecast drawer (peak demand by region and county, P50 and P90).</>}
        where={[
          [<Mi key="y"><V b="y" s="r,h" /></Mi>, "load in region r, hour h ÷ that region-year's mean load (the shape, not the level)", "ratio"],
          [<Mi key="yh"><V b="ŷ" p={alpha} /></Mi>, "the model's α-quantile prediction, α ∈ {0.1, 0.5, 0.9}", "ratio"],
          [<Mi key="x"><V b="x" s="r,h" /></Mi>, "23 features: region, hour, weekday, weekend, holiday, month, day-of-year (sin, cos), trend year, temperature (now, 1 h and 3 h lags, 24 h mean and max, 72 h mean), cooling and heating degree-days, humidity, dew point, solar radiation (rooftop PV), wind", ""],
          [<Mi key="rho"><V b="ρ" s="r" p="50" /></Mi>, "peak ÷ mean ratio for the year: median over replayed weather years of the P50 annual peak (ρ⁹⁰: 90th percentile of the P90 peaks)", "ratio"],
        ]}
        note={
          <>
            <p>
              One booster covers the seven EIA-930 load regions (PG&amp;E, SCE and SDG&amp;E areas of CAISO, plus LADWP, BANC, IID and
              TID) on hourly load from 2019 on and Open-Meteo weather at up to six population-weighted points per region. It is split by
              time, never at random: train through 2023, early-stop on 2024 (max depth 8, learning rate 0.05, up to 4,000 rounds),
              and report accuracy on <strong>2025–2026, which it never sees</strong>: MAPE, monthly-peak error and P10–P90 coverage,
              next to a naive climatology baseline. Quantiles are sorted so they never cross.
            </p>
          </>
        }
      >
        <MathBlock label="quantile prediction">
          <V b="ŷ" s="r,h" p={alpha} />
          <O>=</O>
          <V b="f" s="α" />
          <P>
            <V b="x" s="r,h" />
          </P>
        </MathBlock>
        <MathBlock label="pinball (quantile) loss">
          <V b="ℓ" s="α" />
          <P>
            <mi>y</mi>
            <O>,</O>
            <mi>ŷ</mi>
          </P>
          <O>=</O>
          <mi>max</mi>
          <P>
            <mi>α</mi>
            <P>
              <mi>y</mi>
              <O>−</O>
              <mi>ŷ</mi>
            </P>
            <O>,</O>
            <P>
              <mi>α</mi>
              <O>−</O>
              <N>1</N>
            </P>
            <P>
              <mi>y</mi>
              <O>−</O>
              <mi>ŷ</mi>
            </P>
          </P>
        </MathBlock>
      </Equation>

      <Equation
        id="eq-forecast-growth"
        title="Scenario growth to 2030 / 2035 / 2040"
        code={["ml/demand_forecast/scenarios.py", "backend/app/forecast/service.py"]}
        used={<>Forecast drawer: scenario presets, target year and what-if sliders (recomputed in milliseconds, no model run).</>}
        where={[
          [<Mi key="ec"><V b="E" s="c" /></Mi>, "annual energy of county c (EIA-930 regional load split by 2020 Census population)", "MWh"],
          [<Mi key="pi"><V b="π" s="c" /></Mi>, "CA Department of Finance P-2A projected population ratio for the county, year y ÷ 2024", "×"],
          [<Mi key="el"><mi>e</mi><O>,</O><mi>η</mi></Mi>, "per-capita electrification growth and efficiency offset", "/yr"],
          [<Mi key="l"><V b={Lbar} s="r" /></Mi>, "region mean load in year y", "MW"],
          [<Mi key="dc"><V b="DC" s="r" /></Mi>, "new data-center peak added in the region's counties", "MW"],
          [<Mi key="lf"><V b="LF" s="dc" /></Mi>, "data-center load factor, default 0.9", "0–1"],
          [<Mi key="fl"><mi>φ</mi></Mi>, "flexible (carbon-aware) share of that load: adds energy, assumed off the peak hour", "0–1"],
          [<Mi key="p50"><V b="P" s="r" p="50" /></Mi>, "the median peak: the same formula with the P50 ratio", "MW"],
        ]}
        note={
          <p>
            Presets (<Code>ml/demand_forecast/scenarios.json</Code>): <strong>low</strong> electrification 0.8%/yr, efficiency 0.7%/yr,
            no new data centers; <strong>mid</strong> 1.5%/yr and 0.7%/yr, a 1 GW AI campus in Kern and 500 MW in Santa Clara, 10%
            flexible; <strong>high</strong> 2.5%/yr and 0.5%/yr with 4 GW of data centers in Kern, Santa Clara, Fresno and Imperial.
            Growth is a scenario, not a prediction: the model learns weather and calendar response, not future EV or heat-pump adoption.
          </p>
        }
      >
        <MathBlock label="county energy growth">
          <Aligned
            rows={[
              [
                <mrow key="l">
                  <V b="E" s="c" />
                  <P><mi>y</mi></P>
                </mrow>,
                <>
                  <O infix>=</O>
                  <V b="E" s="c" />
                  <P>
                    <N>2024</N>
                  </P>
                  <O>·</O>
                  <V b="π" s="c" />
                  <P><mi>y</mi></P>
                </>,
              ],
              [
                null,
                <>
                  <O infix>·</O>
                  <msup>
                    <P>
                      <N>1</N>
                      <O>+</O>
                      <mi>e</mi>
                      <O>−</O>
                      <mi>η</mi>
                    </P>
                    <mrow>
                      <mi>y</mi>
                      <mo>−</mo>
                      <mn>2024</mn>
                    </mrow>
                  </msup>
                </>,
              ],
            ]}
          />
        </MathBlock>
        <MathBlock label="region P90 peak; P50 uses the P50 ratio">
          <Aligned
            rows={[
              [
                <mrow key="l">
                  <V b="P" s="r" p="90" />
                  <P><mi>y</mi></P>
                </mrow>,
                <>
                  <O infix>=</O>
                  <V b={Lbar} s="r" />
                  <P><mi>y</mi></P>
                  <O>·</O>
                  <V b="ρ" s="r" p="90" />
                  <P><mi>y</mi></P>
                </>,
              ],
              [
                null,
                <>
                  <O infix>+</O>
                  <V b="DC" s="r" />
                  <O>·</O>
                  <V b="LF" s="dc" />
                  <O>·</O>
                  <P>
                    <N>1</N>
                    <O>−</O>
                    <mi>φ</mi>
                  </P>
                </>,
              ],
            ]}
          />
        </MathBlock>
      </Equation>

      <Equation
        id="eq-suitability"
        title="Site suitability for each technology"
        code={["ml/site_location/train.py", "ml/site_location/export_sites.py"]}
        used={<>Forecast drawer → Sites (recommended sites on the map, &ldquo;Use this site&rdquo;).</>}
        where={[
          [<Mi key="p"><V b="p" s="i,k" /></Mi>, "suitability of 5 km cell i (about 15,000 scored cells over California) for technology k", "0–1"],
          [<Mi key="dl"><V b="d" s="line" /></Mi>, "distance to the nearest operating ≥ 220 kV line (straight line)", "km"],
          [<Mi key="ds"><V b="d" s="sub" /></Mi>, "distance to the nearest ≥ 220 kV substation", "km"],
          [<Mi key="ghi"><mi>GHI</mi><O>,</O><V b="v" s="100" /></Mi>, "ERA5 2024 mean solar irradiance (kWh/m²/day) and 100 m wind (m/s)", ""],
          [<Mi key="c"><mi>crowd</mi></Mi>, "clip(ln(1 + people within 10 km) ÷ 12, 0, 1)", "0–1"],
          [<Mi key="dem"><mi>dem</mi></Mi>, "ln(1 + demand within 150 km), rescaled to 0–1 over the cells", "0–1"],
          [<Mi key="na"><mi>NA</mi></Mi>, "1 inside an EPA ozone / PM nonattainment area", "0/1"],
        ]}
        note={
          <>
            <p>
              <strong>Trained model</strong> (<Code>train.py</Code>): one XGBoost classifier per technology,{" "}
              <Mi>
                <V b="p" s="i,k" />
                <O>=</O>
                <mi>σ</mi>
                <P>
                  <Sum under="m" />
                  <V b="f" s="m" />
                  <P>
                    <V b="x" s="i" />
                  </P>
                </P>
              </Mi>
              , learning &ldquo;where plants like this were actually built&rdquo; from EIA-860 plants ≥ 5 MW online since 2000 (about 347
              solar, 66 wind, 74 battery, 114 gas) against 10 random cells per plant at least 3 km away, with class weights to balance
              them. Validation is 5-fold spatial cross-validation over 50 km blocks (neighbours never straddle train and test), reporting
              ROC-AUC, PR-AUC and precision in the top 10%. This is the model that scores the live recommended sites (ROC-AUC 0.92 for
              gas to 0.96 for wind).
            </p>
            <p>
              <strong>Fallback screening score</strong> (<Code>heuristic-v1</Code>): the fixed, documented blend in the equations above,
              used only when no trained artifact has been exported.
            </p>
          </>
        }
      >
        <MathBlock label="solar score">
          <Aligned
            rows={[
              [
                <V key="l" b="p" s="solar" />,
                <>
                  <O infix>=</O>
                  <N>0.45</N>
                  {exp("line", "15")}
                  <O>+</O>
                  <N>0.20</N>
                  <P>
                    <N>1</N>
                    <O>−</O>
                    <mi>crowd</mi>
                  </P>
                </>,
              ],
              [
                null,
                <>
                  <O infix>+</O>
                  <N>0.35</N>
                  <Clip>
                    <Frac
                      n={
                        <>
                          <mi>GHI</mi>
                          <O>−</O>
                          <N>4.5</N>
                        </>
                      }
                      d={<N>1.5</N>}
                    />
                  </Clip>
                </>,
              ],
            ]}
          />
        </MathBlock>
        <MathBlock label="wind score">
          <Aligned
            rows={[
              [
                <V key="l" b="p" s="wind" />,
                <>
                  <O infix>=</O>
                  <N>0.40</N>
                  {exp("line", "15")}
                  <O>+</O>
                  <N>0.10</N>
                  <P>
                    <N>1</N>
                    <O>−</O>
                    <mi>crowd</mi>
                  </P>
                </>,
              ],
              [
                null,
                <>
                  <O infix>+</O>
                  <N>0.50</N>
                  <Clip>
                    <Frac
                      n={
                        <>
                          <V b="v" s="100" />
                          <O>−</O>
                          <N>4</N>
                        </>
                      }
                      d={<N>4</N>}
                    />
                  </Clip>
                </>,
              ],
            ]}
          />
        </MathBlock>
        <MathBlock label="battery score">
          <Aligned
            rows={[
              [
                <V key="l" b="p" s="battery" />,
                <>
                  <O infix>=</O>
                  <N>0.50</N>
                  {exp("sub", "20")}
                  <O>+</O>
                  <N>0.30</N>
                  {exp("line", "15")}
                </>,
              ],
              [
                null,
                <>
                  <O infix>+</O>
                  <N>0.20</N>
                  <mi>dem</mi>
                </>,
              ],
            ]}
          />
        </MathBlock>
        <MathBlock label="gas score">
          <Aligned
            rows={[
              [
                <V key="l" b="p" s="gas" />,
                <>
                  <O infix>=</O>
                  <N>0.40</N>
                  {exp("line", "15")}
                  <O>+</O>
                  <N>0.30</N>
                  <mi>dem</mi>
                </>,
              ],
              [
                null,
                <>
                  <O infix>+</O>
                  <N>0.30</N>
                  <P>
                    <N>1</N>
                    <O>−</O>
                    <mi>NA</mi>
                  </P>
                </>,
              ],
            ]}
          />
        </MathBlock>
      </Equation>

      <Equation
        id="eq-need"
        title="How much new capacity the forecast needs"
        code="backend/app/sites/service.py"
        used={<>Forecast drawer → Sites (nameplate need by technology and region; mix and shares are editable).</>}
        where={[
          [<Mi key="de">{dE}<O>,</O><V b={dP} p="90" /></Mi>, "new annual energy and new P90 peak in a region, from the forecast", "MWh, MW"],
          [<Mi key="s"><mi>s</mi></Mi>, "clean-energy share of the new energy met by solar + wind, default 0.8", "0–1"],
          [<Mi key="w"><V b="w" s="k" /></Mi>, "mix weights: solar 0.75 : wind 0.25; battery 0.7 : gas 0.3", ""],
          [<Mi key="fl"><V b="F" s="left" /></Mi>, "new P90 peak still uncovered after the renewables' capacity credit", "MW"],
          [<Mi key="cf"><V b="CF" s="k" /></Mi>, "annual capacity factor from the 2024 site profiles (solar: mean of the sites ≈ 0.28; wind: the best site ≈ 0.19, as wind gets built where it blows)", "0–1"],
          [<Mi key="c"><V b="c" s="k" /></Mi>, "capacity credit: solar ≈ 0.055 and wind ≈ 0.136 (their mean output in CAISO's 100 highest net-load hours of 2024); battery 0.9, gas 0.95 (assumed)", "0–1"],
        ]}
        note={
          <p>
            Solar and wind are sized to the clean share of the new <em>energy</em>; batteries and gas cover the new <em>peak</em> left
            after the renewables&apos; capacity credit.
          </p>
        }
      >
        <MathBlock label="renewable nameplate">
          <V b="MW" s={<mrow><mi>k</mi><mo>∈</mo><mtext>solar, wind</mtext></mrow>} />
          <O>=</O>
          <Frac
            n={
              <>
                {dE}
                <O>·</O>
                <mi>s</mi>
                <O>·</O>
                <V b="w" s="k" />
              </>
            }
            d={
              <>
                <P>
                  <Sum under={<mtext>solar, wind</mtext>} />
                  <mi>w</mi>
                </P>
                <O>·</O>
                <mi>H</mi>
                <O>·</O>
                <V b="CF" s="k" />
              </>
            }
          />
        </MathBlock>
        <MathBlock label="firm peak left after the renewables' credit">
          <V b="F" s="left" />
          <O>=</O>
          <mi>max</mi>
          <P>
            <V b={dP} p="90" />
            <O>−</O>
            <Sum under={<mtext>solar, wind</mtext>} />
            <V b="MW" s="k" />
            <V b="c" s="k" />
            <O>,</O>
            <N>0</N>
          </P>
        </MathBlock>
        <MathBlock label="firm nameplate">
          <V b="MW" s={<mrow><mi>j</mi><mo>∈</mo><mtext>battery, gas</mtext></mrow>} />
          <O>=</O>
          <Frac
            n={
              <>
                <V b="F" s="left" />
                <O>·</O>
                <V b="w" s="j" />
              </>
            }
            d={
              <>
                <P>
                  <Sum under={<mtext>battery, gas</mtext>} />
                  <mi>w</mi>
                </P>
                <O>·</O>
                <V b="c" s="j" />
              </>
            }
          />
        </MathBlock>
      </Equation>

      <Equation
        id="eq-lp"
        title="Placing it: a least weighted-cost linear program (HiGHS)"
        code="backend/app/sites/service.py"
        used={<>Forecast drawer → Sites (the recommended sites, their MW, CAPEX and gen-tie cost; unmet MW when cells run out).</>}
        where={[
          [<Mi key="x"><V b="x" s="i" /></Mi>, "MW of technology k placed on cell i", "MW"],
          [<Mi key="u"><V b="u" s="k" /></Mi>, "need that no cell can take, reported as unmet", "MW"],
          [<Mi key="c"><V b="c" s="i" /></Mi>, "weighted cost score of the cell (not dollars)", "per MW"],
          [<Mi key="q"><V b="q" s="i" /></Mi>, "MW already in the county's interconnection queue (LBNL Queued Up), ÷ the maximum", "0–1"],
          [<Mi key="g"><V b="g" s="i" /></Mi>, "new demand within 150 km, ÷ the maximum", "0–1"],
          [<Mi key="na"><V b="NA" s="i" /></Mi>, "1 if the cell is in a nonattainment area; counted for gas only", "0/1"],
          [<Mi key="cap"><V b="cap" s="i" /></Mi>, "cell limit: 25 km² × share of land one project may use (solar 20%, wind 100%, battery and gas 1%) ÷ acres per MW, capped at 400 / 300 / 500 / 1,000 MW", "MW"],
        ]}
        note={
          <p>
            Only the 600 lowest-cost cells per technology enter the program, from anywhere in California. Each placed site then gets a
            CAPEX from the ATB catalog and a gen-tie cost of distance × the 230 kV line cost. The ranking weights (1.0, 0.5, 0.3, 0.3,
            0.5) are assumptions you can change in the Sites panel.
          </p>
        }
      >
        <MathBlock label="linear program: minimize weighted cost plus a penalty on unmet need">
          <Aligned
            rows={[
              [
                <munder key="l">
                  <mi>min</mi>
                  <mrow>
                    <mi>x</mi>
                    <mo>,</mo>
                    <mi>u</mi>
                  </mrow>
                </munder>,
                <>
                  <mspace width="0.4em" />
                  <Sum under="i" />
                  <V b="c" s="i" />
                  <V b="x" s="i" />
                  <O>+</O>
                  <N>100</N>
                  <Sum under="k" />
                  <V b="u" s="k" />
                </>,
              ],
              [
                <T key="l">s.t.</T>,
                <>
                  <mspace width="0.4em" />
                  <Sum under={<><mi>i</mi><mo>∈</mo><mi>k</mi></>} />
                  <V b="x" s="i" />
                  <O>+</O>
                  <V b="u" s="k" />
                  <O>≥</O>
                  <V b="need" s="k" />
                </>,
              ],
              [
                null,
                <>
                  <mspace width="0.4em" />
                  <N>0</N>
                  <O>≤</O>
                  <V b="x" s="i" />
                  <O>≤</O>
                  <V b="cap" s="i" />
                  <O>,</O>
                  <mspace width="0.4em" />
                  <V b="u" s="k" />
                  <O>≥</O>
                  <N>0</N>
                </>,
              ],
            ]}
          />
        </MathBlock>
        <MathBlock label="cell cost score">
          <Aligned
            rows={[
              [
                <V key="l" b="c" s="i" />,
                <>
                  <O infix>=</O>
                  <N>1.0</N>
                  <P>
                    <N>1</N>
                    <O>−</O>
                    <V b="p" s="i" />
                  </P>
                  <O>+</O>
                  <N>0.5</N>
                  <Frac
                    n={
                      <>
                        <mi>min</mi>
                        <P>
                          <V b="d" s="line" />
                          <O>,</O>
                          <N>100</N>
                        </P>
                      </>
                    }
                    d={<N>100</N>}
                  />
                </>,
              ],
              [
                null,
                <>
                  <O infix>+</O>
                  <N>0.3</N>
                  <V b="q" s="i" />
                  <O>+</O>
                  <N>0.3</N>
                  <P>
                    <N>1</N>
                    <O>−</O>
                    <V b="g" s="i" />
                  </P>
                  <O>+</O>
                  <N>0.5</N>
                  <V b="NA" s="i" />
                </>,
              ],
            ]}
          />
        </MathBlock>
      </Equation>
    </div>
  );
}
