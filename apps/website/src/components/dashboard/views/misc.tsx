"use client"

import { useState } from "react"
import { type EventsResponse, type LedgerResponse, useApi } from "../api"
import { Card, ErrorCard, Loading } from "../common"
import { fmtMoney, fmtNum, fmtYearBC } from "../format"
import { useDash } from "../state"

// ------------------------------------------------------------------ LEDGER
const PAGE = 300

export function LedgerView() {
  const d = useDash()
  const last = Math.max(0, d.head - 1)
  const [q, setQ] = useState({ from: d.cursor, to: d.cursor, account: "", kind: "", offset: 0 })
  const [form, setForm] = useState(q)
  const params = new URLSearchParams({
    from: String(Math.min(q.from, last)),
    to: String(Math.min(q.to, last)),
    account: q.account,
    kind: q.kind,
    limit: String(PAGE),
    offset: String(q.offset),
    v: String(d.version),
  })
  const r = useApi<LedgerResponse>(`/api/timelines/${d.tid}/ledger?${params.toString()}`)
  const csv = () => {
    if (!r.data) return
    const body = r.data.rows
      .map((x) =>
        [x.tick, x.src, x.dst, x.kind, x.amount]
          .map((v) => `"${String(v).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n")
    const a = document.createElement("a")
    a.href = URL.createObjectURL(
      new Blob([`tick,from,to,kind,amount\n${body}`], { type: "text/csv" }),
    )
    a.download = `ledger_${d.tid}_${q.from}-${q.to}.csv`
    a.click()
  }
  return (
    <>
      <h1>Ledger</h1>
      <p className="lead">
        Every payment, stored in SQLite: wages, purchases, taxes, transfers, loans, interest,
        dividends, imports and exports. Large firm-level flows keep the firm&apos;s name; small ones
        are rolled up into sector accounts. Accounts:{" "}
        <span className="pill">hh:&lt;region&gt;</span> households,{" "}
        <span className="pill">gov</span>, <span className="pill">bank</span>,{" "}
        <span className="pill">row</span> rest of world,{" "}
        <span className="pill">firm:&lt;id&gt;</span>,{" "}
        <span className="pill">sector:&lt;name&gt;</span>,{" "}
        <span className="pill">market:&lt;sector&gt;</span>.
      </p>
      <div className="card">
        <div className="toolbar">
          <label>
            From month{" "}
            <input
              aria-label="From month"
              type="number"
              value={form.from}
              min={0}
              max={last}
              style={{ width: 80 }}
              onChange={(e) => {
                setForm({ ...form, from: Number(e.target.value) })
              }}
            />
          </label>
          <label>
            to{" "}
            <input
              aria-label="To month"
              type="number"
              value={form.to}
              min={0}
              max={last}
              style={{ width: 80 }}
              onChange={(e) => {
                setForm({ ...form, to: Number(e.target.value) })
              }}
            />
          </label>
          <label>
            Account{" "}
            <input
              aria-label="Account"
              type="text"
              value={form.account}
              placeholder="e.g. gov, hh, firm:12"
              style={{ width: 150 }}
              onChange={(e) => {
                setForm({ ...form, account: e.target.value.trim() })
              }}
            />
          </label>
          <label>
            Kind{" "}
            <select
              value={form.kind}
              onChange={(e) => {
                setForm({ ...form, kind: e.target.value })
              }}
            >
              <option value="">all</option>
              {(r.data?.kinds ?? []).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary small"
            onClick={() => {
              setQ({ ...form, offset: 0 })
            }}
          >
            Query
          </button>
          <button type="button" className="small" onClick={csv}>
            Download CSV
          </button>
          {r.data && (
            <span className="muted">
              {fmtNum(r.data.total)} entries · showing {q.offset + 1}–
              {Math.min(r.data.total, q.offset + PAGE)}
            </span>
          )}
          <button
            type="button"
            className="small"
            disabled={!q.offset}
            onClick={() => {
              setQ({ ...q, offset: Math.max(0, q.offset - PAGE) })
            }}
          >
            ‹
          </button>
          <button
            type="button"
            className="small"
            disabled={!r.data || q.offset + PAGE >= r.data.total}
            onClick={() => {
              setQ({ ...q, offset: q.offset + PAGE })
            }}
          >
            ›
          </button>
        </div>
        {r.error ? (
          <ErrorCard error={r.error} />
        ) : !r.data ? (
          <Loading />
        ) : (
          <div className="scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Kind</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {r.data.rows.map((x, i) => (
                  <tr key={`${x.tick}-${x.src}-${x.dst}-${x.kind}-${i}`}>
                    <td>{d.axis.tickLabel(x.tick)}</td>
                    <td title={x.src}>{r.data?.labels[x.src] ?? x.src}</td>
                    <td title={x.dst}>{r.data?.labels[x.dst] ?? x.dst}</td>
                    <td>{x.kind}</td>
                    <td className="num">{fmtMoney(x.amount, 4)}</td>
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

// ------------------------------------------------------------------ EVENTS
const EV_KINDS = [
  "policy",
  "invention",
  "knowledge",
  "rd",
  "entry",
  "bankruptcy",
  "technology",
  "trade",
  "research",
  "resource",
  "info",
]

export function EventsView() {
  const d = useDash()
  const [kinds, setKinds] = useState<string[]>([])
  const [search, setSearch] = useState("")
  const [draft, setDraft] = useState("")
  const params = new URLSearchParams({
    to: String(d.cursor),
    kinds: kinds.join(","),
    search,
    limit: "500",
    v: String(d.version),
  })
  const r = useApi<EventsResponse>(`/api/timelines/${d.tid}/events?${params.toString()}`)
  return (
    <>
      <h1>What happened</h1>
      <p className="lead">
        Inventions, failed experiments, start-ups, bankruptcies, technology switches and policy
        decisions up to {d.axis.tickLabel(d.cursor)}.
      </p>
      <div className="card">
        <div className="toolbar">
          {EV_KINDS.map((k) => (
            <button
              type="button"
              key={k}
              className={`chip ${kinds.includes(k) ? "ok" : ""}`}
              onClick={() => {
                setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])
              }}
            >
              {k}
            </button>
          ))}
          <input
            type="text"
            aria-label="Search events"
            placeholder="Search…"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
            }}
            onBlur={() => {
              setSearch(draft)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") setSearch(draft)
            }}
          />
        </div>
        {r.error ? (
          <ErrorCard error={r.error} />
        ) : !r.data ? (
          <Loading />
        ) : r.data.events.length ? (
          r.data.events.map((e, i) => {
            const good = typeof e.data.good === "string" ? e.data.good : null
            return (
              <div className="event" key={`${e.tick}-${i}`}>
                <span className="when">{d.axis.tickLabel(e.tick)}</span>
                <span className="kind">
                  <span className="pill">{e.kind}</span>
                </span>
                <span>
                  {e.text}
                  {good && (
                    <>
                      {" "}
                      <a
                        href="#product"
                        onClick={(ev) => {
                          ev.preventDefault()
                          d.go("product", good)
                        }}
                      >
                        →
                      </a>
                    </>
                  )}
                </span>
              </div>
            )
          })
        ) : (
          <div className="muted">No events.</div>
        )}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ CATALOG
export function CatalogView() {
  const d = useDash()
  const [q, setQ] = useState("")
  const [cat, setCat] = useState("")
  const cats = [...new Set(d.catalog.goods.map((g) => g.cat))].toSorted()
  const sm = d.meta.summary
  const list = d.catalog.goods
    .filter(
      (g) => (!q || g.name.toLowerCase().includes(q.toLowerCase())) && (!cat || g.cat === cat),
    )
    .toSorted((a, b) => a.year - b.year)
  return (
    <>
      <h1>Catalog of everything</h1>
      <p className="lead">
        {sm.goods} goods and services, {sm.processes} production processes, {sm.knowledge} knowledge
        nodes and {sm.occupations} occupations. Each product is a structured engineering object:
        inputs (with substitutes), equipment, precision tolerance, cleanroom class, energy, skills
        and knowledge. The year shown is when the world could first make it - derived from its whole
        supply chain, not typed in.
      </p>
      <div className="card">
        <div className="toolbar">
          <input
            type="text"
            aria-label="Search catalog"
            placeholder="Search…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
            }}
          />
          <select
            aria-label="Category"
            value={cat}
            onChange={(e) => {
              setCat(e.target.value)
            }}
          >
            <option value="">All categories</option>
            {cats.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th className="num">World since</th>
                <th className="num">2025 world price</th>
                <th>Unit</th>
                <th className="num">Tolerance</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {list.map((g) => (
                <tr
                  key={g.id}
                  className="clickable"
                  onClick={() => {
                    d.go("product", g.id)
                  }}
                >
                  <td>{g.name}</td>
                  <td>{g.cat}</td>
                  <td className="num">{fmtYearBC(g.year)}</td>
                  <td className="num">{fmtMoney(g.price)}</td>
                  <td>{g.unit}</td>
                  <td className="num">{g.tol ? `${g.tol} µm` : ""}</td>
                  <td>
                    {[
                      g.need ? `consumer: ${d.meta.needs[g.need] ?? g.need}` : "",
                      g.capital ? "capital good" : "",
                      g.svc ? "service" : "",
                      g.clean ? "cleanroom" : "",
                      g.restricted ? "export-controlled" : "",
                      g.nt ? "non-tradable" : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ ABOUT
export function AboutView() {
  const d = useDash()
  return (
    <>
      <h1>How the simulation works</h1>
      <Card style={{ maxWidth: 960 }}>
        <p>
          Outcomes are meant to <b>emerge</b> from constraints on materials, energy, labor,
          knowledge, geography and institutions - nothing says &quot;region X is good at Y&quot;.
        </p>
        <h3>Three engines</h3>
        <p>
          <b>Physical.</b> Every good is made by a process: inputs (with substitutes), primary and
          auxiliary equipment, labor by occupation, knowledge, tolerance (µm) and cleanroom class.
          Output is limited by equipment, the site (deposit grade and depletion, crop suitability
          from temperature and rainfall, solar/wind/hydro potential), workers and inputs. Yield
          falls when the maker&apos;s machines are less precise than the product&apos;s tolerance;
          precision-critical goods need cleanrooms. Machines are themselves products, so precision
          has to be built up: hand tools → lathes → grinders → CNC → ultra-precision machines →
          lithography steppers.
        </p>
        <p>
          <b>Economic &amp; social.</b> Thousands of agents (each a group of people) age, study,
          work, move, have children and die. Firms hire in a matching labor market, set cost-plus
          prices that respond to inventories, invest when demand and profits justify it, borrow from
          a bank, export when competitive, and go bankrupt. Households spend by need (Engel curves
          shift spending from food to services as incomes rise). The government taxes, buys schools,
          hospitals, research, administration and infrastructure, pays benefits and borrows. A
          central bank follows a Taylor rule; the currency floats with the current account and
          relative inflation.
        </p>
        <p>
          <b>Knowledge &amp; invention.</b> {d.meta.summary.knowledge} knowledge nodes with
          prerequisites. Understanding, reproducing, manufacturing economically and improving are
          separate achievements: national science (research, literature absorption that needs an
          educated workforce, learning by doing, forgetting), firm designs (uncertain R&amp;D with
          inconclusive months, setbacks, prototype failures when inputs or precision are missing,
          reverse engineering limited by how opaque the product is), learning curves (Wright&apos;s
          law) and design generations that can overtake the world frontier.
        </p>
        <h3>Rewinding</h3>
        <p>
          The full state is snapshotted every year into SQLite; the simulation is deterministic, so
          any month can be reconstructed by replay. A decision at a past month creates a branch that
          shares history up to that point.
        </p>
        <h3>Honest limits</h3>
        <p>
          This is selective approximation, not physics: labor hours and equipment throughput are
          calibrated so processes cover their costs at 2025 world prices; the rest of the world is
          an exogenous frontier whose prices fall after each technology&apos;s introduction; finance
          is a single bank. Long runs show business cycles and can drift. Use it to explore
          mechanisms and trade-offs, not to forecast.
        </p>
      </Card>
    </>
  )
}
