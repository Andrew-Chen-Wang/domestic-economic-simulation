"use client"

import { useRef } from "react"
import { api, post, type TimelineInfo } from "../api"
import { useWidth } from "../charts"
import { useDash } from "../state"

export function TimelinesView() {
  const d = useDash()
  const ax = d.axis
  const host = useRef<HTMLDivElement>(null)
  const kids = new Map<number, TimelineInfo[]>()
  for (const t of d.timelines) {
    const p = t.parent_id ?? 0
    kids.set(p, [...(kids.get(p) ?? []), t])
  }
  const rows: [TimelineInfo, number][] = []
  const walk = (pid: number, depth: number) => {
    for (const t of kids.get(pid) ?? []) {
      rows.push([t, depth])
      walk(t.id, depth + 1)
    }
  }
  walk(0, 0)
  const maxHead = Math.max(12, ...d.timelines.map((t) => t.head_tick))
  const W = Math.max(500, useWidth(host, 900) - 32)
  const rowH = 30
  const H = rows.length * rowH + 30
  const L = 220
  const X = (t: number) => L + (t / maxHead) * (W - L - 20)
  const yearTicks: number[] = []
  for (let yr = 0; yr <= maxHead; yr += maxHead > 240 ? 60 : 12) yearTicks.push(yr)

  const view = async (id: number) => {
    await d.selectTimeline(id)
    d.go("overview")
  }
  const rename = async (id: number) => {
    const n = prompt("New name?")
    if (!n) return
    await post(`/api/timelines/${id}/rename`, { name: n })
    await d.loadTimelines()
  }
  const del = async (id: number) => {
    if (!confirm("Delete this timeline and all its branches? This cannot be undone.")) return
    try {
      await api(`/api/timelines/${id}`, { method: "DELETE" })
      const tls = await d.loadTimelines()
      if (!tls.some((x) => x.id === d.tid) && tls.length) await d.selectTimeline(tls[0].id)
      else if (!tls.length) window.location.reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <h1>Timelines &amp; branches</h1>
      <p className="lead">
        Every rewind creates a branch that shares history up to the moment you changed your mind.
        Bars span the months each branch has simulated; dots are policy decisions. Select a branch
        to view it, or compare two on the Overview.
      </p>
      <div className="card tree" ref={host}>
        <svg width={W} height={H}>
          {rows.map(([t, depth], i) => {
            const y = 20 + i * rowH
            const x0 = X(t.parent_id ? t.fork_tick : 0)
            const x1 = X(t.head_tick)
            const py = t.parent_id ? 20 + rows.findIndex(([p]) => p.id === t.parent_id) * rowH : 0
            return (
              <g key={t.id}>
                {t.parent_id !== null && (
                  <path
                    d={`M${x0},${py} L${x0},${y}`}
                    className="branch-line"
                    fill="none"
                    strokeDasharray="3 3"
                  />
                )}
                <text x={8 + depth * 12} y={y + 4}>
                  {t.name.slice(0, 30)}
                </text>
                <rect
                  x={x0}
                  y={y - 5}
                  width={Math.max(2, x1 - x0)}
                  height={10}
                  rx={5}
                  fill={t.id === d.tid ? "var(--series-1)" : "var(--series-3)"}
                  style={{ cursor: "pointer" }}
                  onClick={() => void view(t.id)}
                />
                {t.policy_events.map((e) => (
                  <circle
                    key={e.id}
                    cx={X(e.tick)}
                    cy={y}
                    r={5}
                    fill="var(--series-2)"
                    stroke="var(--surface-1)"
                    strokeWidth={2}
                  >
                    <title>{e.note || JSON.stringify(e.patch)}</title>
                  </circle>
                ))}
              </g>
            )
          })}
          {yearTicks.map((yr) => (
            <text
              key={yr}
              x={X(yr)}
              y={H - 4}
              textAnchor="middle"
              style={{ fill: "var(--text-muted)", fontSize: 11 }}
            >
              {ax.xfmt(yr)}
            </text>
          ))}
        </svg>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Scenario</th>
              <th>Branched from</th>
              <th className="num">Months</th>
              <th>Decisions</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([t, depth]) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td
                  style={{
                    paddingLeft: 6 + depth * 16,
                    fontWeight: t.id === d.tid ? 700 : undefined,
                  }}
                >
                  {t.name}
                </td>
                <td>{d.meta.scenarios[t.scenario]?.label ?? t.scenario}</td>
                <td>{t.parent_id ? `#${t.parent_id} @ month ${t.fork_tick}` : "—"}</td>
                <td className="num">{t.head_tick}</td>
                <td>{t.policy_events.length}</td>
                <td>
                  <button type="button" className="small" onClick={() => void view(t.id)}>
                    View
                  </button>{" "}
                  <button type="button" className="small" onClick={() => void rename(t.id)}>
                    Rename
                  </button>{" "}
                  <button type="button" className="small" onClick={() => void del(t.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
