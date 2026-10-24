// Carbon, air pollutants and 24/7 carbon-free energy. Mirrors backend/app/evaluate/{emissions,cfe}.py,
// data/evaluate/ref_emissions.json and the CAISO grid-carbon prep (data/simulate/caiso_2024_meta.json).
import { Equation, Ext, Frac, MathBlock, Mi, N, O, P, Sum, SubHeading, V } from "./ui";

// lb -> metric t: 0.45359237 kg/lb ÷ 1000, written as κ so the pollutant lines fit on a phone.
const LB = <mi>κ</mi>;

export function MathCarbon() {
  return (
    <div className="space-y-4">
      <SubHeading id="math-carbon">3 · Carbon, air quality and 24/7 clean energy</SubHeading>

      <Equation
        id="eq-emissions"
        title="Annual CO₂e = on-site gas + imports × hourly grid intensity"
        code={["backend/app/evaluate/emissions.py", "backend/app/simulate/profiles.py"]}
        used={<>Summary, Costs tab (emissions breakdown, intensity), Compare view, Report.</>}
        where={[
          [<Mi key="e"><mi>E</mi></Mi>, "annual emissions", "t CO₂e/yr"],
          [<Mi key="q"><V b="Q" s="k" /></Mi>, "gas burned by kind k, from the fuel equation", "MMBtu/yr"],
          [<Mi key="g"><V b="g" s="h" /></Mi>, "CAISO's average grid CO₂ intensity in hour h (2024 fuel mix)", "kg/MWh"],
          [<Mi key="m"><V b="M" s="f,h" /></Mi>, "CAISO supply from fuel f in hour h (imports and batteries included, negatives dropped)", "MW"],
          [<Mi key="ef"><V b="e" s="f" /></Mi>, "emission factor: gas 400, unspecified imports 428, coal 1,000, other 400; solar, wind, hydro, nuclear, geothermal, biomass 0", "kg/MWh"],
        ]}
        note={
          <>
            <p>
              <strong>53.06 kg CO₂/MMBtu</strong> is EPA&apos;s natural-gas factor (
              <Ext href="https://www.ecfr.gov/current/title-40/chapter-I/subchapter-C/part-98/subpart-C/appendix-Table%20C-1%20to%20Subpart%20C%20of%20Part%2098">
                40 CFR 98 Table C-1
              </Ext>
              ); combustion CH₄ and N₂O (under 0.1% of CO₂e) are left out. Using hourly intensity rewards importing when the grid is
              clean. The batteries and exports carry no emissions and earn no credit. Factors are never tuned to make one design win: an
              on-site combined cycle (6.087 × 53.06 ≈ 323 kg/MWh) can be dirtier than CAISO&apos;s average imports. As a sanity check the
              Costs tab shows eGRID2023&apos;s CAMX rate, 194.3 kg/MWh (generation inside California only).
            </p>
            <p>
              <strong>Upstream methane</strong> (off by default, always reported):{" "}
              <Mi>
                <mi>Q</mi>
                <O>×</O>
                <N>12.47</N>
              </Mi>{" "}
              kg CO₂e/MMBtu = 0.023/0.977 × 17.78 kg CH₄/MMBtu × 29.8 (2.3% supply-chain leakage, Alvarez et al. 2018; GWP100 29.8, IPCC
              AR6). Emission intensity is{" "}
              <Mi>
                <N>1000</N>
                <mi>E</mi>
                <O>/</O>
                <V b="E" s="served" />
              </Mi>{" "}
              kg/MWh.
            </p>
          </>
        }
      >
        <MathBlock label="Annual emissions">
          <mi>E</mi>
          <O>=</O>
          <Sum under="k" />
          <Frac
            n={
              <>
                <V b="Q" s="k" />
                <O>·</O>
                <N>53.06</N>
              </>
            }
            d={<N>1000</N>}
          />
          <O>+</O>
          <Sum under="h" />
          <Frac
            n={
              <>
                <V b="I" s="h" />
                <V b="g" s="h" />
              </>
            }
            d={<N>1000</N>}
          />
        </MathBlock>
        <MathBlock label="hourly grid intensity">
          <V b="g" s="h" />
          <O>=</O>
          <Frac
            n={
              <>
                <Sum under="f" />
                <V b="M" s="f,h" />
                <V b="e" s="f" />
              </>
            }
            d={
              <>
                <Sum under="f" />
                <V b="M" s="f,h" />
              </>
            }
          />
        </MathBlock>
      </Equation>

      <Equation
        id="eq-carb"
        title="Alternative import accounting: CARB's unspecified-import factor"
        code="backend/app/evaluate/emissions.py"
        used={<>Costs tab (switch between CAISO hourly and CARB import accounting).</>}
        where={[
          [<Mi key="e"><V b="E" s="imports" p="CARB" /></Mi>, "import emissions under California's reporting rule", "t CO₂e/yr"],
          [<Mi key="tl"><N>1.02</N></Mi>, "transmission-loss factor", "×"],
          [<Mi key="ef"><N>0.428</N></Mi>, "default factor for electricity of unspecified origin", "t CO₂e/MWh"],
        ]}
        note={
          <p>
            From{" "}
            <Ext href="https://www.law.cornell.edu/regulations/california/17-CCR-95111">CARB&apos;s Mandatory Reporting Regulation, 17 CCR 95111(b)(1)</Ext>
            : CO₂e = MWh × TL × EF. It is the regulator&apos;s proxy for marginal, dispatchable imports, so it is usually higher than the
            hourly average and is shown next to it rather than replacing it.
          </p>
        }
      >
        <MathBlock label="CARB import emissions">
          <V b="E" s="imports" p="CARB" />
          <O>=</O>
          <N>1.02</N>
          <O>×</O>
          <N>0.428</N>
          <O>×</O>
          <Sum under="h" />
          <V b="I" s="h" />
        </MathBlock>
        <MathBlock label="1.02 × 0.428 = 0.43656 t per MWh">
          <N>1.02</N>
          <O>×</O>
          <N>0.428</N>
          <O>=</O>
          <N>0.43656</N>
          <mspace width="0.3em" />
          <mtext>t / MWh</mtext>
        </MathBlock>
      </Equation>

      <Equation
        id="eq-air"
        title="NOx and PM2.5 from EPA AP-42"
        code="backend/app/evaluate/emissions.py"
        used={<>Costs tab (NOx, PM2.5), Compare view, and the Stress tab&apos;s air-permit-risk finding when on-site gas NOx lands in an EPA nonattainment area.</>}
        where={[
          [<Mi key="q"><mi>Q</mi></Mi>, "total on-site gas burned", "MMBtu/yr"],
          [<Mi key="lb">{LB}</Mi>, "0.45359237 kg per lb ÷ 1000: turns pounds into metric tonnes", "t/lb"],
        ]}
        note={
          <p>
            The primary NOx case is{" "}
            <Ext href="https://www.epa.gov/sites/default/files/2020-10/documents/c03s01.pdf">AP-42 Table 3.1-1</Ext> lean-premix turbines
            with no SCR, <strong>0.099 lb/MMBtu</strong> (conservative). The California BACT alternative with SCR uses 0.00737 lb/MMBtu
            for CC (2.0 ppm) and 0.00921 lb/MMBtu for CT (2.5 ppm), from BAAQMD BACT guidelines. PM2.5 counts all of AP-42 Table 3.1-2a
            total PM, <strong>0.0066 lb/MMBtu</strong>, as PM2.5 (an upper bound). All are zero without gas.
          </p>
        }
      >
        <MathBlock label="NOx, no SCR">
          <V b="m" s="NOx" />
          <O>=</O>
          <mi>Q</mi>
          <O>·</O>
          <N>0.099</N>
          <O>·</O>
          {LB}
        </MathBlock>
        <MathBlock label="NOx with SCR (California BACT)">
          <V b="m" s="NOx" p="SCR" />
          <O>=</O>
          <P>
            <N>0.00737</N>
            <V b="Q" s="CC" />
            <O>+</O>
            <N>0.00921</N>
            <V b="Q" s="CT" />
          </P>
          <O>·</O>
          {LB}
        </MathBlock>
        <MathBlock label="PM2.5">
          <V b="m" s="PM2.5" />
          <O>=</O>
          <mi>Q</mi>
          <O>·</O>
          <N>0.0066</N>
          <O>·</O>
          {LB}
        </MathBlock>
        <MathBlock label="kappa = 0.45359237 / 1000">
          <mi>κ</mi>
          <O>=</O>
          <Frac n={<N>0.45359237</N>} d={<N>1000</N>} />
          <mspace width="0.3em" />
          <mtext>t / lb</mtext>
        </MathBlock>
      </Equation>

      <Equation
        id="eq-cfe"
        title="24/7 carbon-free energy (hourly matching)"
        code="backend/app/evaluate/cfe.py"
        used={<>Costs tab (24/7 CFE card, by month and hour of day), Summary, Compare view.</>}
        where={[
          [<Mi key="r"><V b="R" s="h" /></Mi>, "on-site solar and wind kept on site (not curtailed, not exported)", "MW"],
          [<Mi key="cl"><V b="CL" s="h" /></Mi>, "clean supply reaching the load in hour h", "MW"],
          [<Mi key="f"><V b="f" s="h" /></Mi>, "clean fraction of the energy in the battery (a well-mixed pool, updated every charge)", "0–1"],
          [<Mi key="ic"><V b="I" s="h" p="ch" /></Mi>, "imports that went into the battery (charge not covered by on-site renewables, split pro rata between imports and gas)", "MW"],
          [<Mi key="g"><V b="γ" s="h" /></Mi>, "CAISO's clean share that hour: (solar + wind + geothermal + nuclear + hydro) ÷ all supply", "0–1"],
        ]}
        note={
          <p>
            An hour counts only when clean supply covers <em>all</em> demand that hour; the score is the share of such hours. For contrast
            the Costs tab also shows the energy-weighted hourly share,{" "}
            <Mi>
              <Sum />
              <mi>min</mi>
              <P>
                <V b="CL" s="h" />
                <O>,</O>
                <V b="D" s="h" />
              </P>
              <O>/</O>
              <Sum />
              <V b="D" s="h" />
            </Mi>
            , and the annual-netting share (all clean MWh over the year ÷ all demand, capped at 100%), which is what most &ldquo;100%
            renewable&rdquo; claims use.
          </p>
        }
      >
        <MathBlock label="clean supply">
          <V b="R" s="h" />
          <O>=</O>
          <mi>max</mi>
          <P>
            <V b="G" s="solar,h" />
            <O>+</O>
            <V b="G" s="wind,h" />
            <O>−</O>
            <V b="C" s="h" />
            <O>−</O>
            <V b="X" s="h" />
            <O>,</O>
            <N>0</N>
          </P>
        </MathBlock>
        <MathBlock label="clean load">
          <V b="CL" s="h" />
          <O>=</O>
          <mi>min</mi>
          <P>
            <V b="R" s="h" />
            <O>,</O>
            <V b="D" s="h" />
          </P>
          <O>+</O>
          <V b="B" s="h" p="dis" />
          <V b="f" s="h" />
          <O>+</O>
          <P>
            <V b="I" s="h" />
            <O>−</O>
            <V b="I" s="h" p="ch" />
          </P>
          <V b="γ" s="h" />
        </MathBlock>
        <MathBlock label="24/7 CFE score">
          <mtext>24/7 CFE</mtext>
          <O>=</O>
          <Frac
            n={
              <>
                <mo>#</mo>
                <P open="{" close="}">
                  <mi>h</mi>
                  <O>:</O>
                  <V b="CL" s="h" />
                  <O>≥</O>
                  <V b="D" s="h" />
                </P>
              </>
            }
            d={
              <>
                <mo>#</mo>
                <P open="{" close="}">
                  <mi>h</mi>
                  <O>:</O>
                  <V b="D" s="h" />
                  <O>&gt;</O>
                  <N>0</N>
                </P>
              </>
            }
          />
        </MathBlock>
      </Equation>
    </div>
  );
}
