"use client"

/**
 * SVG charts for the dashboard (no chart library). Every chart has a hover layer; colors come
 * from CSS custom properties so light and dark themes are both validated palettes.
 */
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { fmtMoney, fmtNum, fmtPct } from "./format"

export const seriesColor = (i: number) => `var(--series-${(i % 8) + 1})`

// ---------------------------------------------------------------- tooltip
type Tip = { content: ReactNode; x: number; y: number } | null
const TipCtx = createContext<(t: Tip) => void>(() => undefined)

export function TipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<Tip>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    if (!tip || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    let left = tip.x + 14
    let top = tip.y + 14
    if (left + r.width > window.innerWidth - 8) left = tip.x - r.width - 14
    if (top + r.height > window.innerHeight - 8) top = tip.y - r.height - 14
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [tip])
  return (
    <TipCtx.Provider value={setTip}>
      {children}
      {tip && (
        <div
          ref={ref}
          className="viz-tip"
          style={{ display: "block", left: pos.left, top: pos.top }}
        >
          {tip.content}
        </div>
      )}
    </TipCtx.Provider>
  )
}

export function useTip() {
  const set = useContext(TipCtx)
  return {
    show: (content: ReactNode, ev: MouseEvent) =>{  set({ content, x: ev.clientX, y: ev.clientY }); },
    hide: () =>{  set(null); },
  }
}

export const TipHead = ({ children }: { children: ReactNode }) => (
  <div className="tip-h">{children}</div>
)
export function TipRow({
  label,
  value,
  color,
}: {
  label: ReactNode
  value: ReactNode
  color?: string
}) {
  return (
    <div className="tip-row">
      {color && <span className="sw" style={{ background: color }} />}
      {label}
      <b>{value}</b>
    </div>
  )
}

// ---------------------------------------------------------------- sizing
export function useWidth(ref: RefObject<HTMLElement | null>, fallback = 600): number {
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth || fallback)
    const ro = new ResizeObserver(() =>{  setW(el.clientWidth || fallback); })
    ro.observe(el)
    return () =>{  ro.disconnect(); }
  }, [ref, fallback])
  return w
}

function niceTicks(lo: number, hi0: number, n = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi0)) return [0]
  const hi = hi0 === lo ? lo + 1 : hi0
  const span = hi - lo
  const mag = 10 ** Math.floor(Math.log10(span / n))
  const steps = [1, 2, 2.5, 5, 10].map((m) => m * mag)
  const step = steps.find((s) => span / s <= n) ?? steps[steps.length - 1]
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step)
    out.push(Number(v.toPrecision(12)))
  return out
}

type Fmt = (v: number) => string
type XTicks = (x0: number, x1: number, n: number) => number[]
const M = { l: 56, r: 14, t: 12, b: 26 }

