"use client"

import { useState } from "react"
import { useApi } from "../api"
import { Card, ErrorCard, Level, Loading, TimeChart } from "../common"
import { fmtNum, fmtPct, fmtYearBC } from "../format"
import { useDash } from "../state"

const KSTATUS = ["mastered", "understood", "learning", "known abroad only", "undiscovered"]
const KIND: Record<string, string> = {
  sci: "science",
  eng: "engineering",
  proc: "process know-how",
}

export function KnowledgeView() {
  const d = useDash()
  const r = useApi<{ tick: number | null; data: Record<string, number> | null }>(
    `/api/timelines/${d.tid}/detail/knowledge?tick=${d.cursor + 1}&v=${d.version}`,
  )
  const [field, setField] = useState("")
  const [status, setStatus] = useState("")
  const [order, setOrder] = useState("difficulty")
  if (r.error) return <ErrorCard error={r.error} />
  const K = r.data?.data ?? {}
  const year = d.axis.yearOf(r.data?.tick ?? d.cursor)
  const nodes = d.catalog.knowledge.map((k) => {
    const lv = K[k.id] ?? 0
    const st =
      lv >= 0.95
        ? "mastered"
        : lv >= 0.5
          ? "understood"
          : lv > 0.02
            ? "learning"
            : k.year_eff <= year
              ? "known abroad only"
              : "undiscovered"
    return { ...k, lv, st }
  })
  const fields = [...new Set(nodes.map((n) => n.field))].toSorted()
  const list = nodes
    .filter((n) => (!field || n.field === field) && (!status || n.st === status))
    .toSorted((a, b) =>
      order === "difficulty"
        ? b.technology.score - a.technology.score || a.id.localeCompare(b.id)
        : a.year_eff - b.year_eff,
    )
  return (
    <>
      <h1>Knowledge &amp; invention</h1>
      <p className="lead">
        {nodes.length} pieces of knowledge, from settled agriculture to EUV lithography. Products
        need them at ≥50% to be designed. Science spreads from world literature only if the
        workforce is educated enough to absorb it; process know-how grows by practice and{" "}
        <b>fades when nobody practices it</b>. Research beyond the world frontier is uncertain and
        can hit dead ends. In new simulations, firms also need their own build/test cycles: hiring
        experts helps research, while organizational validation stays with the firm. Difficulty
        scores and cold-start times below are model assumptions, not historical measurements or
        country rankings. Times assume adequate teams, tools and inputs; bottlenecks can make them
        longer. Existing timelines retain their original simulation rules.
      </p>
      <div className="grid g2">
        <Card title="Average knowledge level">
          <TimeChart
            defs={[{ name: "Knowledge index", key: "knowledge_index" }]}
            yfmt={(v) => fmtPct(v, 0)}
            zero={false}
          />
        </Card>
        <Card title="Research effort" sub="person-years per year">
          <TimeChart
            defs={[
              { name: "Public research", key: "research_py" },
              { name: "Business R&D", key: "rd_py", color: "var(--series-2)" },
            ]}
            yfmt={fmtNum}
          />
        </Card>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <div className="toolbar">
          <select
            aria-label="Rank technologies"
            value={order}
            onChange={(event) => {
              setOrder(event.target.value)
            }}
          >
            <option value="difficulty">Hardest to master first</option>
            <option value="year">Earliest first</option>
          </select>
          <select
            aria-label="Field"
            value={field}
            onChange={(e) => {
              setField(e.target.value)
            }}
          >
            <option value="">All fields</option>
            {fields.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
            }}
          >
            <option value="">Any status</option>
            {KSTATUS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        {!r.data ? (
          <Loading />
        ) : (
          <div className="scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Knowledge</th>
                  <th>Kind</th>
                  <th>Field</th>
                  <th className="num">World since</th>
                  <th className="num">Difficulty / 100</th>
                  <th>Cold-start validation</th>
                  <th className="num">Tacit share</th>
                  <th>Domestic level</th>
                  <th>Status</th>
                  <th>Requires</th>
                </tr>
              </thead>
              <tbody>
                {list.map((n) => (
                  <tr key={n.id}>
                    <td>{n.name}</td>
                    <td>{KIND[n.kind]}</td>
                    <td>{n.field}</td>
                    <td className="num">{fmtYearBC(n.year_eff)}</td>
                    <td className="num">{n.technology.score}</td>
                    <td>
                      {n.technology.minimum_mastery_years.toFixed(1)} years minimum
                      <br />
                      <small>
                        {n.technology.mastery_cycles} cycles × {n.technology.cycle_months} months
                      </small>
                    </td>
                    <td className="num">{fmtPct(n.technology.tacit_share, 0)}</td>
                    <td>
                      <Level v={n.lv} /> {fmtPct(n.lv, 0)}
                    </td>
                    <td>{n.st}</td>
                    <td className="muted">
                      {n.prereqs.map((p) => d.by.knowledge[p]?.name ?? p).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
