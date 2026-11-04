"use client"

import { useRef, useState } from "react"
import { useApi } from "../api"
import { BarList, useTip, useWidth, TipHead } from "../charts"
import { ErrorCard, Loading } from "../common"
import { fmtMoney, fmtNum, fmtPct } from "../format"
import { useDash } from "../state"

interface RegionDetail {
  id: number
  name: string
  arch: string
  area: number
  urban_km2: number
  temp: number
  rain: number
  port: boolean
  pos: [number, number]
  pop: number
  urban_pop: number
  infra: Record<string, number>
  dwellings: number
  rent: number
  productivity: number
  deposits: Record<string, { qty: number; qty0: number; grade: number; kind: string }>
  suit: Record<string, number>
}

const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]

export function RegionsView() {
  const d = useDash()
  const r = useApi<{ tick: number | null; data: { regions: RegionDetail[] } | null }>(
    `/api/timelines/${d.tid}/detail/regions?tick=${d.cursor + 1}&v=${d.version}`,
  )
  const [metric, setMetric] = useState("pop")
  const [sel, setSel] = useState<number | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const W = useWidth(host, 500)
  const tip = useTip()
  if (r.error) return <ErrorCard error={r.error} />
  const regs = r.data?.data?.regions ?? []
  const rm = d.current?.regions ?? {}
  const metrics: Record<
    string,
    [string, (x: RegionDetail) => number | undefined, (v: number) => string]
  > = {
    pop: ["Population", (x) => x.pop, (v) => fmtNum(v)],
    urban: ["Urban share", (x) => x.urban_pop / Math.max(1, x.pop), (v) => fmtPct(v)],
    unemp: ["Unemployment", (x) => rm[x.id]?.unemployment, (v) => fmtPct(v)],
    wage: ["Average wage", (x) => rm[x.id]?.avg_wage, (v) => fmtMoney(v)],
    rent: ["Rent", (x) => x.rent, (v) => fmtMoney(v)],
    crowd: ["People per dwelling", (x) => x.pop / Math.max(1, x.dwellings), (v) => v.toFixed(2)],
    prod: ["Agglomeration productivity", (x) => x.productivity, (v) => v.toFixed(3)],
    road: ["Road quality", (x) => x.infra.road, (v) => fmtPct(v)],
    grid: ["Grid quality", (x) => x.infra.grid, (v) => fmtPct(v)],
    transit: ["Transit quality", (x) => x.infra.transit, (v) => fmtPct(v)],
  }
  const [label, f, fmt] = metrics[metric]
  const H = 440
  const xs = regs.map((x) => x.pos[0])
  const ys = regs.map((x) => x.pos[1])
  const X = (x: number) =>
    60 + ((x - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs) || 1)) * (W - 120)
  const Y = (y: number) =>
    50 + ((y - Math.min(...ys)) / (Math.max(...ys) - Math.min(...ys) || 1)) * (H - 120)
  const vals = regs.map((x) => f(x) ?? 0)
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const col = (v: number) => RAMP[Math.min(6, Math.floor(((v - lo) / (hi - lo || 1)) * 6.999))]
  const maxPop = Math.max(...regs.map((x) => x.pop), 1)
  const cur = regs.find((x) => x.id === sel) ?? regs[0]
  const st = cur ? rm[cur.id] : undefined
  return (
    <>
      <h1>Regions &amp; cities</h1>
      <p className="lead">
        Each region has its own geology, climate, land and infrastructure. Mines appear where
        deposits are, farms where the climate suits the crop, and cities grow where jobs are -
        limited by zoning, land and transit. Circle size = population; color = the selected measure.
      </p>
      <div className="grid g2">
        <div className="card">
          <div className="toolbar">
            <select
              aria-label="Measure"
              value={metric}
              onChange={(e) => {
                setMetric(e.target.value)
              }}
            >
              {Object.entries(metrics).map(([k, v]) => (
                <option key={k} value={k}>
                  {v[0]}
                </option>
              ))}
            </select>
            <span className="legend-scale">
              low <span className="ramp" /> high
            </span>
          </div>
          <div ref={host} className="region-map">
            {!r.data ? (
              <Loading />
            ) : (
              <svg width={W} height={H}>
                {regs.flatMap((a, i) =>
                  regs
                    .slice(i + 1)
                    .map((b) => (
                      <line
                        key={`${a.id}-${b.id}`}
                        x1={X(a.pos[0])}
                        y1={Y(a.pos[1])}
                        x2={X(b.pos[0])}
                        y2={Y(b.pos[1])}
                      />
                    )),
                )}
                {regs.map((x, i) => {
                  const rad = 10 + 30 * Math.sqrt(x.pop / maxPop)
                  return (
                    <g key={x.id}>
                      <circle
                        cx={X(x.pos[0])}
                        cy={Y(x.pos[1])}
                        r={rad}
                        fill={col(vals[i])}
                        onMouseMove={(ev) => {
                          tip.show(
                            <>
                              <TipHead>{x.name}</TipHead>
                              {label}: <b>{fmt(vals[i])}</b>
                            </>,
                            ev,
                          )
                        }}
                        onMouseLeave={tip.hide}
                        onClick={() => {
                          setSel(x.id)
                        }}
                      />
                      <text x={X(x.pos[0])} y={Y(x.pos[1]) + rad + 14} textAnchor="middle">
                        {x.name}
                        {x.port ? " ⚓" : ""}
                      </text>
                    </g>
                  )
                })}
              </svg>
            )}
          </div>
        </div>
        <div className="card">
          {cur && (
            <>
              <h2>
                {cur.name}
                <small>
                  {cur.arch.replace("_", " ")}
                  {cur.port ? " · seaport" : ""}
                </small>
              </h2>
              <div className="muted">
                {fmtNum(cur.area)} km² · {cur.temp.toFixed(1)}°C · {fmtNum(cur.rain)} mm rain/yr ·
                city area {fmtNum(cur.urban_km2)} km²
              </div>
              <table className="data" style={{ marginTop: 8 }}>
                <tbody>
                  <tr>
                    <td>Population</td>
                    <td className="num">
                      {fmtNum(cur.pop)} ({fmtPct(cur.urban_pop / Math.max(1, cur.pop), 0)} urban)
                    </td>
                  </tr>
                  <tr>
                    <td>Unemployment</td>
                    <td className="num">{fmtPct(st?.unemployment)}</td>
                  </tr>
                  <tr>
                    <td>Average wage</td>
                    <td className="num">{fmtMoney(st?.avg_wage)}</td>
                  </tr>
                  <tr>
                    <td>Rent / dwellings</td>
                    <td className="num">
                      {fmtMoney(cur.rent)} · {fmtNum(cur.dwellings)} homes (cap{" "}
                      {fmtNum(st?.dwelling_cap)})
                    </td>
                  </tr>
                  <tr>
                    <td>Wages paid here</td>
                    <td className="num">{fmtMoney(st?.va)} / month</td>
                  </tr>
                </tbody>
              </table>
              <h3>Infrastructure</h3>
              <BarList
                fmt={(v) => fmtPct(v, 0)}
                items={Object.entries(cur.infra).map(([k, v]) => ({
                  label: k,
                  value: v,
                  color: "var(--series-1)",
                }))}
              />
              <h3>
                Natural resources <span className="muted">(grade, remaining)</span>
              </h3>
              <div className="chips">
                {Object.entries(cur.deposits)
                  .filter(([k, v]) => v.kind !== "flow" || ["hydro", "wind", "solar"].includes(k))
                  .toSorted((a, b) => b[1].grade - a[1].grade)
                  .map(([k, v]) => (
                    <span className="chip" key={k}>
                      {k} · {v.grade.toFixed(2)}
                      {v.kind === "stock"
                        ? ` · ${fmtPct(v.qty / Math.max(v.qty0, 1), 0)} left`
                        : ""}
                    </span>
                  ))}
              </div>
              <h3>Best-suited crops &amp; livestock</h3>
              <div className="chips">
                {Object.entries(cur.suit)
                  .toSorted((a, b) => b[1] - a[1])
                  .slice(0, 8)
                  .map(([k, v]) => (
                    <span className="chip" key={k}>
                      {d.by.goods[k]?.name ?? k} {fmtPct(v, 0)}
                    </span>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