export function Legend({ items }: { items: { name: string; color: string; dash?: string }[] }) {
  return (
    <div className="viz-legend">
      {items.map((it) => (
        <span key={it.name}>
          <i style={{ background: it.color, opacity: it.dash ? 0.6 : 1 }} />
          {it.name}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- line chart
export interface LineSeries {
  name: string
  points: [number, number | null][]
  color?: string
  dash?: string
}

export interface LineChartProps {
  series: LineSeries[]
  height?: number
  xfmt?: Fmt
  yfmt?: Fmt
  xticks?: XTicks
  markers?: { x: number; label: string }[]
  /** include zero on the y axis (default true) */
  zero?: boolean
  area?: boolean
  onClick?: (x: number) => void
}

const finitePts = (s: LineSeries) =>
  s.points.filter((p): p is [number, number] => p[1] !== null && Number.isFinite(p[1]))

export function LineChart(props: LineChartProps) {
  const { series, height = 220, yfmt = fmtNum, xfmt = String, markers = [], zero = true } = props
  const ref = useRef<HTMLDivElement>(null)
  const w = Math.max(240, useWidth(ref))
  const h = height
  const tip = useTip()
  const [hover, setHover] = useState<{ x: number; pts: ([number, number] | null)[] } | null>(null)
  const clean = series.map(finitePts)
  const all = clean.flat()
  if (!all.length)
    return (
      <div ref={ref}>
        <svg className="viz" width={w} height={h}>
          <text x={w / 2} y={h / 2} textAnchor="middle" className="viz-empty">
            No data yet - run the simulation
          </text>
        </svg>
      </div>
    )
  const x0 = Math.min(...all.map((p) => p[0]))
  let x1 = Math.max(...all.map((p) => p[0]))
  if (x0 === x1) x1 = x0 + 1
  let y0 = Math.min(...all.map((p) => p[1]))
  let y1 = Math.max(...all.map((p) => p[1]))
  if (zero && y0 > 0) y0 = 0
  if (y0 === y1) y1 = y0 + Math.abs(y0 || 1) * 0.1
  const pad = (y1 - y0) * 0.06
  y1 += pad
  if (y0 < 0 || !zero) y0 -= pad
  const X = (x: number) => M.l + ((x - x0) / (x1 - x0)) * (w - M.l - M.r)
  const Y = (y: number) => h - M.b - ((y - y0) / (y1 - y0)) * (h - M.t - M.b)
  const color = (i: number) => series[i].color ?? seriesColor(i)
  const n = Math.max(2, Math.floor(w / 90))
  const xt = props.xticks ? props.xticks(x0, x1, n) : niceTicks(x0, x1, n)
  const xAt = (ev: MouseEvent<SVGRectElement>) => {
    const r = ev.currentTarget.ownerSVGElement?.getBoundingClientRect()
    return x0 + ((ev.clientX - (r?.left ?? 0) - M.l) / (w - M.l - M.r)) * (x1 - x0)
  }
  const onMove = (ev: MouseEvent<SVGRectElement>) => {
    const xv = xAt(ev)
    const near = clean.map((pts) => {
      let best: [number, number] | null = null
      for (const p of pts)
        if (best === null || Math.abs(p[0] - xv) < Math.abs(best[0] - xv)) best = p
      return best
    })
    const xs = near.find((p) => p !== null)?.[0]
    if (xs === undefined) return
    setHover({ x: xs, pts: near })
    tip.show(
      <>
        <TipHead>{xfmt(xs)}</TipHead>
        {near.map((p, i) =>
          p ? (
            <TipRow
              key={series[i].name}
              label={series[i].name}
              value={yfmt(p[1])}
              color={color(i)}
            />
          ) : null,
        )}
      </>,
      ev,
    )
  }
  return (
    <div ref={ref}>
      <svg className="viz" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <g className="viz-grid">
          {niceTicks(y0, y1, 4).map((t) => (
            <line key={t} x1={M.l} x2={w - M.r} y1={Y(t)} y2={Y(t)} />
          ))}
        </g>
        {niceTicks(y0, y1, 4).map((t) => (
          <text key={t} x={M.l - 6} y={Y(t) + 4} textAnchor="end" className="viz-axis">
            {yfmt(t)}
          </text>
        ))}
        {xt.map((t) => (
          <text key={t} x={X(t)} y={h - 8} textAnchor="middle" className="viz-axis">
            {xfmt(t)}
          </text>
        ))}
        {y0 < 0 && y1 > 0 && (
          <line x1={M.l} x2={w - M.r} y1={Y(0)} y2={Y(0)} className="viz-zero" />
        )}
        {clean.map((pts, i) => {
          if (!pts.length) return null
          const d = pts
            .map((p, j) => `${j ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`)
            .join("")
          const base = Y(Math.max(y0, 0))
          return (
            <g key={series[i].name}>
              {props.area && series.length === 1 && (
                <path
                  d={`${d}L${X(pts[pts.length - 1][0])},${base}L${X(pts[0][0])},${base}Z`}
                  fill={color(i)}
                  opacity={0.12}
                />
              )}
              <path
                d={d}
                fill="none"
                stroke={color(i)}
                strokeWidth={2}
                strokeDasharray={series[i].dash}
                strokeLinejoin="round"
              />
            </g>
          )
        })}
        {hover && (
          <>
            <line x1={X(hover.x)} x2={X(hover.x)} y1={M.t} y2={h - M.b} className="viz-cross" />
            {hover.pts.map((p, i) =>
              p ? (
                <circle
                  key={series[i].name}
                  cx={X(p[0])}
                  cy={Y(p[1])}
                  r={4}
                  fill={color(i)}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              ) : null,
            )}
          </>
        )}
        <rect
          x={M.l}
          y={M.t}
          width={w - M.l - M.r}
          height={h - M.t - M.b}
          fill="transparent"
          style={{ cursor: props.onClick ? "pointer" : undefined }}
          onMouseMove={onMove}
          onMouseLeave={() => {
            setHover(null)
            tip.hide()
          }}
          onClick={(ev) => props.onClick?.(xAt(ev))}
        />
        {markers
          .filter((mk) => mk.x >= x0 && mk.x <= x1)
          .map((mk, i) => (
            <g key={`${mk.x}-${i}`}>
              <line
                x1={X(mk.x)}
                x2={X(mk.x)}
                y1={M.t}
                y2={h - M.b}
                className="viz-marker"
                pointerEvents="none"
              />
              <rect
                x={X(mk.x) - 5}
                y={M.t}
                width={10}
                height={h - M.t - M.b}
                fill="transparent"
                onMouseMove={(ev) =>{ 
                  tip.show(
                    <>
                      <TipHead>{xfmt(mk.x)}</TipHead>
                      {mk.label}
                    </>,
                    ev,
                  ); }
                }
                onMouseLeave={tip.hide}
              />
            </g>
          ))}
      </svg>
      {series.length > 1 && (
        <Legend items={series.map((s, i) => ({ name: s.name, color: color(i), dash: s.dash }))} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- stacked area
export function StackedArea(props: {
  x: number[]
  series: { name: string; values: number[]; color?: string }[]
  height?: number
  xfmt?: Fmt
  yfmt?: Fmt
  xticks?: XTicks
}) {
  const { x: xs, series, height = 240, yfmt = fmtNum, xfmt = String } = props
  const ref = useRef<HTMLDivElement>(null)
  const w = Math.max(240, useWidth(ref))
  const h = height
  const tip = useTip()
  const [hi, setHi] = useState<number | null>(null)
  const n = xs.length
  if (!n) return <div ref={ref} />
  const tops = new Array<number>(n).fill(0)
  const layers = series.map((s) =>
    s.values.map((v, i) => {
      const b = tops[i]
      tops[i] += Math.max(0, v || 0)
      return [b, tops[i]] as const
    }),
  )
  const y1 = Math.max(...tops) * 1.05 || 1
  const x0 = xs[0]
  const x1 = xs[n - 1] === x0 ? x0 + 1 : xs[n - 1]
  const X = (x: number) => M.l + ((x - x0) / (x1 - x0)) * (w - M.l - M.r)
  const Y = (y: number) => h - M.b - (y / y1) * (h - M.t - M.b)
  const color = (k: number) => series[k].color ?? seriesColor(k)
  const nt = Math.max(2, Math.floor(w / 90))
  const xt = props.xticks ? props.xticks(x0, x1, nt) : niceTicks(x0, x1, nt)
  return (
    <div ref={ref}>
      <svg className="viz" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <g className="viz-grid">
          {niceTicks(0, y1, 4).map((t) => (
            <line key={t} x1={M.l} x2={w - M.r} y1={Y(t)} y2={Y(t)} />
          ))}
        </g>
        {niceTicks(0, y1, 4).map((t) => (
          <text key={t} x={M.l - 6} y={Y(t) + 4} textAnchor="end" className="viz-axis">
            {yfmt(t)}
          </text>
        ))}
        {xt.map((t) => (
          <text key={t} x={X(t)} y={h - 8} textAnchor="middle" className="viz-axis">
            {xfmt(t)}
          </text>
        ))}
        {layers.map((L, k) => {
          let d = ""
          for (let i = 0; i < n; i++) d += `${i ? "L" : "M"}${X(xs[i])},${Y(L[i][1])}`
          for (let i = n - 1; i >= 0; i--) d += `L${X(xs[i])},${Y(L[i][0])}`
          return (
            <path
              key={series[k].name}
              d={`${d}Z`}
              fill={color(k)}
              stroke="var(--surface-1)"
              strokeWidth={1}
            />
          )
        })}
        {hi !== null && (
          <line x1={X(xs[hi])} x2={X(xs[hi])} y1={M.t} y2={h - M.b} className="viz-cross" />
        )}
        <rect
          x={M.l}
          y={M.t}
          width={w - M.l - M.r}
          height={h - M.t - M.b}
          fill="transparent"
          onMouseMove={(ev) => {
            const r = ev.currentTarget.ownerSVGElement?.getBoundingClientRect()
            const xv = x0 + ((ev.clientX - (r?.left ?? 0) - M.l) / (w - M.l - M.r)) * (x1 - x0)
            let i = 0
            for (let j = 0; j < n; j++) if (Math.abs(xs[j] - xv) < Math.abs(xs[i] - xv)) i = j
            setHi(i)
            tip.show(
              <>
                <TipHead>{xfmt(xs[i])}</TipHead>
                {series
                  .map((s, k) => (
                    <TipRow
                      key={s.name}
                      label={s.name}
                      value={yfmt(s.values[i])}
                      color={color(k)}
                    />
                  ))
                  .toReversed()}
                <TipRow label="Total" value={yfmt(tops[i])} />
              </>,
              ev,
            )
          }}
          onMouseLeave={() => {
            setHi(null)
            tip.hide()
          }}
        />
      </svg>
      <Legend items={series.map((s, k) => ({ name: s.name, color: color(k) }))} />
    </div>
  )
}

// ---------------------------------------------------------------- horizontal bars
export interface BarItem {
  label: string
  value: number
  color?: string
  tip?: ReactNode
  onClick?: () => void
}

export function BarList({ items, fmt = fmtNum }: { items: BarItem[]; fmt?: Fmt }) {
  const tip = useTip()
  const max = Math.max(...items.map((d) => Math.abs(d.value)), 1e-12)
  return (
    <div className="barlist">
      {items.map((d) => (
        // oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
        <div
          key={d.label}
          className={`bar-row${d.onClick ? " clickable" : ""}`}
          onMouseMove={(ev) =>{ 
            tip.show(
              <>
                <TipHead>{d.label}</TipHead>
                {d.tip ?? fmt(d.value)}
              </>,
              ev,
            ); }
          }
          onMouseLeave={tip.hide}
          onClick={d.onClick}
        >
          <div className="bar-label" title={d.label}>
            {d.label}
          </div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${((Math.abs(d.value) / max) * 100).toFixed(2)}%`,
                background: d.color ?? "var(--series-1)",
              }}
            />
          </div>
          <div className="bar-val">{fmt(d.value)}</div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- treemap (squarified)
export function Treemap({
  items,
  height = 300,
  fmt = fmtMoney,
}: {
  items: BarItem[]
  height?: number
  fmt?: Fmt
}) {
  const ref = useRef<HTMLDivElement>(null)
  const w = Math.max(240, useWidth(ref))
  const h = height
  const tip = useTip()
  const data = items.filter((d) => d.value > 0).toSorted((a, b) => b.value - a.value)
  const total = data.reduce((s, d) => s + d.value, 0)
  const rects: [BarItem, number, number, number, number][] = []
  if (total > 0) {
    const scale = (w * h) / total
    const worst = (row: number[], side: number) => {
      const s = row.reduce((a, b) => a + b, 0) * scale
      const mx = Math.max(...row) * scale
      const mn = Math.min(...row) * scale
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn))
    }
    let x = 0
    let y = 0
    let W = w
    let H = h
    let rest = data.slice()
    while (rest.length) {
      const side = Math.min(W, H)
      const row = [rest[0]]
      let i = 1
      while (
        i < rest.length &&
        worst(
          [...row, rest[i]].map((d) => d.value),
          side,
        ) <=
          worst(
            row.map((d) => d.value),
            side,
          )
      ) {
        row.push(rest[i])
        i++
      }
      const sum = row.reduce((a, d) => a + d.value, 0) * scale
      if (W >= H) {
        const cw = sum / H
        let yy = y
        for (const d of row) {
          const ch = (d.value * scale) / cw
          rects.push([d, x, yy, cw, ch])
          yy += ch
        }
        x += cw
        W -= cw
      } else {
        const ch = sum / W
        let xx = x
        for (const d of row) {
          const cw = (d.value * scale) / ch
          rects.push([d, xx, y, cw, ch])
          xx += cw
        }
        y += ch
        H -= ch
      }
      rest = rest.slice(i)
    }
  }
  return (
    <div ref={ref}>
      <svg className="viz" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {rects.map(([d, rx, ry, rw, rh], k) => (
          <g
            key={d.label}
            style={{ cursor: d.onClick ? "pointer" : undefined }}
            onClick={d.onClick}
            onMouseMove={(ev) =>{ 
              tip.show(
                <>
                  <TipHead>{d.label}</TipHead>
                  {fmt(d.value)} · {fmtPct(d.value / total)}
                  {d.tip}
                </>,
                ev,
              ); }
            }
            onMouseLeave={tip.hide}
          >
            <rect
              x={rx + 1}
              y={ry + 1}
              width={Math.max(0, rw - 2)}
              height={Math.max(0, rh - 2)}
              rx={3}
              fill={d.color ?? seriesColor(k)}
            />
            {rw > 70 && rh > 30 && (
              <>
                <text x={rx + 7} y={ry + 17} className="tm-label">
                  {d.label.length > rw / 7 ? `${d.label.slice(0, Math.floor(rw / 7))}…` : d.label}
                </text>
                <text x={rx + 7} y={ry + 33} className="tm-value">
                  {fmt(d.value)}
                </text>
              </>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------- money flow (bipartite sankey)
export interface FlowLink {
  source: string
  target: string
  value: number
  kinds: Record<string, number>
}

export function MoneyFlow({
  links,
  height = 520,
  color = (_n: string, i: number) => seriesColor(i),
  per,
}: {
  links: FlowLink[]
  height?: number
  color?: (name: string, i: number) => string
  per?: (v: number) => ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const w = Math.max(240, useWidth(ref))
  const h = height
  const tip = useTip()
  const [hot, setHot] = useState<number | null>(null)
  const L: Record<string, number> = {}
  const R: Record<string, number> = {}
  for (const k of links) {
    L[k.source] = (L[k.source] ?? 0) + k.value
    R[k.target] = (R[k.target] ?? 0) + k.value
  }
  const total = Object.values(L).reduce((a, b) => a + b, 0)
  if (!total)
    return (
      <div ref={ref}>
        <svg className="viz" width={w} height={h}>
          <text x={w / 2} y={h / 2} textAnchor="middle" className="viz-empty">
            No flows recorded in this window
          </text>
        </svg>
      </div>
    )
  const names = [...new Set([...Object.keys(L), ...Object.keys(R)])].toSorted(
    (a, b) => (L[b] ?? 0) + (R[b] ?? 0) - ((L[a] ?? 0) + (R[a] ?? 0)),
  )
  const idx = Object.fromEntries(names.map((n, i) => [n, i]))
  const gap = 6
  const nodeW = 14
  const labelW = Math.min(170, w * 0.22)
  const lx = labelW
  const rx = w - labelW - nodeW
  const layout = (side: Record<string, number>) => {
    const keys = names.filter((n) => side[n])
    const usable = h - gap * (keys.length - 1) - 10
    let y = 5
    const pos: Record<string, { y: number; h: number; used: number }> = {}
    for (const k of keys) {
      const hh = Math.max(2, (side[k] / total) * usable)
      pos[k] = { y, h: hh, used: 0 }
      y += hh + gap
    }
    return [pos, usable] as const
  }
  const [PL, usableL] = layout(L)
  const [PR, usableR] = layout(R)
  const paths = links
    .slice()
    .toSorted((a, b) => idx[a.target] - idx[b.target])
    .map((k) => {
      const a = PL[k.source]
      const b = PR[k.target]
      const th1 = (k.value / total) * usableL
      const th2 = (k.value / total) * usableR
      const y1 = a.y + a.used + th1 / 2
      const y2 = b.y + b.used + th2 / 2
      a.used += th1
      b.used += th2
      const x1 = lx + nodeW
      const x2 = rx
      const cx = (x1 + x2) / 2
      return {
        k,
        d: `M${x1},${y1}C${cx},${y1} ${cx},${y2} ${x2},${y2}`,
        width: Math.max(1, (th1 + th2) / 2),
      }
    })
  return (
    <div ref={ref}>
      <svg className="viz" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {paths.map(({ k, d, width }, i) => (
          <path
            key={`${k.source}>${k.target}`}
            d={d}
            fill="none"
            stroke={color(k.source, idx[k.source])}
            strokeWidth={width}
            strokeOpacity={hot === i ? 0.75 : 0.35}
            onMouseMove={(ev) => {
              setHot(i)
              tip.show(
                <>
                  <TipHead>
                    {k.source} → {k.target}
                  </TipHead>
                  <TipRow label="Total" value={fmtMoney(k.value)} />
                  {per?.(k.value)}
                  {Object.entries(k.kinds)
                    .toSorted((x, y) => y[1] - x[1])
                    .slice(0, 6)
                    .map(([nm, v]) => (
                      <TipRow key={nm} label={nm} value={fmtMoney(v)} />
                    ))}
                </>,
                ev,
              )
            }}
            onMouseLeave={() => {
              setHot(null)
              tip.hide()
            }}
          />
        ))}
        {(
          [
            [L, PL, lx, "end", lx - 6],
            [R, PR, rx, "start", rx + nodeW + 6],
          ] as const
        ).map(([side, P, x, anchor, tx]) =>
          Object.entries(P).map(([name, p]) => (
            <g key={`${anchor}-${name}`}>
              <rect x={x} y={p.y} width={nodeW} height={p.h} rx={2} fill={color(name, idx[name])} />
              <text
                x={tx}
                y={p.y + Math.min(p.h / 2 + 4, p.h + 10)}
                textAnchor={anchor}
                className="flow-label"
              >
                {name} {fmtMoney(side[name], 2)}
              </text>
            </g>
          )),
        )}
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------- sparkline
export function Sparkline({
  values,
  color = "var(--series-1)",
}: {
  values: (number | null | undefined)[]
  color?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const w = useWidth(ref, 120)
  const h = 28
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x))
  let d = ""
  if (v.length >= 2) {
    const lo = Math.min(...v)
    const hi = Math.max(...v) === lo ? lo + 1 : Math.max(...v)
    d = v
      .map(
        (x, i) =>
          `${i ? "L" : "M"}${((i / (v.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((x - lo) / (hi - lo)) * (h - 6)).toFixed(1)}`,
      )
      .join("")
  }
  return (
    <div ref={ref} className="spark">
      <svg width={w} height={h} className="spark">
        {d && <path d={d} fill="none" stroke={color} strokeWidth={2} />}
      </svg>
    </div>
  )
}
