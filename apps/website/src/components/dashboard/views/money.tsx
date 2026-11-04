"use client"

import { useState } from "react"
import { type FlowsResponse, type SeriesRow, useApi } from "../api"
import { MoneyFlow, seriesColor, Treemap } from "../charts"
import { Card, Loading } from "../common"
import { fmtMoney, fmtNum, fmtPct } from "../format"
import { useDash } from "../state"

const FIXED_COLORS: Record<string, string> = {
  Households: "var(--series-1)",
  Government: "var(--series-2)",
  Banks: "var(--series-7)",
  "Rest of world": "var(--series-8)",
}
const OTHER_COLORS = ["var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"]
const nodeColor = (name: string, i: number) => FIXED_COLORS[name] ?? OTHER_COLORS[i % 4]

const FIN_KINDS = new Set([
  "loan",
  "loan repayment",
  "working capital loan",
  "investment loan",
  "startup loan",
  "bond issuance",
  "debt repayment",
  "mortgage/construction loan",
  "loan write-off",
  "debt restructuring",
  "equity",
])

type DetailKey = "sector_va" | "hh_need" | "gov_rev_detail" | "gov_spend_detail"

export function MoneyView() {
  const d = useDash()
  const ax = d.axis
  const hi = d.cursor
  const lo = Math.max(0, hi - 11)
  const flows = useApi<FlowsResponse>(
    `/api/timelines/${d.tid}/flows?from=${lo}&to=${hi}&v=${d.version}`,
  )
  const state = useApi<{ data: { prices: Record<string, number> } | null }>(
    `/api/timelines/${d.tid}/detail/state?tick=${hi + 1}&v=${d.version}`,
  )
  const [minFlow, setMinFlow] = useState(0.005)
  const [hideFin, setHideFin] = useState(false)
  const [amount, setAmount] = useState(1e9)
  const win = d.series.filter((m) => m.tick >= lo && m.tick <= hi)
  const sumObj = (k: DetailKey) => {
    const o: Record<string, number> = {}
    for (const m of win) for (const [a, b] of Object.entries(m[k] ?? {})) o[a] = (o[a] ?? 0) + b
    return o
  }
  const tm = (obj: Record<string, number>, nameMap: (k: string) => string = (k) => k) => (
    <Treemap
      height={280}
      items={Object.entries(obj).map(([k, v], i) => ({
        label: nameMap(k),
        value: v,
        color: seriesColor(i),
        tip: d.perCapita(v),
      }))}
    />
  )
  const m = d.current
  const y = (k: keyof SeriesRow) =>
    win.reduce((a, x) => a + (typeof x[k] === "number" ? x[k] : 0), 0)
  const prices = state.data?.data?.prices ?? {}
  const ladder = (
    [
      ["GDP (12 months)", y("gdp")],
      ["Household consumption", y("C")],
      ["Government spending", y("gov_spending")],
      ["Wage bill", y("wage_bill")],
      ["Exports", y("X")],
      ["Imports", y("M")],
      ["Government debt", m?.gov_debt ?? 0],
      ["Bank loans outstanding", m?.bank_loans ?? 0],
      ["Dividends paid", y("dividends")],
      ["A new 1 Mt/yr cement kiln", prices.cement_kiln ?? 0],
      ["A jet airliner", prices.jet_airliner ?? 0],
      ["A new home", prices.dwelling ?? 0],
      ["A year of the median wage", (m?.median_wage ?? 0) * 12],
      ["A car", prices.passenger_car ?? 0],
      ["A smartphone", prices.smartphone ?? 0],
      ["A month's rent", m?.housing_rent ?? 0],
      ["1 kg of bread", (prices.bread_bakery ?? 0) / 1000],
    ] as [string, number][]
  )
    .filter((x) => x[1] > 0)
    .toSorted((a, b) => b[1] - a[1])
  const lmax = Math.log10(ladder[0]?.[1] ?? 10)
  const lmin = Math.log10(ladder[ladder.length - 1]?.[1] ?? 1) - 0.5

  let links = flows.data?.links ?? []
  if (hideFin)
    links = links.map((l) => {
      const kinds = Object.fromEntries(Object.entries(l.kinds).filter(([k]) => !FIN_KINDS.has(k)))
      return { ...l, kinds, value: Object.values(kinds).reduce((a, b) => a + b, 0) }
    })
  const total = (flows.data?.links ?? []).reduce((a, l) => a + l.value, 0)
  links = links.filter((l) => l.value >= minFlow * total && l.value > 0)

  return (
    <>
      <h1>Where the money goes</h1>
      <p className="lead">
        Every payment in the economy is recorded in the ledger. These views add it up for the 12
        months ending <b>{ax.tickLabel(hi)}</b>. Hover anything to see it per person and as a share
        of GDP.
      </p>
      <Card title="Money flows between sectors" sub={`${ax.tickLabel(lo)} – ${ax.tickLabel(hi)}`}>
        <div className="toolbar">
          <label>
            Hide flows smaller than{" "}
            <select
              value={minFlow}
              onChange={(e) => {
                setMinFlow(Number(e.target.value))
              }}
            >
              <option value={0.002}>0.2% of total</option>
              <option value={0.005}>0.5%</option>
              <option value={0.01}>1%</option>
              <option value={0}>show all</option>
            </select>
          </label>
          <label>
            <input
              aria-label="Hide loans and repayments"
              type="checkbox"
              checked={hideFin}
              onChange={(e) => {
                setHideFin(e.target.checked)
              }}
            />{" "}
            hide loans/repayments
          </label>
        </div>
        {flows.data ? (
          <MoneyFlow links={links} height={560} color={nodeColor} per={(v) => d.perCapita(v)} />
        ) : (
          <Loading />
        )}
      </Card>
      <div className="grid g2" style={{ marginTop: 14 }}>
        <Card title="Value added by sector" sub="who produces the GDP">
          {tm(sumObj("sector_va"))}
        </Card>
        <Card title="Household spending by need">
          {tm(sumObj("hh_need"), (k) => d.meta.needs[k] ?? k)}
        </Card>
        <Card title="Government revenue">{tm(sumObj("gov_rev_detail"))}</Card>
        <Card title="Government spending">
          {tm(sumObj("gov_spend_detail"), (k) => d.by.goods[k]?.name ?? k)}
        </Card>
      </div>
      <Card title="Put a dollar amount in perspective" style={{ marginTop: 14 }}>
        <div className="toolbar">
          <label>
            Amount ${" "}
            <input
              aria-label="Amount in dollars"
              type="number"
              value={amount}
              style={{ width: 180 }}
              onChange={(e) => {
                setAmount(Number(e.target.value) || 0)
              }}
            />
          </label>
          <span>
            = <b>{fmtMoney(amount / (m?.population ?? 1))}</b> per resident ·{" "}
            <b>{fmtPct(amount / ((m?.gdp ?? 1) * 12), 2)}</b> of a year&apos;s GDP ·{" "}
            <b>{fmtNum(amount / (m?.median_wage ?? 1))}</b> months of the median wage ·{" "}
            <b>{fmtNum(amount / (m?.housing_rent ?? 1))}</b> months of average rent
          </span>
        </div>
        <h3>The scale of this economy (log scale)</h3>
        <div className="barlist">
          {ladder.map(([k, v], i) => (
            <div className="bar-row" key={k}>
              <div className="bar-label">{k}</div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{
                    width: `${(((Math.log10(v) - lmin) / (lmax - lmin)) * 100).toFixed(1)}%`,
                    background: `var(--series-${(i % 3) + 1})`,
                  }}
                />
              </div>
              <div className="bar-val">{fmtMoney(v)}</div>
            </div>
          ))}
        </div>
        <p className="dollar-ctx">
          Each step to the right is ×10. Prices are this economy&apos;s own prices at the selected
          month.
        </p>
      </Card>
    </>
  )
}
