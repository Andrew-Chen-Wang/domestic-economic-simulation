"use client"

import { useEffect, useRef, useState } from "react"
import { api, type CatalogResponse, type MetaResponse, post } from "./api"
import { TipProvider } from "./charts"
import { fmtNum } from "./format"
import { DashProvider, useDash, type View } from "./state"
import { CatalogView, AboutView, EventsView, LedgerView } from "./views/misc"
import { IndustryView } from "./views/industry"
import { KnowledgeView } from "./views/knowledge"
import { LaborView } from "./views/labor"
import { MoneyView } from "./views/money"
import { Overview } from "./views/overview"
import { PolicyView } from "./views/policy"
import { ProductsView, ProductView } from "./views/products"
import { RegionsView } from "./views/regions"
import { TimelinesView } from "./views/timelines"

const NAV: [View, string][] = [
  ["overview", "Overview"],
  ["policy", "Policy decisions"],
  ["timelines", "Timelines & branches"],
  ["money", "Money flows"],
  ["products", "Products & capabilities"],
  ["industry", "Industry & firms"],
  ["labor", "Labor & education"],
  ["knowledge", "Knowledge & invention"],
  ["regions", "Regions & cities"],
  ["ledger", "Ledger"],
  ["events", "Events"],
  ["catalog", "Catalog"],
  ["about", "How it works"],
]

/** Loads the static metadata and catalog, then mounts the dashboard. */
export function Dashboard() {
  const [boot, setBoot] = useState<{ meta: MetaResponse; catalog: CatalogResponse } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    try {
      const t = localStorage.getItem("theme")
      if (t) document.documentElement.dataset.theme = t
    } catch {
      // storage unavailable (private mode): keep the system theme
    }
    Promise.all([api<MetaResponse>("/api/meta"), api<CatalogResponse>("/api/catalog")])
      .then(([meta, catalog]) => {
        setBoot({ meta, catalog })
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [])
  if (error) return <div className="empty">Failed to start: {error}</div>
  if (!boot) return <div className="empty">Loading…</div>
  return (
    <TipProvider>
      <DashProvider meta={boot.meta} catalog={boot.catalog}>
        <Shell />
      </DashProvider>
    </TipProvider>
  )
}

function Shell() {
  const d = useDash()
  const running = d.job.state === "running"
  const toggleTheme = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark")
    const next = dark ? "light" : "dark"
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem("theme", next)
    } catch {
      // ignore
    }
  }
  const job = d.job
  return (
    <>
      <header className="topbar">
        <div className="brand">Domestic Economy Simulator</div>
        <div className="tl-picker">
          <label htmlFor="tlSelect" className="muted">
            Timeline
          </label>
          <select
            id="tlSelect"
            value={d.tid ?? ""}
            onChange={(e) => void d.selectTimeline(Number(e.target.value))}
          >
            {d.timelines.map((t) => (
              <option key={t.id} value={t.id}>
                {t.parent_id ? "↳ " : ""}
                {t.name} (#{t.id})
              </option>
            ))}
          </select>
          <span className="clock">
            {d.head ? `${d.axis.tickLabel(d.head)} · month ${d.head}` : "not started"}
          </span>
        </div>
        <div className="run-controls">
          {(
            [
              [1, "+1 month"],
              [12, "+1 year"],
              [60, "+5 years"],
              [120, "+10 years"],
            ] as const
          ).map(([n, l]) => (
            <button type="button" key={n} disabled={running} onClick={() => void d.run(n)}>
              {l}
            </button>
          ))}
          {running && (
            <button type="button" className="ghost" onClick={() => void d.cancel()}>
              Stop
            </button>
          )}
        </div>
        <div className="job">
          {job.state === "running" ? (
            <>
              {job.kind === "create" ? "Building economy (warm-up)" : "Simulating"} {job.done}/
              {job.total}
              <div className="prog">
                <i style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }} />
              </div>
            </>
          ) : (
            d.message
          )}
        </div>
        <button
          type="button"
          className="ghost"
          title="Toggle light/dark"
          aria-label="Toggle light/dark"
          onClick={toggleTheme}
        >
          ◐
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            d.setNewDialogOpen(true)
          }}
        >
          New simulation
        </button>
      </header>

      <section className="cursor-bar">
        <label htmlFor="cursor" className="muted">
          Viewing
        </label>
        <CursorSlider />
        <button type="button" className="ghost small" onClick={d.followLatest}>
          Follow latest
        </button>
        <button
          type="button"
          className="small"
          onClick={() => {
            d.setRewindTick(d.cursor)
            d.go("policy")
          }}
        >
          ⟲ Rewind &amp; decide differently here
        </button>
      </section>

      <div className="layout">
        <nav id="nav">
          {NAV.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className={
                d.view === id || (id === "products" && d.view === "product") ? "active" : undefined
              }
              onClick={(e) => {
                e.preventDefault()
                d.go(id)
              }}
            >
              {label}
            </a>
          ))}
        </nav>
        <main id="main">
          <CurrentView />
        </main>
      </div>
      <NewDialog />
    </>
  )
}

