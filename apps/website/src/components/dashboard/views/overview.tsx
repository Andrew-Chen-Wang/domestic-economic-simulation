"use client"

import type { SeriesRow } from "../api"
import { LineChart, Sparkline, StackedArea } from "../charts"
import { Card, TimeChart } from "../common"
import { fmtMoney, fmtNum, fmtPct } from "../format"
import { pts, useDash } from "../state"

type Key = keyof SeriesRow

function annualSum(series: SeriesRow[], keys: Key[]) {
  const out: (Record<string, number> & { tick: number })[] = []
  for (let i = 11; i < series.length; i += 12) {
    const r: Record<string, number> & { tick: number } = { tick: series[i].tick }
    for (const k of keys)
      r[k] = series
        .slice(i - 11, i + 1)
        .reduce((a, m) => a + (typeof m[k] === "number" ? (m[k] as number) : 0), 0)
    out.push(r)
  }
  return out
}

export function Overview() {
  const d = useDash()
  const m = d.current
  const t = d.timeline
  if (!t) return null
  const prev = d.series.find((x) => x.tick === d.cursor - 12)
  const num = (row: SeriesRow | null | undefined, key: Key) => {
    const v = row?.[key]
    return typeof v === "number" ? v : null
  }
  const kpi = (label: string, key: Key, fmt: (v: number) => string, scale = 1) => {
    const v = num(m, key)
    const p = num(prev, key)
    const delta = v !== null && p !== null ? v - p : null
    return (
      <div className="kpi" key={key}>
        <div className="label">{label}</div>
        <div className="value">{v === null ? "–" : fmt(v * scale)}</div>
        <div className="delta">
          {delta === null
            ? ""
            : `${delta >= 0 ? "▲" : "▼"} ${fmt(Math.abs(delta) * scale)} vs a year earlier`}
        </div>
        <Sparkline values={d.series.slice(-60).map((x) => num(x, key))} />
      </div>
    )
  }
  const ax = d.axis
  const yr = annualSum(d.series, ["entries", "bankruptcies"])
  return (
    <>
      <h1>{t.name}</h1>
      <p className="lead">
        {d.meta.scenarios[t.scenario]?.desc ?? ""} Viewing{" "}
        <b>{d.series.length ? ax.tickLabel(d.cursor) : "start"}</b>. Click any chart to move the
        time cursor; dotted lines mark policy decisions.
      </p>
      <div className="toolbar">
        <label>
          Compare with branch{" "}
          <select
            value={d.compare?.id ?? ""}
            onChange={(e) => void d.setCompare(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— none —</option>
            {d.timelines
              .filter((x) => x.id !== d.tid)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} (#{x.id})
                </option>
              ))}
          </select>
        </label>
        {!d.series.length && (
          <span className="pill">
            Run the simulation with the buttons at the top (+1 year etc.)
          </span>
        )}
      </div>
      <div className="kpis">
        {kpi("GDP (annualized)", "gdp", fmtMoney, 12)}
        {kpi("Real GDP per person / yr", "real_gdp_pc", fmtMoney, 12)}
        {kpi("Unemployment", "unemployment", (v) => fmtPct(v))}
        {kpi("Inflation (12m)", "inflation", (v) => fmtPct(v))}
        {kpi("Government debt / GDP", "debt_gdp", (v) => fmtPct(v, 0))}
        {kpi("Trade balance / month", "trade_balance", fmtMoney)}
        {kpi("Population", "population", fmtNum)}
        {kpi("Gini (income)", "gini", (v) => v.toFixed(3))}
        {kpi("Life expectancy", "life_expectancy", (v) => `${v.toFixed(1)} yrs`)}
        {kpi("Urbanization", "urbanization", (v) => fmtPct(v, 0))}
        {kpi("Products made at home", "domestic_products", fmtNum)}
        {kpi("CO₂ / month", "emissions", (v) => `${fmtNum(v)} t`)}
      </div>
      {d.series.length > 0 && (
        <div className="grid g2">
          <Card title="Real GDP" sub="monthly, start-year prices">
            <TimeChart defs={[{ name: "Real GDP", key: "real_gdp" }]} yfmt={fmtMoney} area />
          </Card>
          <Card title="GDP by expenditure" sub="C + G + I + exports − imports (monthly)">
            <StackedArea
              x={d.series.map((x) => x.tick)}
              xfmt={ax.xfmt}
              xticks={ax.xticks}
              yfmt={fmtMoney}
              height={210}
              series={[
                { name: "Consumption", values: d.series.map((x) => x.C) },
                { name: "Government", values: d.series.map((x) => x.G) },
                {
                  name: "Investment",
                  values: d.series.map((x) => Math.max(0, x.I + (x.dInv || 0))),
                },
                { name: "Net exports", values: d.series.map((x) => Math.max(0, x.X - x.M)) },
              ]}
            />
          </Card>
          <Card title="Unemployment rate">
            <TimeChart
              defs={[{ name: "Unemployment", key: "unemployment" }]}
              yfmt={(v) => fmtPct(v, 0)}
            />
          </Card>
          <Card title="Inflation and policy rate">
            <TimeChart
              defs={[
                { name: "Inflation", key: "inflation" },
                { name: "Policy rate", key: "policy_rate", color: "var(--series-2)" },
              ]}
              yfmt={(v) => fmtPct(v, 0)}
              zero={false}
            />
          </Card>
          <Card title="Average real wage" sub="monthly, start-year prices">
            <TimeChart
              defs={[{ name: "Real average wage", key: "real_avg_wage" }]}
              yfmt={fmtMoney}
            />
          </Card>
          <Card title="Government revenue vs spending" sub="monthly">
            <TimeChart
              defs={[
                { name: "Revenue", key: "gov_revenue" },
                { name: "Spending", key: "gov_spending", color: "var(--series-2)" },
              ]}
              yfmt={fmtMoney}
            />
          </Card>
          <Card title="Exports and imports" sub="monthly">
            <TimeChart
              defs={[
                { name: "Exports", key: "X" },
                { name: "Imports", key: "M", color: "var(--series-2)" },
              ]}
              yfmt={fmtMoney}
            />
          </Card>
          <Card title="Population and fertility">
            <TimeChart
              defs={[{ name: "Population", key: "population" }]}
              yfmt={fmtNum}
              zero={false}
              height={150}
            />
            <LineChart
              series={[
                {
                  name: "Fertility rate (births per woman)",
                  points: pts(d.series, "tfr"),
                  color: "var(--series-3)",
                },
              ]}
              xfmt={ax.xfmt}
              xticks={ax.xticks}
              height={120}
              yfmt={(v) => v.toFixed(2)}
              zero={false}
            />
          </Card>
          <Card title="Inequality and poverty">
            <TimeChart
              defs={[
                { name: "Gini", key: "gini" },
                { name: "Poverty rate", key: "poverty", color: "var(--series-2)" },
              ]}
              yfmt={(v) => v.toFixed(2)}
            />
          </Card>
          <Card title="Firms, start-ups and bankruptcies">
            <TimeChart
              defs={[{ name: "Operating firms", key: "firms" }]}
              yfmt={fmtNum}
              zero={false}
              height={150}
            />
            <LineChart
              series={[
                { name: "Start-ups per year", points: yr.map((r) => [r.tick, r.entries]) },
                {
                  name: "Bankruptcies per year",
                  points: yr.map((r) => [r.tick, r.bankruptcies]),
                  color: "var(--series-2)",
                },
              ]}
              xfmt={ax.xfmt}
              xticks={ax.xticks}
              height={130}
              yfmt={fmtNum}
            />
          </Card>
        </div>
      )}
    </>
  )
}
