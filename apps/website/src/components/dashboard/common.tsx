"use client"

import type { ReactNode } from "react"
import type { SeriesRow } from "./api"
import { LineChart, type LineSeries } from "./charts"
import { pts, useDash } from "./state"

export function Card({
  title,
  sub,
  children,
  style,
}: {
  title?: ReactNode
  sub?: ReactNode
  children: ReactNode
  style?: React.CSSProperties
}) {
  return (
    <div className="card" style={style}>
      {title !== undefined && (
        <h2>
          {title}
          {sub !== undefined && <small>{sub}</small>}
        </h2>
      )}
      {children}
    </div>
  )
}

export interface TimeSeriesDef {
  name: string
  key: keyof SeriesRow
  f?: (v: number) => number
  color?: string
}

/**
 * Time-series line chart over the timeline's monthly metrics, with policy markers, the compared
 * branch (dashed) and click-to-move-cursor.
 */
export function TimeChart({
  defs,
  yfmt,
  zero,
  area,
  height = 210,
}: {
  defs: TimeSeriesDef[]
  yfmt?: (v: number) => string
  zero?: boolean
  area?: boolean
  height?: number
}) {
  const d = useDash()
  const series: LineSeries[] = defs.map((s) => ({
    name: s.name,
    points: pts(d.series, s.key, s.f),
    color: s.color,
  }))
  if (d.compare)
    for (const s of defs)
      series.push({
        name: `${s.name} (${d.compare.name})`,
        points: pts(d.compareSeries, s.key, s.f),
        color: s.color,
        dash: "5 4",
      })
  return (
    <LineChart
      series={series}
      xfmt={d.axis.xfmt}
      xticks={d.axis.xticks}
      markers={markers(d.policyEvents)}
      height={height}
      yfmt={yfmt}
      zero={zero}
      area={area}
      onClick={(x) =>{  d.setCursor(x); }}
    />
  )
}

export const markers = (events: { tick: number; note: string; patch: Record<string, unknown> }[]) =>
  events.map((e) => ({ x: e.tick, label: e.note || Object.keys(e.patch).join(", ") }))

export function OkBadge({
  ok,
  yes = "Yes",
  no = "No",
}: {
  ok: boolean
  yes?: string
  no?: string
}) {
  return <span className={`status ${ok ? "ok" : "no"}`}>{ok ? `✓ ${yes}` : `✕ ${no}`}</span>
}

export function Level({ v }: { v: number }) {
  return (
    <span className="level">
      <i style={{ width: `${v * 100}%` }} />
    </span>
  )
}

export function Loading({ what = "Loading…" }: { what?: string }) {
  return <div className="empty">{what}</div>
}

export function ErrorCard({ error }: { error: string }) {
  return <div className="card">Error: {error}</div>
}

/** Sortable table header cell. */
export function Th<K extends string>({
  k,
  label,
  num,
  sort,
  setSort,
}: {
  k: K
  label: string
  num?: boolean
  sort: K
  setSort: (k: K) => void
}) {
  return (
    <th
      className={num ? "num" : undefined}
      onClick={() =>{  setSort(k); }}
      style={{ cursor: "pointer" }}
    >
      {label}
      {sort === k ? " ▾" : ""}
    </th>
  )
}
