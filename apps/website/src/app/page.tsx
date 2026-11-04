"use client"

import { useEffect } from "react"

const VIEWS: [string, string][] = [
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

export default function Page() {
  useEffect(() => {
    // The dashboard renders its views imperatively (SVG charts, large tables); load it client-side.
    void import("@website/lib/dashboard/app.js").then((m) => {
      m.boot()
    })
  }, [])

  return (
    <>
      <header className="topbar">
        <div className="brand">Domestic Economy Simulator</div>
        <div className="tl-picker">
          <label htmlFor="tlSelect" className="muted">
            Timeline
          </label>
          <select id="tlSelect" aria-label="Timeline" />
          <span id="clock" className="clock" />
        </div>
        <div className="run-controls">
          <button type="button" data-run="1">
            +1 month
          </button>
          <button type="button" data-run="12">
            +1 year
          </button>
          <button type="button" data-run="60">
            +5 years
          </button>
          <button type="button" data-run="120">
            +10 years
          </button>
          <button type="button" id="cancelBtn" className="ghost hidden">
            Stop
          </button>
        </div>
        <div id="job" className="job" />
        <button type="button" id="themeBtn" className="ghost" title="Toggle light/dark">
          ◐
        </button>
        <button type="button" id="newBtn" className="primary">
          New simulation
        </button>
      </header>

      <section className="cursor-bar">
        <label htmlFor="cursor" className="muted">
          Viewing
        </label>
        <input
          type="range"
          id="cursor"
          aria-label="Month being viewed"
          min={0}
          max={0}
          defaultValue={0}
        />
        <span id="cursorLabel" />
        <button type="button" id="followBtn" className="ghost small">
          Follow latest
        </button>
        <button type="button" id="rewindBtn" className="small">
          ⟲ Rewind &amp; decide differently here
        </button>
      </section>

      <div className="layout">
        <nav id="nav">
          {VIEWS.map(([id, label], i) => (
            <a key={id} href={`#${id}`} data-view={id} className={i === 0 ? "active" : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <main id="main">
          <div className="empty">Loading…</div>
        </main>
      </div>
      <dialog id="dlg" />
    </>
  )
}
