"use client"

import { useState } from "react"
import { useApi } from "../api"
import { BarList, seriesColor } from "../charts"
import { Card, ErrorCard, Loading, Th } from "../common"
import { fmtMoney, fmtNum, fmtPct } from "../format"
import { useDash } from "../state"

export interface FirmDetail {
  id: number
  name: string
  good: string
  good_name: string
  cat: string
  sector: string
  region: number
  owner: string
  founded: number
  proc: string
  trad: boolean
  output: number
  revenue: number
  exports: number
  profit: number
  staff: number
  cash: number
  debt: number
  price: number
  design: number
  gen: number
  quality: number
  util: number
  blocked: string | null
}

type SortKey =
  | "name"
  | "good_name"
  | "region"
  | "owner"
  | "revenue"
  | "exports"
  | "staff"
  | "profit"
  | "util"
  | "design"
  | "quality"
  | "blocked"

export function IndustryView() {
  const d = useDash()
  const r = useApi<{ tick: number | null; data: FirmDetail[] | null }>(
    `/api/timelines/${d.tid}/detail/firms?tick=${d.cursor + 1}&v=${d.version}`,
  )
  const [sector, setSector] = useState("")
  const [owner, setOwner] = useState("")
  const [sort, setSort] = useState<SortKey>("revenue")
  if (r.error) return <ErrorCard error={r.error} />
  if (!r.data) return <Loading />
  const firms = r.data.data ?? []
  const m = d.current
  const sectors = [...new Set(firms.map((f) => f.sector))].toSorted()
  const own: Record<string, number> = {}
  for (const f of firms) {
    const k = `${f.owner}${f.trad ? " · traditional" : ""}${f.design < 1 ? " · in R&D" : ""}`
    own[k] = (own[k] ?? 0) + 1
  }
  const rname = (i: number) => d.regions.find((x) => x.id === i)?.name ?? String(i)
  const list = firms
    .filter((f) => (!sector || f.sector === sector) && (!owner || f.owner === owner))
    .toSorted((a, b) => {
      const av = a[sort]
      const bv = b[sort]
      return typeof av === "number" && typeof bv === "number"
        ? bv - av
        : String(av ?? "").localeCompare(String(bv ?? ""))
    })
  const cols: [SortKey, string, boolean?][] = [
    ["name", "Firm"],
    ["good_name", "Product"],
    ["region", "Region"],
    ["owner", "Owner"],
    ["revenue", "Revenue / mo", true],
    ["exports", "Exports / mo", true],
    ["staff", "Workers", true],
    ["profit", "Profit / mo", true],
    ["util", "Utilization", true],
    ["design", "Design", true],
    ["quality", "Quality", true],
    ["blocked", "Constraint"],
  ]
  return (
    <>
      <h1>Industry &amp; firms</h1>
      <p className="lead">
        Firm-level snapshot from {r.data.tick !== null ? d.axis.tickLabel(r.data.tick) : "—"} (firm
        details are saved yearly and at the latest month). Firms enter when imports or shortages
        signal profit, exit when they run out of money, switch technologies when wages or prices
        change, and run R&amp;D.
      </p>
      <div className="grid g2">
        <Card title="Value added by sector" sub={d.axis.tickLabel(d.cursor)}>
          <BarList
            fmt={fmtMoney}
            items={Object.entries(m?.sector_va ?? {})
              .toSorted((a, b) => b[1] - a[1])
              .map(([k, v]) => ({
                label: k,
                value: v,
                color: "var(--series-1)",
                tip: (
                  <>
                    {fmtMoney(v)} / month{d.perCapita(v, true)}
                  </>
                ),
              }))}
          />
        </Card>
        <Card title="Ownership & technology">
          <BarList
            fmt={(v) => `${fmtNum(v)} firms`}
            items={Object.entries(own)
              .toSorted((a, b) => b[1] - a[1])
              .map(([k, v], i) => ({ label: k, value: v, color: seriesColor(i) }))}
          />
        </Card>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <div className="toolbar">
          <select
            aria-label="Sector"
            value={sector}
            onChange={(e) => {
              setSector(e.target.value)
            }}
          >
            <option value="">All sectors</option>
            {sectors.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select
            aria-label="Owner"
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value)
            }}
          >
            <option value="">All owners</option>
            {["private", "state", "foreign"].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <span className="muted">{list.length} firms</span>
        </div>
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                {cols.map(([k, l, num]) => (
                  <Th key={k} k={k} label={l} num={num} sort={sort} setSort={setSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 500).map((f) => (
                <tr
                  key={f.id}
                  className="clickable"
                  onClick={() => {
                    d.go("product", f.good)
                  }}
                >
                  <td>{f.name}</td>
                  <td>
                    {f.good_name}
                    {f.trad && <span className="pill">traditional</span>}
                  </td>
                  <td>{rname(f.region)}</td>
                  <td>{f.owner}</td>
                  <td className="num">{fmtMoney(f.revenue)}</td>
                  <td className="num">{fmtMoney(f.exports)}</td>
                  <td className="num">{fmtNum(f.staff)}</td>
                  <td className="num">{fmtMoney(f.profit)}</td>
                  <td className="num">{fmtPct(f.util, 0)}</td>
                  <td className="num">{fmtPct(f.design, 0)}</td>
                  <td className="num">{f.quality.toFixed(2)}</td>
                  <td>{f.blocked ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