/** The slider moves freely; the cursor (and every view) updates when it is released. */
function CursorSlider() {
  const d = useDash()
  const [drag, setDrag] = useState<number | null>(null)
  const v = drag ?? d.cursor
  const commit = () => {
    if (drag !== null) d.setCursor(drag)
    setDrag(null)
  }
  return (
    <>
      <input
        type="range"
        id="cursor"
        aria-label="Month being viewed"
        min={0}
        max={Math.max(0, d.head - 1)}
        value={v}
        onChange={(e) => {
          setDrag(Number(e.target.value))
        }}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      <span>
        {d.series.length
          ? `${d.axis.tickLabel(v)} (month ${v})${v < d.head - 1 ? " · history" : " · latest"}`
          : "no history yet"}
      </span>
    </>
  )
}

function CurrentView() {
  const d = useDash()
  if (d.tid === null)
    return (
      <div className="empty">
        <h2>No simulation yet</h2>
        <p>Start a new economy to begin.</p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            d.setNewDialogOpen(true)
          }}
        >
          New simulation
        </button>
      </div>
    )
  switch (d.view) {
    case "overview":
      return <Overview />
    case "policy":
      return <PolicyView />
    case "timelines":
      return <TimelinesView />
    case "money":
      return <MoneyView />
    case "products":
      return <ProductsView />
    case "product":
      return <ProductView key={d.productId} />
    case "industry":
      return <IndustryView />
    case "labor":
      return <LaborView />
    case "knowledge":
      return <KnowledgeView />
    case "regions":
      return <RegionsView />
    case "ledger":
      return <LedgerView />
    case "events":
      return <EventsView />
    case "catalog":
      return <CatalogView />
    case "about":
      return <AboutView />
    default:
      return null
  }
}

function NewDialog() {
  const d = useDash()
  const ref = useRef<HTMLDialogElement>(null)
  const scenarios = Object.entries(d.meta.scenarios)
  const [chosen, setChosen] = useState(scenarios[0]?.[0] ?? "emerging_2025")
  const [name, setName] = useState("")
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 9999))
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (d.newDialogOpen && !el.open) el.showModal()
    if (!d.newDialogOpen && el.open) el.close()
  }, [d.newDialogOpen])
  const create = async () => {
    try {
      await post("/api/timelines", { scenario: chosen, seed: seed || 1, name: name || null })
      d.setNewDialogOpen(false)
      d.pollJob()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <dialog
      id="dlg"
      ref={ref}
      onClose={() => {
        d.setNewDialogOpen(false)
      }}
    >
      <h2>Start a new economy</h2>
      <p className="muted">
        The country&apos;s geology, climate, people, firms and know-how are generated from the
        scenario and seed, then run through a warm-up so markets settle before the clock starts.
      </p>
      <div>
        {scenarios.map(([k, v]) => (
          <button
            type="button"
            key={k}
            className={`scenario ${k === chosen ? "sel" : ""}`}
            style={{ display: "block", width: "100%", textAlign: "left" }}
            onClick={() => {
              setChosen(k)
            }}
          >
            <b>{v.label}</b> · {fmtNum(v.population)} people
            <br />
            <span className="muted">{v.desc}</span>
          </button>
        ))}
      </div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        <label>
          Name{" "}
          <input
            aria-label="Simulation name"
            type="text"
            placeholder="optional"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </label>
        <label>
          Seed{" "}
          <input
            aria-label="Random seed"
            type="number"
            value={seed}
            style={{ width: 90 }}
            onChange={(e) => {
              setSeed(Number(e.target.value))
            }}
          />
        </label>
      </div>
      <div className="toolbar">
        <button type="button" className="primary" onClick={() => void create()}>
          Create
        </button>
        <button
          type="button"
          onClick={() => {
            d.setNewDialogOpen(false)
          }}
        >
          Cancel
        </button>
      </div>
    </dialog>
  )
}
