// Dashboard views. Rendered imperatively into the shell in src/app/page.tsx.
import * as C from "./charts.js"

const { fmtMoney, fmtNum, fmtPct } = C

const S = {
  meta: null,
  catalog: null,
  goodsById: {},
  knowById: {},
  occById: {},
  timelines: [],
  tid: null,
  head: 0,
  cursor: 0,
  follow: true,
  view: "overview",
  series: [],
  seriesTid: null,
  seriesHead: -1,
  compare: null,
  compareSeries: [],
  policy: null,
  policyEvents: [],
  regions: [],
  productId: null,
  rewindTick: null,
}
const $ = (s, r = document) => r.querySelector(s)
const main = () => $("#main")
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  )
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error?.message || j.error || r.statusText)
  return j
}
const tl = () => S.timelines.find((t) => t.id === S.tid)
const startYear = () => tl()?.start_year ?? 2025
function tickLabel(t) {
  const y = startYear() + t / 12
  const yi = Math.floor(y + 1e-9)
  return `${MONTHS[Math.round((y - yi) * 12) % 12]} ${yi}`
}
const yearOf = (t) => startYear() + t / 12
const xfmtYear = (x) => Math.floor(yearOf(x) + 1e-9)
C.setDefaultXticks((x0, x1, n) => {
  // ticks on January of each year, every k years so labels never crowd
  const off = Math.round(startYear() * 12) % 12
  const first = Math.ceil((x0 + off) / 12) * 12 - off
  const years = Math.max(1, Math.floor((x1 - first) / 12) + 1)
  const k = [1, 2, 5, 10, 20, 50].find((s) => years / s <= n) || 100
  const out = []
  for (let t = first; t <= x1 + 1e-9; t += 12 * k) out.push(t)
  return out.length ? out : [x0]
})
const toast = (msg) => {
  $("#job").textContent = msg
}
const lastMetric = () =>
  S.series.find((m) => m.tick === S.cursor) || S.series[S.series.length - 1] || null
const pop = () => lastMetric()?.population || 1
function perCapitaTip(v, monthly = false) {
  const m = lastMetric()
  if (!m) return ""
  const gdp = monthly ? m.gdp : (m.gdp || 0) * 12
  return `<div class="tip-row">Per person<b>${fmtMoney(v / pop())}</b></div><div class="tip-row">Share of ${monthly ? "monthly" : "annual"} GDP<b>${fmtPct(v / gdp)}</b></div>`
}
function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k)
    localStorage.setItem(k, v)
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ boot
async function init() {
  const saved = store("theme")
  if (saved) document.documentElement.dataset.theme = saved
  S.meta = await api("/api/meta")
  S.catalog = await api("/api/catalog")
  for (const g of S.catalog.goods) S.goodsById[g.id] = g
  for (const k of S.catalog.knowledge) S.knowById[k.id] = k
  for (const o of S.catalog.occupations) S.occById[o.id] = o
  bindChrome()
  await loadTimelines()
  if (!S.timelines.length) {
    if (S.meta.status.state === "running") pollJob()
    else openNewDialog()
    render()
  } else await selectTimeline(S.timelines[S.timelines.length - 1].id)
  if (S.meta.status.state === "running") pollJob()
}

function bindChrome() {
  document.querySelectorAll("#nav a").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault()
      go(a.dataset.view)
    }),
  )
  document
    .querySelectorAll("[data-run]")
    .forEach((b) => b.addEventListener("click", () => run(+b.dataset.run)))
  $("#cancelBtn").addEventListener("click", () => api("/api/cancel", { method: "POST" }))
  $("#newBtn").addEventListener("click", openNewDialog)
  $("#themeBtn").addEventListener("click", () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark")
    document.documentElement.dataset.theme = dark ? "light" : "dark"
    store("theme", document.documentElement.dataset.theme)
    render()
  })
  $("#tlSelect").addEventListener("change", (e) => selectTimeline(+e.target.value))
  const cur = $("#cursor")
  cur.addEventListener("input", () => {
    S.cursor = +cur.value
    S.follow = S.cursor >= S.head - 1
    updateCursorLabel()
  })
  cur.addEventListener("change", () => render())
  $("#followBtn").addEventListener("click", () => {
    S.follow = true
    S.cursor = Math.max(0, S.head - 1)
    syncCursor()
    render()
  })
  $("#rewindBtn").addEventListener("click", () => {
    S.rewindTick = S.cursor
    go("policy")
  })
  let t
  window.addEventListener("resize", () => {
    clearTimeout(t)
    t = setTimeout(render, 250)
  })
}

async function loadTimelines() {
  const r = await api("/api/timelines")
  S.timelines = r.timelines
  const sel = $("#tlSelect")
  sel.innerHTML = S.timelines
    .map(
      (t) => `<option value="${t.id}">${t.parent_id ? "↳ " : ""}${esc(t.name)} (#${t.id})</option>`,
    )
    .join("")
  if (S.tid) sel.value = S.tid
}
async function selectTimeline(id) {
  S.tid = id
  $("#tlSelect").value = id
  S.compare = null
  S.compareSeries = []
  await refreshTimeline(true)
}
async function refreshTimeline(resetCursor) {
  await loadTimelines()
  const t = tl()
  if (!t) return
  S.head = t.head_tick
  if (S.seriesTid !== S.tid || S.seriesHead !== S.head) {
    S.series = (await api(`/api/timelines/${S.tid}/series`)).series
    S.seriesTid = S.tid
    S.seriesHead = S.head
  }
  const p = await api(`/api/timelines/${S.tid}/policy`)
  S.policy = p.policy
  S.policyEvents = p.events
  S.regions = p.regions
  if (resetCursor || S.follow) S.cursor = Math.max(0, S.head - 1)
  syncCursor()
  render()
}
function syncCursor() {
  const c = $("#cursor")
  c.max = Math.max(0, S.head - 1)
  c.value = S.cursor
  updateCursorLabel()
  $("#clock").textContent = S.head ? `${tickLabel(S.head)} · month ${S.head}` : "not started"
}
function updateCursorLabel() {
  $("#cursorLabel").textContent = S.series.length
    ? `${tickLabel(S.cursor)} (month ${S.cursor})${S.cursor < S.head - 1 ? " · history" : " · latest"}`
    : "no history yet"
}

// ------------------------------------------------------------------ jobs
async function run(months) {
  if (!S.tid) return openNewDialog()
  try {
    await api(`/api/timelines/${S.tid}/run`, { method: "POST", body: { months } })
    pollJob()
  } catch (e) {
    toast(e.message)
  }
}
let polling = false
async function pollJob() {
  if (polling) return
  polling = true
  const j = $("#job")
  $("#cancelBtn").classList.remove("hidden")
  document.querySelectorAll("[data-run]").forEach((b) => (b.disabled = true))
  for (;;) {
    const st = await api("/api/status")
    const pct = st.total ? (st.done / st.total) * 100 : 0
    j.innerHTML =
      st.state === "running"
        ? `${st.kind === "create" ? "Building economy (warm-up)" : "Simulating"} ${st.done}/${st.total}<div class="prog"><i style="width:${pct}%"></i></div>`
        : ""
    if (st.state !== "running") {
      if (st.state === "error") j.textContent = "Error: " + (st.message || "").split("\n")[0]
      if (st.state === "cancelled") j.textContent = "Stopped."
      break
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  polling = false
  $("#cancelBtn").classList.add("hidden")
  document.querySelectorAll("[data-run]").forEach((b) => (b.disabled = false))
  const st = await api("/api/status")
  await loadTimelines()
  if (st.kind === "create" && st.timeline) await selectTimeline(st.timeline)
  else if (S.tid) {
    S.follow = true
    await refreshTimeline(false)
  }
}

// ------------------------------------------------------------------ new simulation
function openNewDialog() {
  const d = $("#dlg")
  const sc = S.meta.scenarios
  let chosen = Object.keys(sc)[0]
  d.innerHTML = `<h2>Start a new economy</h2>
    <p class="muted">The country's geology, climate, people, firms and know-how are generated from the scenario and seed, then run through a warm-up so markets settle before the clock starts.</p>
    <div>${Object.entries(sc)
      .map(
        ([k, v]) =>
          `<div class="scenario" data-k="${k}"><b>${esc(v.label)}</b> · ${fmtNum(v.population)} people<br><span class="muted">${esc(v.desc)}</span></div>`,
      )
      .join("")}</div>
    <div class="toolbar" style="margin-top:10px"><label>Name <input type="text" id="ns_name" placeholder="optional"></label>
    <label>Seed <input type="number" id="ns_seed" value="${Math.floor(Math.random() * 9999)}" style="width:90px"></label></div>
    <div class="toolbar"><button id="ns_go" class="primary">Create</button><button id="ns_cancel">Cancel</button></div>`
  const pick = (k) => {
    chosen = k
    d.querySelectorAll(".scenario").forEach((e) => e.classList.toggle("sel", e.dataset.k === k))
  }
  d.querySelectorAll(".scenario").forEach((e) =>
    e.addEventListener("click", () => pick(e.dataset.k)),
  )
  pick(chosen)
  $("#ns_cancel", d).addEventListener("click", () => d.close())
  $("#ns_go", d).addEventListener("click", async () => {
    try {
      await api("/api/timelines", {
        method: "POST",
        body: {
          scenario: chosen,
          seed: +$("#ns_seed", d).value || 1,
          name: $("#ns_name", d).value || null,
        },
      })
      d.close()
      pollJob()
    } catch (e) {
      alert(e.message)
    }
  })
  d.showModal()
}

// ------------------------------------------------------------------ routing
function go(view, arg) {
  S.view = view
  if (view === "product") S.productId = arg
  document
    .querySelectorAll("#nav a")
    .forEach((a) =>
      a.classList.toggle("active", a.dataset.view === (view === "product" ? "products" : view)),
    )
  render()
  window.scrollTo(0, 0)
}
function render() {
  C.hideTip()
  if (!S.tid) {
    main().innerHTML = `<div class="empty"><h2>No simulation yet</h2><p>Start a new economy to begin.</p><button class="primary" id="startBtn">New simulation</button></div>`
    $("#startBtn")?.addEventListener("click", openNewDialog)
    return
  }
  const views = {
    overview: vOverview,
    policy: vPolicy,
    timelines: vTimelines,
    money: vMoney,
    products: vProducts,
    product: vProduct,
    industry: vIndustry,
    labor: vLabor,
    knowledge: vKnowledge,
    regions: vRegions,
    ledger: vLedger,
    events: vEvents,
    catalog: vCatalog,
    about: vAbout,
  }
  Promise.resolve(views[S.view]()).catch((e) => {
    main().innerHTML = `<div class="card">Error: ${esc(e.message)}</div>`
    console.error(e)
  })
}

const pts = (key, f = (x) => x, src = S.series) =>
  src.map((m) => [m.tick, m[key] === undefined || m[key] === null ? null : f(m[key], m)])
const markers = () =>
  S.policyEvents.map((e) => ({ x: e.tick, label: esc(e.note || Object.keys(e.patch).join(", ")) }))
const chartCard = (id, title, sub = "") =>
  `<div class="card"><h2>${title}<small>${sub}</small></h2><div id="${id}"></div></div>`
function line(id, series, opts = {}) {
  const host = document.getElementById(id)
  if (!host) return
  const all = [...series]
  if (S.compare) {
    for (const s of series)
      if (s.key)
        all.push({
          name: `${s.name} (${esc(S.compare.name)})`,
          points: pts(s.key, s.f, S.compareSeries),
          color: s.color,
          dash: "5 4",
        })
  }
  C.lineChart(host, {
    series: all,
    xfmt: xfmtYear,
    markers: markers(),
    height: opts.height || 210,
    yfmt: opts.yfmt,
    zero: opts.zero,
    area: opts.area,
    onClick: (x) => {
      S.cursor = Math.max(0, Math.min(S.head - 1, Math.round(x)))
      S.follow = false
      syncCursor()
    },
  })
}
function annualSum(keys) {
  const out = []
  for (let i = 11; i < S.series.length; i += 12) {
    const r = { tick: S.series[i].tick }
    for (const k of keys) r[k] = S.series.slice(i - 11, i + 1).reduce((a, m) => a + (m[k] || 0), 0)
    out.push(r)
  }
  return out
}

// ------------------------------------------------------------------ OVERVIEW
function vOverview() {
  const m = lastMetric()
  const t = tl()
  const kpi = (label, v, fmt, key) => {
    const prev = S.series.find((x) => x.tick === S.cursor - 12)
    let delta = ""
    if (prev && prev[key] !== undefined && m) {
      const d = m[key] - prev[key]
      delta = `${d >= 0 ? "▲" : "▼"} ${fmt(Math.abs(d))} vs a year earlier`
    }
    return `<div class="kpi"><div class="label">${label}</div><div class="value">${m ? fmt(v) : "–"}</div><div class="delta">${delta}</div><div class="spark" data-key="${key}"></div></div>`
  }
  main().innerHTML = `
    <h1>${esc(t.name)}</h1>
    <p class="lead">${esc(S.meta.scenarios[t.scenario]?.desc || "")} Viewing <b>${S.series.length ? tickLabel(S.cursor) : "start"}</b>. Click any chart to move the time cursor; dotted lines mark policy decisions.</p>
    <div class="toolbar"><label>Compare with branch <select id="cmpSel"><option value="">— none —</option>${S.timelines
      .filter((x) => x.id !== S.tid)
      .map(
        (x) =>
          `<option value="${x.id}" ${S.compare?.id === x.id ? "selected" : ""}>${esc(x.name)} (#${x.id})</option>`,
      )
      .join("")}</select></label>
    ${S.series.length ? "" : '<span class="pill">Run the simulation with the buttons at the top (+1 year etc.)</span>'}</div>
    <div class="kpis">
      ${kpi("GDP (annualized)", m ? m.gdp * 12 : 0, fmtMoney, "gdp")}
      ${kpi("Real GDP per person / yr", m ? m.real_gdp_pc * 12 : 0, fmtMoney, "real_gdp_pc")}
      ${kpi("Unemployment", m?.unemployment, (v) => fmtPct(v), "unemployment")}
      ${kpi("Inflation (12m)", m?.inflation, (v) => fmtPct(v), "inflation")}
      ${kpi("Government debt / GDP", m?.debt_gdp, (v) => fmtPct(v, 0), "debt_gdp")}
      ${kpi("Trade balance / month", m?.trade_balance, fmtMoney, "trade_balance")}
      ${kpi("Population", m?.population, fmtNum, "population")}
      ${kpi("Gini (income)", m?.gini, (v) => v?.toFixed(3), "gini")}
      ${kpi("Life expectancy", m?.life_expectancy, (v) => v?.toFixed(1) + " yrs", "life_expectancy")}
      ${kpi("Urbanization", m?.urbanization, (v) => fmtPct(v, 0), "urbanization")}
      ${kpi("Products made at home", m?.domestic_products, fmtNum, "domestic_products")}
      ${kpi("CO₂ / month", m?.emissions, (v) => fmtNum(v) + " t", "emissions")}
    </div>
    <div class="grid g2">
      ${chartCard("c_rgdp", "Real GDP", "monthly, start-year prices")}
      ${chartCard("c_comp", "GDP by expenditure", "C + G + I + exports − imports (monthly)")}
      ${chartCard("c_u", "Unemployment rate")}
      ${chartCard("c_infl", "Inflation and policy rate")}
      ${chartCard("c_wage", "Average real wage", "monthly, start-year prices")}
      ${chartCard("c_fiscal", "Government revenue vs spending", "monthly")}
      ${chartCard("c_trade", "Exports and imports", "monthly")}
      ${chartCard("c_pop", "Population and fertility")}
      ${chartCard("c_ineq", "Inequality and poverty")}
      ${chartCard("c_firms", "Firms, start-ups and bankruptcies")}
    </div>`
  $("#cmpSel").addEventListener("change", async (e) => {
    const id = +e.target.value
    if (!id) {
      S.compare = null
      S.compareSeries = []
    } else {
      S.compare = S.timelines.find((x) => x.id === id)
      S.compareSeries = (await api(`/api/timelines/${id}/series`)).series
    }
    render()
  })
  document.querySelectorAll(".kpi .spark").forEach((sp) =>
    C.sparkline(
      sp,
      S.series.slice(-60).map((x) => x[sp.dataset.key]),
    ),
  )
  if (!S.series.length) return
  line("c_rgdp", [{ name: "Real GDP", key: "real_gdp", points: pts("real_gdp") }], {
    yfmt: fmtMoney,
    area: true,
  })
  C.stackedArea($("#c_comp"), {
    x: S.series.map((x) => x.tick),
    xfmt: xfmtYear,
    yfmt: fmtMoney,
    height: 210,
    series: [
      { name: "Consumption", values: S.series.map((x) => x.C) },
      { name: "Government", values: S.series.map((x) => x.G) },
      { name: "Investment", values: S.series.map((x) => Math.max(0, x.I + (x.dInv || 0))) },
      { name: "Net exports", values: S.series.map((x) => Math.max(0, x.X - x.M)) },
    ],
  })
  line("c_u", [{ name: "Unemployment", key: "unemployment", points: pts("unemployment") }], {
    yfmt: (v) => fmtPct(v, 0),
  })
  line(
    "c_infl",
    [
      { name: "Inflation", key: "inflation", points: pts("inflation") },
      {
        name: "Policy rate",
        key: "policy_rate",
        points: pts("policy_rate"),
        color: "var(--series-2)",
      },
    ],
    { yfmt: (v) => fmtPct(v, 0), zero: false },
  )
  line(
    "c_wage",
    [{ name: "Real average wage", key: "real_avg_wage", points: pts("real_avg_wage") }],
    { yfmt: fmtMoney },
  )
  line(
    "c_fiscal",
    [
      { name: "Revenue", key: "gov_revenue", points: pts("gov_revenue") },
      {
        name: "Spending",
        key: "gov_spending",
        points: pts("gov_spending"),
        color: "var(--series-2)",
      },
    ],
    { yfmt: fmtMoney },
  )
  line(
    "c_trade",
    [
      { name: "Exports", key: "X", points: pts("X") },
      { name: "Imports", key: "M", points: pts("M"), color: "var(--series-2)" },
    ],
    { yfmt: fmtMoney },
  )
  line("c_pop", [{ name: "Population", key: "population", points: pts("population") }], {
    yfmt: fmtNum,
    zero: false,
    height: 150,
  })
  const tfr = document.createElement("div")
  $("#c_pop").appendChild(tfr)
  C.lineChart(tfr, {
    series: [
      { name: "Fertility rate (births per woman)", points: pts("tfr"), color: "var(--series-3)" },
    ],
    xfmt: xfmtYear,
    height: 120,
    yfmt: (v) => v.toFixed(2),
    zero: false,
  })
  line(
    "c_ineq",
    [
      { name: "Gini", key: "gini", points: pts("gini") },
      { name: "Poverty rate", key: "poverty", points: pts("poverty"), color: "var(--series-2)" },
    ],
    { yfmt: (v) => v.toFixed(2) },
  )
  line("c_firms", [{ name: "Operating firms", key: "firms", points: pts("firms") }], {
    yfmt: fmtNum,
    zero: false,
    height: 150,
  })
  const fh = document.createElement("div")
  $("#c_firms").appendChild(fh)
  const yr = annualSum(["entries", "bankruptcies"])
  C.lineChart(fh, {
    series: [
      { name: "Start-ups per year", points: yr.map((r) => [r.tick, r.entries]) },
      {
        name: "Bankruptcies per year",
        points: yr.map((r) => [r.tick, r.bankruptcies]),
        color: "var(--series-2)",
      },
    ],
    xfmt: xfmtYear,
    height: 130,
    yfmt: fmtNum,
  })
}

// ------------------------------------------------------------------ POLICY
const PRESETS = [
  {
    label: "Double education spending",
    note: "Double public education spending",
    patch: (p) => ({ spend_education: +(p.spend_education * 2).toFixed(4) }),
  },
  {
    label: "STEM push at universities",
    note: "Shift university seats toward engineering & science",
    patch: () => ({
      university_fields: {
        mech: 3,
        elec: 3,
        chem: 2.5,
        cs: 3,
        science: 2.5,
        business: 0.8,
        law: 0.3,
        arts: 0.3,
      },
      education_tertiary_share: 0.35,
    }),
  },
  {
    label: "Semiconductor industrial policy",
    note: "State-backed chip industry + R&D push",
    patch: () => ({
      industrial_policy: ["chip_legacy", "silicon_wafers", "pcb", "electronic_module"],
      subsidies_producer: { semis: 0.2, electronics: 0.1 },
      research_fields: { elec: 4, phys: 2, chem: 2 },
      spend_research: 0.015,
    }),
  },
  {
    label: "EV purchase subsidy 30%",
    note: "30% consumer subsidy on electric cars",
    patch: () => ({ subsidies_consumer: { electric_car: 0.3, e_bike_scooter: 0.2 } }),
  },
  {
    label: "Carbon tax $80/t",
    note: "Carbon tax of $80 per tonne",
    patch: () => ({ carbon_tax: 80 }),
  },
  {
    label: "Upzone cities ×2.5 + transit",
    note: "Allow 2.5x denser housing, invest in transit",
    patch: () => ({
      zoning_density: 2.5,
      urban_expansion: 1.5,
      infrastructure_split: { transit: 0.3 },
    }),
  },
  {
    label: "Infrastructure push (6% of GDP)",
    note: "Raise infrastructure spending to 6% of GDP",
    patch: () => ({ spend_infrastructure: 0.06 }),
  },
  {
    label: "Protectionism (30% tariffs)",
    note: "30% general tariff",
    patch: () => ({ tariff_general: 0.3 }),
  },
  {
    label: "Free trade",
    note: "Remove all tariffs",
    patch: () => ({ tariff_general: 0, tariff_by_category: {} }),
  },
  {
    label: "Austerity",
    note: "Cut admin & health, lower benefits",
    patch: () => ({
      spend_admin: 0.035,
      spend_health: 0.035,
      unemployment_benefit: 0.2,
      pension_rate: 0.22,
    }),
  },
  {
    label: "Open to skilled immigrants",
    note: "20,000 skilled immigrants per year",
    patch: () => ({ skilled_immigration: 20000 }),
  },
  {
    label: "Raise minimum wage",
    note: "Minimum wage to 60% of median",
    patch: () => ({ minimum_wage: 0.6 }),
  },
  {
    label: "Tight money",
    note: "Fix policy rate at 10%",
    patch: () => ({ policy_rate_mode: "fixed", policy_rate: 0.1 }),
  },
]
let draft = null
async function vPolicy() {
  const rewind = S.rewindTick !== null && S.rewindTick < S.head
  let base = S.policy
  if (rewind)
    base =
      (await api(`/api/timelines/${S.tid}/detail/state?tick=${S.rewindTick}`)).data?.policy ||
      S.policy
  draft = JSON.parse(JSON.stringify(base))
  const groups = S.meta.policy_schema
  main().innerHTML = `
    <h1>Policy decisions</h1>
    <p class="lead">${
      rewind
        ? `<b>Rewind mode:</b> deciding at <b>${tickLabel(S.rewindTick)}</b> (month ${S.rewindTick}). Applying creates a new branch from that moment; the original timeline is kept so you can compare outcomes. <button id="exitRewind" class="small">Decide at the latest month instead</button>`
        : `Decisions apply from <b>${tickLabel(S.head)}</b> onward on this timeline. To change your mind about the past, move the time cursor and press “Rewind &amp; decide differently here”.`
    }</p>
    <div class="card"><h2>Quick experiments</h2><div class="presets">${PRESETS.map((p, i) => `<button class="small" data-preset="${i}">${p.label}</button>`).join("")}</div>
    <div class="muted">Presets only fill in the form below; nothing happens until you apply.</div></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card" id="polForm"></div>
      <div class="card"><h2>Decision history <small>this branch & its ancestors</small></h2><div id="polHist"></div></div>
    </div>`
  $("#exitRewind")?.addEventListener("click", () => {
    S.rewindTick = null
    render()
  })
  document.querySelectorAll("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      const pr = PRESETS[+b.dataset.preset]
      for (const [k, v] of Object.entries(pr.patch(draft))) {
        draft[k] =
          v && typeof v === "object" && !Array.isArray(v) && typeof draft[k] === "object"
            ? { ...draft[k], ...v }
            : v
      }
      drawForm(base, groups, rewind, pr.note)
    }),
  )
  drawForm(base, groups, rewind, "")
  $("#polHist").innerHTML = S.policyEvents.length
    ? S.policyEvents
        .slice()
        .reverse()
        .map(
          (e) =>
            `<div class="event"><span class="when">${tickLabel(e.tick)}</span><span>${esc(e.note || "")}<br><span class="muted">${esc(JSON.stringify(e.patch)).slice(0, 300)}</span></span></div>`,
        )
        .join("")
    : '<div class="muted">No decisions yet: the economy runs on default policy.</div>'
}
function domainOptions(domain) {
  if (domain === "categories") return S.meta.categories.map((c) => [c, c])
  if (domain === "fields") return Object.entries(S.meta.fields)
  if (domain === "research_fields") return S.meta.research_fields.map((k) => [k, k])
  if (domain === "infra")
    return ["road", "rail", "port", "grid", "broadband", "transit", "irrigation"].map((k) => [k, k])
  if (domain === "regions") return S.regions.map((r) => [String(r.id), r.name])
  return [
    ...S.meta.categories.map((c) => [c, "All " + c]),
    ...S.catalog.goods.map((g) => [g.id, g.name]),
  ]
}
function drawForm(base, groups, rewind, note) {
  const host = $("#polForm")
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  let html = `<h2>Policy levers</h2>`
  for (const grp of groups) {
    html += `<div class="policy-group"><h3>${grp.group}</h3>`
    for (const it of grp.items) {
      const v = draft[it.key]
      html += `<div class="policy-item ${same(v, base[it.key]) ? "" : "changed"}" data-key="${it.key}"><label>${it.label}</label>`
      if (it.type === "pct" || it.type === "num") {
        const scale = it.type === "pct" ? 100 : 1
        const step = (it.step || (it.type === "pct" ? 0.005 : 1)) * scale
        html += `<input type="range" min="${it.min * scale}" max="${it.max * scale}" step="${step}" value="${v * scale}" data-scale="${scale}">
          <span><input type="number" step="${step}" value="${+(v * scale).toFixed(3)}" data-scale="${scale}" style="width:84px">${it.type === "pct" ? "%" : ""}</span>`
      } else if (it.type === "choice") {
        html += `<select>${it.choices.map((c) => `<option ${c === v ? "selected" : ""}>${c}</option>`).join("")}</select><span></span>`
      } else if (it.type === "brackets") {
        html += `<span>${v.map((x, i) => `<input type="number" step="1" min="0" max="90" value="${(x * 100).toFixed(1)}" data-i="${i}" style="width:62px">%`).join(" ")}</span><span></span>`
      } else if (it.type === "map_num" || it.type === "map_pct") {
        const opts = domainOptions(it.domain)
        const removable = it.type === "map_pct" || it.domain === "regions"
        const keys = removable ? Object.keys(v || {}) : opts.map((o) => o[0])
        html += `<span></span><span></span><div class="map-editor">${keys
          .map((k) => {
            const name = (opts.find((o) => o[0] === k) || [k, k])[1]
            const val = (v || {})[k] ?? (it.domain === "regions" ? 1 : 0)
            return `<div class="map-row" data-mk="${k}"><span title="${esc(name)}">${esc(name)}</span><input type="number" step="${it.type === "map_pct" ? 1 : it.step || 0.1}" value="${it.type === "map_pct" ? +(val * 100).toFixed(2) : val}">${removable ? '<button class="small rm" title="remove">×</button>' : "<span></span>"}</div>`
          })
          .join("")}
          ${
            removable
              ? `<div class="map-row"><select class="addSel"><option value="">+ add…</option>${opts
                  .filter((o) => !(o[0] in (v || {})))
                  .map((o) => `<option value="${o[0]}">${esc(o[1])}</option>`)
                  .join("")}</select></div>`
              : ""
          }
        </div>`
      } else if (it.type === "list") {
        const opts = domainOptions(it.domain)
        html += `<span></span><span></span><div class="map-editor">${(v || [])
          .map(
            (k) =>
              `<div class="map-row" data-lk="${k}"><span>${esc((opts.find((o) => o[0] === k) || [k, k])[1])}</span><span></span><button class="small rm">×</button></div>`,
          )
          .join("")}
          <div class="map-row"><select class="addSel"><option value="">+ add…</option>${opts
            .filter((o) => !(v || []).includes(o[0]))
            .map((o) => `<option value="${o[0]}">${esc(o[1])}</option>`)
            .join("")}</select></div></div>`
      }
      if (it.help) html += `<div class="help">${it.help}</div>`
      html += `</div>`
    }
    html += `</div>`
  }
  const patch = diffPatch(base, draft)
  const noteVal = note || $("#noteIn")?.value || ""
  html += `<div class="sticky-actions"><input type="text" id="noteIn" placeholder="Describe this decision (optional)" style="flex:1;min-width:200px" value="${esc(noteVal)}">
    <span class="muted">${Object.keys(patch).length} change(s)</span>
    <button id="resetBtn">Reset</button>
    <button id="applyBtn" class="primary" ${Object.keys(patch).length ? "" : "disabled"}>${rewind ? `Branch from ${tickLabel(S.rewindTick)}` : "Apply decision"}</button></div>`
  host.innerHTML = html
  const redraw = () => drawForm(base, groups, rewind, $("#noteIn").value)
  const items = groups.flatMap((g) => g.items)
  host.querySelectorAll(".policy-item").forEach((row) => {
    const key = row.dataset.key
    const it = items.find((x) => x.key === key)
    if (it.type === "pct" || it.type === "num") {
      const [rng, numIn] = row.querySelectorAll("input")
      const set = (val) => {
        draft[key] = +val / +rng.dataset.scale
        redraw()
      }
      rng.addEventListener("change", (e) => set(e.target.value))
      rng.addEventListener("input", (e) => {
        numIn.value = e.target.value
      })
      numIn.addEventListener("change", (e) => set(e.target.value))
    } else if (it.type === "choice") {
      row.querySelector("select").addEventListener("change", (e) => {
        draft[key] = e.target.value
        redraw()
      })
    } else if (it.type === "brackets") {
      row.querySelectorAll("input").forEach((inp) =>
        inp.addEventListener("change", (e) => {
          draft[key] = draft[key].slice()
          draft[key][+inp.dataset.i] = +e.target.value / 100
          redraw()
        }),
      )
    } else if (it.type === "map_num" || it.type === "map_pct") {
      row.querySelectorAll("[data-mk]").forEach((mr) => {
        mr.querySelector("input").addEventListener("change", (e) => {
          draft[key] = { ...(draft[key] || {}) }
          draft[key][mr.dataset.mk] =
            it.type === "map_pct" ? +e.target.value / 100 : +e.target.value
          redraw()
        })
        mr.querySelector(".rm")?.addEventListener("click", () => {
          draft[key] = { ...(draft[key] || {}) }
          delete draft[key][mr.dataset.mk]
          redraw()
        })
      })
      row.querySelector(".addSel")?.addEventListener("change", (e) => {
        if (!e.target.value) return
        draft[key] = { ...(draft[key] || {}) }
        draft[key][e.target.value] = it.type === "map_pct" ? 0.1 : 1
        redraw()
      })
    } else if (it.type === "list") {
      row.querySelectorAll("[data-lk]").forEach((mr) =>
        mr.querySelector(".rm").addEventListener("click", () => {
          draft[key] = (draft[key] || []).filter((x) => x !== mr.dataset.lk)
          redraw()
        }),
      )
      row.querySelector(".addSel").addEventListener("change", (e) => {
        if (!e.target.value) return
        draft[key] = [...(draft[key] || []), e.target.value]
        redraw()
      })
    }
  })
  $("#resetBtn").addEventListener("click", () => {
    draft = JSON.parse(JSON.stringify(base))
    drawForm(base, groups, rewind, "")
  })
  $("#applyBtn").addEventListener("click", async () => {
    const noteText = $("#noteIn").value || ""
    try {
      const body = { patch: diffPatch(base, draft), note: noteText }
      if (rewind) {
        body.tick = S.rewindTick
        body.branch_name = noteText ? `${noteText} (from ${tickLabel(S.rewindTick)})` : undefined
      }
      const r = await api(`/api/timelines/${S.tid}/policy`, { method: "POST", body })
      S.rewindTick = null
      if (r.branched) {
        await loadTimelines()
        await selectTimeline(r.timeline)
        toast(`Created branch #${r.timeline}. Run it forward to see how it plays out.`)
      } else {
        await refreshTimeline(false)
        toast("Decision recorded; it takes effect when you run the next month.")
      }
      go("policy")
    } catch (e) {
      alert(e.message)
    }
  })
}
function diffPatch(a, b) {
  const p = {}
  for (const k of Object.keys(b)) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue
    if (
      b[k] &&
      typeof b[k] === "object" &&
      !Array.isArray(b[k]) &&
      a[k] &&
      typeof a[k] === "object"
    ) {
      const d = {}
      for (const kk of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) {
        if (!(kk in b[k])) d[kk] = null
        else if (JSON.stringify(a[k][kk]) !== JSON.stringify(b[k][kk])) d[kk] = b[k][kk]
      }
      p[k] = d
    } else p[k] = b[k]
  }
  return p
}

// ------------------------------------------------------------------ TIMELINES
function vTimelines() {
  const ts = S.timelines
  const kids = {}
  ts.forEach((t) => (kids[t.parent_id || 0] = kids[t.parent_id || 0] || []).push(t))
  const rows = []
  const walk = (pid, depth) =>
    (kids[pid] || []).forEach((t) => {
      rows.push([t, depth])
      walk(t.id, depth + 1)
    })
  walk(0, 0)
  const maxHead = Math.max(12, ...ts.map((t) => t.head_tick))
  main().innerHTML = `<h1>Timelines &amp; branches</h1>
    <p class="lead">Every rewind creates a branch that shares history up to the moment you changed your mind. Bars span the months each branch has simulated; dots are policy decisions. Select a branch to view it, or compare two on the Overview.</p>
    <div class="card tree"><div id="treeSvg"></div></div>
    <div class="card" style="margin-top:14px"><table class="data"><thead><tr><th>#</th><th>Name</th><th>Scenario</th><th>Branched from</th><th class="num">Months</th><th>Decisions</th><th></th></tr></thead><tbody>
    ${rows
      .map(
        ([
          t,
          d,
        ]) => `<tr><td>${t.id}</td><td style="padding-left:${6 + d * 16}px">${t.id === S.tid ? "<b>" : ""}${esc(t.name)}${t.id === S.tid ? "</b>" : ""}</td><td>${esc(S.meta.scenarios[t.scenario]?.label || t.scenario)}</td>
      <td>${t.parent_id ? `#${t.parent_id} @ month ${t.fork_tick}` : "—"}</td><td class="num">${t.head_tick}</td><td>${t.policy_events.length}</td>
      <td><button class="small" data-sel="${t.id}">View</button> <button class="small" data-ren="${t.id}">Rename</button> <button class="small" data-del="${t.id}">Delete</button></td></tr>`,
      )
      .join("")}</tbody></table></div>`
  const host = $("#treeSvg")
  const W = Math.max(500, host.clientWidth)
  const rowH = 30
  const H = rows.length * rowH + 30
  const L = 220
  const X = (t) => L + (t / maxHead) * (W - L - 20)
  let svg = `<svg width="${W}" height="${H}">`
  rows.forEach(([t, d], i) => {
    const y = 20 + i * rowH
    const x0 = X(t.parent_id ? t.fork_tick : 0)
    const x1 = X(t.head_tick)
    if (t.parent_id) {
      const py = 20 + rows.findIndex(([p]) => p.id === t.parent_id) * rowH
      svg += `<path d="M${x0},${py} L${x0},${y}" class="branch-line" fill="none" stroke-dasharray="3 3"/>`
    }
    svg += `<text x="${8 + d * 12}" y="${y + 4}">${esc(t.name).slice(0, 30)}</text>`
    svg += `<rect x="${x0}" y="${y - 5}" width="${Math.max(2, x1 - x0)}" height="10" rx="5" fill="${t.id === S.tid ? "var(--series-1)" : "var(--series-3)"}" data-sel="${t.id}" style="cursor:pointer"/>`
    for (const e of t.policy_events)
      svg += `<circle cx="${X(e.tick)}" cy="${y}" r="5" fill="var(--series-2)" stroke="var(--surface-1)" stroke-width="2"><title>${esc(e.note || JSON.stringify(e.patch))}</title></circle>`
  })
  for (let yr = 0; yr <= maxHead; yr += maxHead > 240 ? 60 : 12)
    svg += `<text x="${X(yr)}" y="${H - 4}" text-anchor="middle" style="fill:var(--text-muted);font-size:11px">${xfmtYear(yr)}</text>`
  host.innerHTML = svg + "</svg>"
  main()
    .querySelectorAll("[data-sel]")
    .forEach((b) =>
      b.addEventListener("click", async () => {
        await selectTimeline(+b.dataset.sel)
        go("overview")
      }),
    )
  main()
    .querySelectorAll("[data-ren]")
    .forEach((b) =>
      b.addEventListener("click", async () => {
        const n = prompt("New name?")
        if (n) {
          await api(`/api/timelines/${b.dataset.ren}/rename`, { method: "POST", body: { name: n } })
          await loadTimelines()
          render()
        }
      }),
    )
  main()
    .querySelectorAll("[data-del]")
    .forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Delete this timeline and all its branches? This cannot be undone.")) return
        try {
          await api(`/api/timelines/${b.dataset.del}`, { method: "DELETE" })
          await loadTimelines()
          if (+b.dataset.del === S.tid || !S.timelines.find((x) => x.id === S.tid)) {
            S.tid = S.timelines[0]?.id || null
            if (S.tid) await selectTimeline(S.tid)
          }
          render()
        } catch (e) {
          alert(e.message)
        }
      }),
    )
}

// ------------------------------------------------------------------ MONEY
const NODE_COLORS = {}
function nodeColor(name) {
  const fixed = {
    Households: "var(--series-1)",
    Government: "var(--series-2)",
    Banks: "var(--series-7)",
    "Rest of world": "var(--series-8)",
  }
  if (fixed[name]) return fixed[name]
  if (!(name in NODE_COLORS))
    NODE_COLORS[name] = [
      "var(--series-3)",
      "var(--series-4)",
      "var(--series-5)",
      "var(--series-6)",
    ][Object.keys(NODE_COLORS).length % 4]
  return NODE_COLORS[name]
}
const FIN_KINDS = [
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
]
async function vMoney() {
  const hi = S.cursor
  const lo = Math.max(0, hi - 11)
  main().innerHTML = `<h1>Where the money goes</h1>
    <p class="lead">Every payment in the economy is recorded in the ledger. These views add it up for the 12 months ending <b>${tickLabel(hi)}</b>. Hover anything to see it per person and as a share of GDP.</p>
    <div class="card"><h2>Money flows between sectors <small>${tickLabel(lo)} – ${tickLabel(hi)}</small></h2>
      <div class="toolbar"><label>Hide flows smaller than <select id="minFlow"><option value="0.002">0.2% of total</option><option value="0.005" selected>0.5%</option><option value="0.01">1%</option><option value="0">show all</option></select></label>
      <label><input type="checkbox" id="hideFin"> hide loans/repayments</label></div>
      <div id="flowChart"></div></div>
    <div class="grid g2" style="margin-top:14px">
      ${chartCard("tmSector", "Value added by sector", "who produces the GDP")}
      ${chartCard("tmNeed", "Household spending by need")}
      ${chartCard("tmRev", "Government revenue")}
      ${chartCard("tmSpend", "Government spending")}
    </div>
    <div class="card" style="margin-top:14px"><h2>Put a dollar amount in perspective</h2>
      <div class="toolbar"><label>Amount $ <input type="number" id="dollarIn" value="1000000000" style="width:180px"></label><span id="dollarOut"></span></div>
      <h3>The scale of this economy (log scale)</h3><div id="ladder"></div></div>`
  const win = S.series.filter((m) => m.tick >= lo && m.tick <= hi)
  const sumObj = (k) => {
    const o = {}
    for (const m of win) for (const [a, b] of Object.entries(m[k] || {})) o[a] = (o[a] || 0) + b
    return o
  }
  const flows = await api(`/api/timelines/${S.tid}/flows?from=${lo}&to=${hi}`)
  const draw = () => {
    const total = flows.links.reduce((a, l) => a + l.value, 0)
    const min = +$("#minFlow").value * total
    const hideFin = $("#hideFin").checked
    const links = flows.links
      .map((l) => {
        if (!hideFin) return l
        const kinds = Object.fromEntries(
          Object.entries(l.kinds).filter(([k]) => !FIN_KINDS.includes(k)),
        )
        return { ...l, kinds, value: Object.values(kinds).reduce((a, b) => a + b, 0) }
      })
      .filter((l) => l.value >= min && l.value > 0)
    C.moneyFlow($("#flowChart"), links, {
      height: 560,
      color: nodeColor,
      per: (v) => perCapitaTip(v),
    })
  }
  $("#minFlow").addEventListener("change", draw)
  $("#hideFin").addEventListener("change", draw)
  draw()
  const tm = (id, obj, nameMap = (k) => k) =>
    C.treemap(
      $(id),
      Object.entries(obj).map(([k, v], i) => ({
        label: nameMap(k),
        value: v,
        color: C.seriesColor(i),
        tip: perCapitaTip(v),
      })),
      { height: 280 },
    )
  tm("#tmSector", sumObj("sector_va"))
  tm("#tmNeed", sumObj("hh_need"), (k) => S.meta.needs[k] || k)
  tm("#tmRev", sumObj("gov_rev_detail"))
  tm("#tmSpend", sumObj("gov_spend_detail"), (k) => S.goodsById[k]?.name || k)
  const m = lastMetric() || {}
  const upd = () => {
    const v = +$("#dollarIn").value || 0
    const people = m.population || 1
    const med = m.median_wage || 1
    const gdpY = (m.gdp || 1) * 12
    $("#dollarOut").innerHTML =
      `= <b>${fmtMoney(v / people)}</b> per resident · <b>${fmtPct(v / gdpY, 2)}</b> of a year's GDP · <b>${fmtNum(v / med)}</b> months of the median wage · <b>${fmtNum(v / (m.housing_rent || 1))}</b> months of average rent`
  }
  $("#dollarIn").addEventListener("input", upd)
  upd()
  const y = (k) => win.reduce((a, x) => a + (x[k] || 0), 0)
  const prices =
    (await api(`/api/timelines/${S.tid}/detail/state?tick=${hi + 1}`)).data?.prices || {}
  const items = [
    ["GDP (12 months)", y("gdp")],
    ["Household consumption", y("C")],
    ["Government spending", y("gov_spending")],
    ["Wage bill", y("wage_bill")],
    ["Exports", y("X")],
    ["Imports", y("M")],
    ["Government debt", m.gov_debt || 0],
    ["Bank loans outstanding", m.bank_loans || 0],
    ["Dividends paid", y("dividends")],
    ["A new 1 Mt/yr cement kiln", prices.cement_kiln],
    ["A jet airliner", prices.jet_airliner],
    ["A new home", prices.dwelling],
    ["A year of the median wage", (m.median_wage || 0) * 12],
    ["A car", prices.passenger_car],
    ["A smartphone", prices.smartphone],
    ["A month's rent", m.housing_rent],
    ["1 kg of bread", (prices.bread_bakery || 0) / 1000],
  ]
    .filter((x) => x[1] > 0)
    .sort((a, b) => b[1] - a[1])
  const lmax = Math.log10(items[0]?.[1] || 10)
  const lmin = Math.log10(items[items.length - 1]?.[1] || 1) - 0.5
  $("#ladder").innerHTML = `<div class="barlist">${items
    .map(
      ([k, v], i) =>
        `<div class="bar-row"><div class="bar-label">${k}</div><div class="bar-track"><div class="bar-fill" style="width:${(((Math.log10(v) - lmin) / (lmax - lmin)) * 100).toFixed(1)}%;background:var(--series-${(i % 3) + 1})"></div></div><div class="bar-val">${fmtMoney(v)}</div></div>`,
    )
    .join(
      "",
    )}</div><p class="dollar-ctx">Each step to the right is ×10. Prices are this economy's own prices at the selected month.</p>`
}

// ------------------------------------------------------------------ PRODUCTS
const prodState = { q: "", sector: "", sort: "dom_value", made: "" }
async function vProducts() {
  const r = await api(`/api/timelines/${S.tid}/goods?tick=${S.cursor}`)
  const rows = r.goods.map((g) => ({
    ...g,
    dom_value: g.dom_sold * g.price,
    out_value: g.output * g.price,
    imp_share: g.import_value / Math.max(1e-9, g.import_value + g.dom_sold * g.price),
  }))
  const sectors = [...new Set(rows.map((x) => x.sector).filter(Boolean))].sort()
  main().innerHTML = `<h1>Products &amp; capabilities</h1>
    <p class="lead">Everything traded in ${tickLabel(S.cursor)}. Click a product to see <b>why</b> the country can or cannot make it - the scientific, engineering, manufacturing and economic layers, all the way down the supply chain.</p>
    <div class="card"><div class="toolbar"><input type="text" id="pq" placeholder="Search products…" value="${esc(prodState.q)}">
      <select id="ps"><option value="">All sectors</option>${sectors.map((s) => `<option ${s === prodState.sector ? "selected" : ""}>${s}</option>`).join("")}</select>
      <select id="pm"><option value="">Made here or imported</option><option value="dom" ${prodState.made === "dom" ? "selected" : ""}>Made domestically</option><option value="imp" ${prodState.made === "imp" ? "selected" : ""}>Only imported</option></select>
      <span class="muted" id="pcount"></span></div>
      <div class="scroll" id="ptable"></div></div>`
  const draw = () => {
    let list = rows.filter(
      (x) =>
        x.name &&
        (!prodState.q || x.name.toLowerCase().includes(prodState.q.toLowerCase())) &&
        (!prodState.sector || x.sector === prodState.sector),
    )
    if (prodState.made === "dom") list = list.filter((x) => x.producers > 0)
    else if (prodState.made === "imp") list = list.filter((x) => !x.producers && x.imports > 0)
    list.sort((a, b) => (b[prodState.sort] || 0) - (a[prodState.sort] || 0))
    $("#pcount").textContent = `${list.length} products`
    const cols = [
      ["name", "Product"],
      ["sector", "Sector"],
      ["price", "Price", "num"],
      ["out_value", "Domestic output", "num"],
      ["dom_value", "Domestic sales", "num"],
      ["import_value", "Imports", "num"],
      ["export_value", "Exports", "num"],
      ["imp_share", "Import share", "num"],
      ["producers", "Firms", "num"],
    ]
    $("#ptable").innerHTML =
      `<table class="data"><thead><tr>${cols.map(([k, l, c]) => `<th class="${c || ""}" data-k="${k}">${l}${prodState.sort === k ? " ▾" : ""}</th>`).join("")}</tr></thead><tbody>${list
        .slice(0, 400)
        .map(
          (x) => `<tr class="clickable" data-g="${x.good}">
      <td>${esc(x.name)} <span class="muted">/${esc(x.unit)}</span></td><td>${esc(x.sector)}</td><td class="num">${fmtMoney(x.price)}</td><td class="num">${fmtMoney(x.out_value)}</td><td class="num">${fmtMoney(x.dom_value)}</td>
      <td class="num">${fmtMoney(x.import_value)}</td><td class="num">${fmtMoney(x.export_value)}</td><td class="num">${fmtPct(x.imp_share, 0)}</td><td class="num">${x.producers}</td></tr>`,
        )
        .join("")}</tbody></table>`
    $("#ptable")
      .querySelectorAll("th")
      .forEach((th) =>
        th.addEventListener("click", () => {
          prodState.sort = th.dataset.k
          draw()
        }),
      )
    $("#ptable")
      .querySelectorAll("tr[data-g]")
      .forEach((tr) => tr.addEventListener("click", () => go("product", tr.dataset.g)))
  }
  $("#pq").addEventListener("input", (e) => {
    prodState.q = e.target.value
    draw()
  })
  $("#ps").addEventListener("change", (e) => {
    prodState.sector = e.target.value
    draw()
  })
  $("#pm").addEventListener("change", (e) => {
    prodState.made = e.target.value
    draw()
  })
  draw()
}

const okBadge = (ok, yes = "Yes", no = "No") =>
  `<span class="status ${ok ? "ok" : "no"}">${ok ? "✓ " + yes : "✕ " + no}</span>`
const LAYER = {
  scientific: "Scientific feasibility - is the science understood?",
  engineering: "Engineering feasibility - can anyone here design it?",
  manufacturing: "Manufacturing feasibility - machines, precision, inputs, sites, skilled people",
  economic: "Economic viability - can it be made cheaper than importing?",
}
function supplyChip(s) {
  const where = s.domestic
    ? `${s.domestic} domestic maker(s)`
    : s.endowment
      ? "natural endowment"
      : s.importable
        ? "import only"
        : s.restricted
          ? "export-controlled abroad"
          : `not available (world: ${s.world_year > 3000 ? "never" : s.world_year})`
  return `<span class="chip ${s.ok ? "ok" : s.optional ? "opt" : "no"}" data-g="${s.id}" title="${s.alternatives.join(" / ")}">${s.role === "input" ? "" : "⚙ "}${esc(s.name)}${s.qty ? ` ×${fmtNum(s.qty)}` : ""} · ${where}${s.precision_um && !s.precision_ok ? " · precision too coarse" : ""}${s.optional ? " · optional upgrade" : ""}</span>`
}
async function vProduct() {
  const gid = S.productId
  const g = S.goodsById[gid]
  main().innerHTML = `<div class="empty">Analyzing ${esc(g?.name || gid)}… (reconstructing the economy at ${tickLabel(S.cursor + 1)})</div>`
  const [r, rec] = await Promise.all([
    api(`/api/timelines/${S.tid}/good/${gid}?tick=${S.cursor + 1}`),
    api(`/api/catalog/good/${gid}`),
  ])
  const ex = r.explain
  const procHtml = ex.processes
    .map((p, i) => {
      const rp = rec.processes.find((x) => x.id === p.id) || {}
      const Lr = p.layers
      const sci =
        Lr.scientific.items
          .map(
            (k) =>
              `<span class="chip ${k.ok ? "ok" : "no"}" title="${k.kind} · world since ${S.knowById[k.id]?.year_eff}">${esc(k.name)} <span class="level"><i style="width:${k.level * 100}%"></i></span> ${fmtPct(k.level, 0)}</span>`,
          )
          .join("") || '<span class="muted">No special knowledge needed.</span>'
      const eng = Lr.engineering
      const man = Lr.manufacturing
      const lab = man.labor
        .map(
          (l) =>
            `<tr><td>${esc(l.name)}</td><td class="num">${fmtNum(l.hours)}</td><td class="num">${fmtNum(l.workers)}</td><td class="num">${l.avg_skill.toFixed(2)}</td><td>${okBadge(l.ok, "available", "none in country")}</td></tr>`,
        )
        .join("")
      const eco = Lr.economic
      return `<div class="card" style="margin-top:12px"><h2>${p.trad ? "Traditional (pre-industrial) method" : i === 0 ? "Main process" : "Alternative process: " + esc(p.id)}<small>possible in the world since ${p.year > 3000 ? "never" : p.year}</small></h2>
      <div class="layer ${Lr.scientific.ok ? "ok" : "no"}"><b>${LAYER.scientific}</b> ${okBadge(Lr.scientific.ok)}<div class="chips" style="margin-top:6px">${sci}</div></div>
      <div class="layer ${eng.ok ? "ok" : "no"}"><b>${LAYER.engineering}</b> ${okBadge(eng.ok)}
        <div class="muted">Best domestic design: ${fmtPct(eng.best_design, 0)} · reproducing it from scratch takes ~${fmtNum(eng.design_effort_py)} engineer-years · disassembling an import reveals ~${fmtPct(eng.reverse_engineering, 0)} of how it is made.</div>
        ${eng.in_rd.map((x) => `<div>R&amp;D: ${esc(x.firm)} at ${fmtPct(x.progress, 0)}${x.blocked ? ` - <span class="status no">${esc(x.blocked)}</span>` : ""}</div>`).join("")}</div>
      <div class="layer ${man.ok ? "ok" : "no"}"><b>${LAYER.manufacturing}</b> ${okBadge(man.ok)}
        <div class="muted">${man.tolerance_um ? `Tightest tolerance ${man.tolerance_um} µm (the maker's machines must hold within ~4× of this). ` : ""}${man.cleanroom ? `Needs a ${S.goodsById[man.cleanroom]?.name}. ` : ""}Sites: ${man.site.regions.length ? esc(man.site.regions.join(", ")) : '<span class="status no">no suitable region</span>'}${man.site.deposit ? ` (needs a ${man.site.deposit} deposit)` : ""}.</div>
        <h3>Equipment &amp; inputs <span class="muted">(click to drill down)</span></h3><div class="chips">${man.supplies.map(supplyChip).join("")}</div>
        <h3>People</h3><table class="data"><thead><tr><th>Occupation</th><th class="num">Hours / unit</th><th class="num">Workers in country</th><th class="num">Avg skill</th><th></th></tr></thead><tbody>${lab}</tbody></table></div>
      <div class="layer ${eco.ok ? "ok" : "no"}"><b>${LAYER.economic}</b> ${okBadge(eco.ok)}
        <div>Estimated domestic unit cost <b>${fmtMoney(eco.est_domestic_cost)}</b> · landed import price <b>${eco.import_price ? fmtMoney(eco.import_price) : "not importable"}</b> · current market price <b>${fmtMoney(eco.domestic_price)}</b></div></div>
      ${rp.co2 ? `<div class="muted">Emits ${rp.co2} t CO₂ per unit.</div>` : ""}</div>`
    })
    .join("")
  main().innerHTML = `<div class="toolbar"><button id="backBtn" class="small">← Products</button></div>
    <h1>${esc(ex.name)}</h1>
    <p class="lead">${esc(g.sector)} · unit: ${esc(g.unit)} · first possible anywhere: ${ex.world_year > 3000 ? "never" : ex.world_year}${ex.restricted ? " · <b>export-controlled</b>: foreign makers will not sell it" : ""}.
      ${ex.producers.length ? `Made here by ${ex.producers.length} firm(s).` : "Not currently made in this country."}</p>
    <div class="grid g2">${chartCard("gp_price", "Price")}${chartCard("gp_q", "Domestic output vs imports vs exports", "units / month")}</div>
    ${
      ex.producers.length
        ? `<div class="card" style="margin-top:12px"><h2>Domestic producers</h2><table class="data"><thead><tr><th>Firm</th><th>Region</th><th class="num">Output</th><th class="num">Design</th><th class="num">Generation</th><th class="num">Quality</th><th>Constraint</th></tr></thead><tbody>
      ${ex.producers.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.region)}</td><td class="num">${fmtNum(f.output)}</td><td class="num">${fmtPct(f.design, 0)}</td><td class="num">${f.gen}</td><td class="num">${f.quality.toFixed(2)}</td><td>${esc(f.blocked || "")}</td></tr>`).join("")}</tbody></table></div>`
        : ""
    }
    ${procHtml}
    <div class="grid g2" style="margin-top:12px"><div class="card"><h2>Used as an input by</h2><div class="chips">${rec.used_in.map((x) => `<span class="chip" data-g="${x.id}">${esc(x.name)}</span>`).join("") || '<span class="muted">Final product</span>'}</div></div>
      <div class="card"><h2>Used as equipment by</h2><div class="chips">${rec.used_as_equipment_by.map((x) => `<span class="chip" data-g="${x.id}">${esc(x.name)}</span>`).join("") || '<span class="muted">—</span>'}</div></div></div>`
  $("#backBtn").addEventListener("click", () => go("products"))
  main()
    .querySelectorAll("[data-g]")
    .forEach((c) => c.addEventListener("click", () => go("product", c.dataset.g)))
  const ser = r.series
  if (ser.length) {
    C.lineChart($("#gp_price"), {
      series: [{ name: "Price", points: ser.map((x) => [x.tick, x.price]) }],
      xfmt: xfmtYear,
      yfmt: fmtMoney,
      markers: markers(),
      height: 200,
    })
    C.lineChart($("#gp_q"), {
      series: [
        { name: "Domestic output", points: ser.map((x) => [x.tick, x.output]) },
        { name: "Imports", points: ser.map((x) => [x.tick, x.imports]) },
        { name: "Exports", points: ser.map((x) => [x.tick, x.exports]) },
      ],
      xfmt: xfmtYear,
      yfmt: fmtNum,
      markers: markers(),
      height: 200,
    })
  } else $("#gp_price").innerHTML = '<div class="muted">Never traded in this economy so far.</div>'
}

// ------------------------------------------------------------------ INDUSTRY
const indState = { sector: "", owner: "", sort: "revenue" }
async function vIndustry() {
  const d = await api(`/api/timelines/${S.tid}/detail/firms?tick=${S.cursor + 1}`)
  const firms = d.data || []
  const m = lastMetric() || {}
  const sectors = [...new Set(firms.map((f) => f.sector))].sort()
  main().innerHTML = `<h1>Industry &amp; firms</h1>
    <p class="lead">Firm-level snapshot from ${d.tick !== null ? tickLabel(d.tick) : "—"} (firm details are saved yearly and at the latest month). Firms enter when imports or shortages signal profit, exit when they run out of money, switch technologies when wages or prices change, and run R&amp;D.</p>
    <div class="grid g2">${chartCard("indVA", "Value added by sector", tickLabel(S.cursor))}${chartCard("indOwn", "Ownership & technology")}</div>
    <div class="card" style="margin-top:14px"><div class="toolbar"><select id="isec"><option value="">All sectors</option>${sectors.map((s) => `<option ${s === indState.sector ? "selected" : ""}>${s}</option>`).join("")}</select>
      <select id="iown"><option value="">All owners</option>${["private", "state", "foreign"].map((o) => `<option ${o === indState.owner ? "selected" : ""}>${o}</option>`).join("")}</select><span class="muted" id="icount"></span></div>
      <div class="scroll" id="itable"></div></div>`
  C.barList(
    $("#indVA"),
    Object.entries(m.sector_va || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({
        label: k,
        value: v,
        color: "var(--series-1)",
        tip: fmtMoney(v) + " / month" + perCapitaTip(v, true),
      })),
    { fmt: fmtMoney },
  )
  const own = {}
  for (const f of firms) {
    const k = `${f.owner}${f.trad ? " · traditional" : ""}${f.design < 1 ? " · in R&D" : ""}`
    own[k] = (own[k] || 0) + 1
  }
  C.barList(
    $("#indOwn"),
    Object.entries(own)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v], i) => ({ label: k, value: v, color: C.seriesColor(i) })),
    { fmt: (v) => fmtNum(v) + " firms" },
  )
  const rname = (i) => S.regions.find((r) => r.id === i)?.name || i
  const draw = () => {
    const list = firms.filter(
      (f) =>
        (!indState.sector || f.sector === indState.sector) &&
        (!indState.owner || f.owner === indState.owner),
    )
    list.sort((a, b) => (b[indState.sort] ?? 0) - (a[indState.sort] ?? 0))
    $("#icount").textContent = `${list.length} firms`
    const cols = [
      ["name", "Firm"],
      ["good_name", "Product"],
      ["region", "Region"],
      ["owner", "Owner"],
      ["revenue", "Revenue / mo", "num"],
      ["exports", "Exports / mo", "num"],
      ["staff", "Workers", "num"],
      ["profit", "Profit / mo", "num"],
      ["util", "Utilization", "num"],
      ["design", "Design", "num"],
      ["quality", "Quality", "num"],
      ["blocked", "Constraint"],
    ]
    $("#itable").innerHTML =
      `<table class="data"><thead><tr>${cols.map(([k, l, c]) => `<th class="${c || ""}" data-k="${k}">${l}${indState.sort === k ? " ▾" : ""}</th>`).join("")}</tr></thead><tbody>${list
        .slice(0, 500)
        .map(
          (f) => `<tr class="clickable" data-g="${f.good}">
      <td>${esc(f.name)}</td><td>${esc(f.good_name)}${f.trad ? ' <span class="pill">traditional</span>' : ""}</td><td>${esc(rname(f.region))}</td><td>${f.owner}</td><td class="num">${fmtMoney(f.revenue)}</td><td class="num">${fmtMoney(f.exports)}</td>
      <td class="num">${fmtNum(f.staff)}</td><td class="num">${fmtMoney(f.profit)}</td><td class="num">${fmtPct(f.util, 0)}</td><td class="num">${fmtPct(f.design, 0)}</td><td class="num">${f.quality.toFixed(2)}</td><td>${esc(f.blocked || "")}</td></tr>`,
        )
        .join("")}</tbody></table>`
    $("#itable")
      .querySelectorAll("th")
      .forEach((th) =>
        th.addEventListener("click", () => {
          indState.sort = th.dataset.k
          draw()
        }),
      )
    $("#itable")
      .querySelectorAll("tr[data-g]")
      .forEach((tr) => tr.addEventListener("click", () => go("product", tr.dataset.g)))
  }
  $("#isec").addEventListener("change", (e) => {
    indState.sector = e.target.value
    draw()
  })
  $("#iown").addEventListener("change", (e) => {
    indState.owner = e.target.value
    draw()
  })
  draw()
}

// ------------------------------------------------------------------ LABOR
const EDU = ["none", "primary", "secondary", "vocational", "bachelor", "graduate"]
async function vLabor() {
  const d = await api(`/api/timelines/${S.tid}/detail/labor?tick=${S.cursor + 1}`)
  const occ = d.data || {}
  main().innerHTML = `<h1>Labor, talent &amp; education</h1>
    <p class="lead">People are agents with an education level, a field of study, an occupation and skills that grow on the job and fade in unemployment. Schools are only as good as the teachers the education budget hires; students choose fields by expected wages and the seats you fund.</p>
    <div class="grid g2">${chartCard("lb_att", "Education attainment of adults (25+)")}${chartCard("lb_school", "Average years of schooling & tertiary share")}
      ${chartCard("lb_wage", "Average & median wage", "nominal, monthly")}${chartCard("lb_mig", "Immigration & emigration", "people / month")}</div>
    <div class="card" style="margin-top:14px"><h2>Occupations <small>${d.tick !== null ? tickLabel(d.tick) : ""}</small></h2><div class="scroll" id="occTable"></div></div>`
  if (S.series.length) {
    const lv = ["No schooling", "Primary", "Secondary", "Vocational", "Bachelor", "Graduate"]
    C.stackedArea($("#lb_att"), {
      x: S.series.map((m) => m.tick),
      xfmt: xfmtYear,
      yfmt: (v) => fmtPct(v, 0),
      height: 220,
      series: lv.map((n, i) => ({
        name: n,
        values: S.series.map((m) => (m.edu_attainment || [])[i] || 0),
      })),
    })
    line(
      "lb_school",
      [
        {
          name: "Avg years of schooling",
          key: "avg_school_years",
          points: pts("avg_school_years"),
        },
      ],
      { yfmt: (v) => v.toFixed(1), zero: false, height: 150 },
    )
    const t2 = document.createElement("div")
    $("#lb_school").appendChild(t2)
    C.lineChart(t2, {
      series: [
        { name: "Adults with a degree", points: pts("tertiary_share"), color: "var(--series-3)" },
      ],
      xfmt: xfmtYear,
      yfmt: (v) => fmtPct(v, 0),
      height: 130,
    })
    line(
      "lb_wage",
      [
        { name: "Average wage", key: "avg_wage", points: pts("avg_wage") },
        {
          name: "Median wage",
          key: "median_wage",
          points: pts("median_wage"),
          color: "var(--series-2)",
        },
      ],
      { yfmt: fmtMoney },
    )
    line(
      "lb_mig",
      [
        { name: "Immigrants", key: "immigrants", points: pts("immigrants") },
        { name: "Emigrants", key: "emigrants", points: pts("emigrants"), color: "var(--series-2)" },
      ],
      { yfmt: fmtNum },
    )
  }
  const rows = Object.entries(occ)
    .map(([o, v]) => ({ o, name: S.occById[o]?.name || o, ...v, u: v.lf ? 1 - v.emp / v.lf : 0 }))
    .sort((a, b) => b.lf - a.lf)
  $("#occTable").innerHTML =
    `<table class="data"><thead><tr><th>Occupation</th><th class="num">Labor force</th><th class="num">Employed</th><th class="num">Unemployment</th><th class="num">Vacancies</th><th class="num">Wage / month</th><th class="num">Avg skill</th><th class="num">Min. education</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmtNum(r.lf)}</td><td class="num">${fmtNum(r.emp)}</td><td class="num">${fmtPct(r.u)}</td><td class="num">${fmtNum(r.vacancies)}</td><td class="num">${fmtMoney(r.wage)}</td><td class="num">${r.skill.toFixed(2)}</td><td class="num">${EDU[S.occById[r.o]?.edu || 0]}</td></tr>`).join("")}</tbody></table>`
}

// ------------------------------------------------------------------ KNOWLEDGE
const kState = { field: "", status: "" }
const KSTATUS = ["mastered", "understood", "learning", "known abroad only", "undiscovered"]
async function vKnowledge() {
  const d = await api(`/api/timelines/${S.tid}/detail/knowledge?tick=${S.cursor + 1}`)
  const K = d.data || {}
  const year = yearOf(d.tick ?? S.cursor)
  const nodes = S.catalog.knowledge.map((k) => {
    const lv = K[k.id] ?? 0
    const world = k.year_eff <= year
    const st =
      lv >= 0.95
        ? "mastered"
        : lv >= 0.5
          ? "understood"
          : lv > 0.02
            ? "learning"
            : world
              ? "known abroad only"
              : "undiscovered"
    return { ...k, lv, st }
  })
  const fields = [...new Set(nodes.map((n) => n.field))].sort()
  main().innerHTML = `<h1>Knowledge &amp; invention</h1>
    <p class="lead">${nodes.length} pieces of knowledge, from settled agriculture to EUV lithography. Products need them at ≥50% to be designed. Science spreads from world literature only if the workforce is educated enough to absorb it; process know-how grows by practice and <b>fades when nobody practices it</b>. Research beyond the world frontier is uncertain and can hit dead ends.</p>
    <div class="grid g2">${chartCard("kn_idx", "Average knowledge level")}${chartCard("kn_eff", "Research effort", "person-years per year")}</div>
    <div class="card" style="margin-top:14px"><div class="toolbar"><select id="kf"><option value="">All fields</option>${fields.map((f) => `<option ${f === kState.field ? "selected" : ""}>${f}</option>`).join("")}</select>
      <select id="ks"><option value="">Any status</option>${KSTATUS.map((s) => `<option ${s === kState.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div class="scroll" id="ktable"></div></div>`
  line(
    "kn_idx",
    [{ name: "Knowledge index", key: "knowledge_index", points: pts("knowledge_index") }],
    { yfmt: (v) => fmtPct(v, 0), zero: false },
  )
  line(
    "kn_eff",
    [
      { name: "Public research", key: "research_py", points: pts("research_py") },
      { name: "Business R&D", key: "rd_py", points: pts("rd_py"), color: "var(--series-2)" },
    ],
    { yfmt: fmtNum },
  )
  const kind = { sci: "science", eng: "engineering", proc: "process know-how" }
  const draw = () => {
    const list = nodes
      .filter(
        (n) =>
          (!kState.field || n.field === kState.field) && (!kState.status || n.st === kState.status),
      )
      .sort((a, b) => a.year_eff - b.year_eff)
    $("#ktable").innerHTML =
      `<table class="data"><thead><tr><th>Knowledge</th><th>Kind</th><th>Field</th><th class="num">World since</th><th>Domestic level</th><th>Status</th><th>Requires</th></tr></thead><tbody>${list
        .map(
          (
            n,
          ) => `<tr><td>${esc(n.name)}</td><td>${kind[n.kind]}</td><td>${n.field}</td><td class="num">${n.year_eff < 0 ? -n.year_eff + " BC" : n.year_eff}</td>
      <td><span class="level"><i style="width:${n.lv * 100}%"></i></span> ${fmtPct(n.lv, 0)}</td><td>${n.st}</td><td class="muted">${n.prereqs.map((p) => esc(S.knowById[p]?.name || p)).join(", ")}</td></tr>`,
        )
        .join("")}</tbody></table>`
  }
  $("#kf").addEventListener("change", (e) => {
    kState.field = e.target.value
    draw()
  })
  $("#ks").addEventListener("change", (e) => {
    kState.status = e.target.value
    draw()
  })
  draw()
}

// ------------------------------------------------------------------ REGIONS
const regState = { metric: "pop", sel: null }
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
async function vRegions() {
  const d = await api(`/api/timelines/${S.tid}/detail/regions?tick=${S.cursor + 1}`)
  const regs = d.data?.regions || []
  const rm = (lastMetric() || {}).regions || {}
  const metrics = {
    pop: ["Population", (r) => r.pop, fmtNum],
    urban: ["Urban share", (r) => r.urban_pop / Math.max(1, r.pop), fmtPct],
    unemp: ["Unemployment", (r) => rm[r.id]?.unemployment, fmtPct],
    wage: ["Average wage", (r) => rm[r.id]?.avg_wage, fmtMoney],
    rent: ["Rent", (r) => r.rent, fmtMoney],
    crowd: ["People per dwelling", (r) => r.pop / Math.max(1, r.dwellings), (v) => v.toFixed(2)],
    prod: ["Agglomeration productivity", (r) => r.productivity, (v) => v.toFixed(3)],
    road: ["Road quality", (r) => r.infra.road, fmtPct],
    grid: ["Grid quality", (r) => r.infra.grid, fmtPct],
    transit: ["Transit quality", (r) => r.infra.transit, fmtPct],
  }
  main().innerHTML = `<h1>Regions &amp; cities</h1>
    <p class="lead">Each region has its own geology, climate, land and infrastructure. Mines appear where deposits are, farms where the climate suits the crop, and cities grow where jobs are - limited by zoning, land and transit. Circle size = population; color = the selected measure.</p>
    <div class="grid g2"><div class="card"><div class="toolbar"><select id="rmet">${Object.entries(
      metrics,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${k === regState.metric ? "selected" : ""}>${v[0]}</option>`,
      )
      .join("")}</select>
      <span class="legend-scale">low <span class="ramp"></span> high</span></div><div id="rmap" class="region-map"></div></div>
      <div class="card" id="rdetail"></div></div>`
  const [label, f, fmt] = metrics[regState.metric]
  const host = $("#rmap")
  const W = host.clientWidth || 500
  const H = 440
  const xs = regs.map((r) => r.pos[0])
  const ys = regs.map((r) => r.pos[1])
  const X = (x) =>
    60 + ((x - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs) || 1)) * (W - 120)
  const Y = (y) =>
    50 + ((y - Math.min(...ys)) / (Math.max(...ys) - Math.min(...ys) || 1)) * (H - 120)
  const vals = regs.map((r) => f(r) ?? 0)
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const col = (v) => RAMP[Math.min(6, Math.floor(((v - lo) / (hi - lo || 1)) * 6.999))]
  const maxPop = Math.max(...regs.map((r) => r.pop), 1)
  let svg = `<svg width="${W}" height="${H}">`
  for (let i = 0; i < regs.length; i++)
    for (let j = i + 1; j < regs.length; j++)
      svg += `<line x1="${X(regs[i].pos[0])}" y1="${Y(regs[i].pos[1])}" x2="${X(regs[j].pos[0])}" y2="${Y(regs[j].pos[1])}"/>`
  regs.forEach((r, i) => {
    const rad = 10 + 30 * Math.sqrt(r.pop / maxPop)
    svg += `<circle cx="${X(r.pos[0])}" cy="${Y(r.pos[1])}" r="${rad}" fill="${col(vals[i])}" data-r="${r.id}"/>`
    svg += `<text x="${X(r.pos[0])}" y="${Y(r.pos[1]) + rad + 14}" text-anchor="middle">${esc(r.name)}${r.port ? " ⚓" : ""}</text>`
  })
  host.innerHTML = svg + "</svg>"
  const drawDetail = () => {
    const r = regs.find((x) => x.id === regState.sel) || regs[0]
    if (!r) return
    const st = rm[r.id] || {}
    const deps = Object.entries(r.deposits)
      .filter(([k, v]) => v.kind !== "flow" || ["hydro", "wind", "solar"].includes(k))
      .sort((a, b) => b[1].grade - a[1].grade)
    const crops = Object.entries(r.suit)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
    $("#rdetail").innerHTML =
      `<h2>${esc(r.name)}<small>${r.arch.replace("_", " ")}${r.port ? " · seaport" : ""}</small></h2>
      <div class="muted">${fmtNum(r.area)} km² · ${r.temp.toFixed(1)}°C · ${fmtNum(r.rain)} mm rain/yr · city area ${fmtNum(r.urban_km2)} km²</div>
      <table class="data" style="margin-top:8px"><tbody>
      <tr><td>Population</td><td class="num">${fmtNum(r.pop)} (${fmtPct(r.urban_pop / Math.max(1, r.pop), 0)} urban)</td></tr>
      <tr><td>Unemployment</td><td class="num">${fmtPct(st.unemployment)}</td></tr><tr><td>Average wage</td><td class="num">${fmtMoney(st.avg_wage)}</td></tr>
      <tr><td>Rent / dwellings</td><td class="num">${fmtMoney(r.rent)} · ${fmtNum(r.dwellings)} homes (cap ${fmtNum(st.dwelling_cap)})</td></tr>
      <tr><td>Wages paid here</td><td class="num">${fmtMoney(st.va)} / month</td></tr></tbody></table>
      <h3>Infrastructure</h3><div id="rinfra"></div>
      <h3>Natural resources <span class="muted">(grade, remaining)</span></h3><div class="chips">${deps.map(([k, v]) => `<span class="chip">${k} · ${v.grade.toFixed(2)}${v.kind === "stock" ? " · " + fmtPct(v.qty / Math.max(v.qty0, 1), 0) + " left" : ""}</span>`).join("") || '<span class="muted">none of note</span>'}</div>
      <h3>Best-suited crops &amp; livestock</h3><div class="chips">${crops.map(([k, v]) => `<span class="chip">${esc(S.goodsById[k]?.name || k)} ${fmtPct(v, 0)}</span>`).join("")}</div>`
    C.barList(
      $("#rinfra"),
      Object.entries(r.infra).map(([k, v]) => ({ label: k, value: v, color: "var(--series-1)" })),
      { fmt: (v) => fmtPct(v, 0) },
    )
  }
  host.querySelectorAll("circle").forEach((c) => {
    const r = regs.find((x) => x.id === +c.dataset.r)
    c.addEventListener("mousemove", (ev) =>
      C.showTip(
        `<div class="tip-h">${esc(r.name)}</div>${label}: <b>${fmt(f(r) ?? 0)}</b>`,
        ev.clientX,
        ev.clientY,
      ),
    )
    c.addEventListener("mouseleave", C.hideTip)
    c.addEventListener("click", () => {
      regState.sel = r.id
      drawDetail()
    })
  })
  $("#rmet").addEventListener("change", (e) => {
    regState.metric = e.target.value
    render()
  })
  drawDetail()
}

// ------------------------------------------------------------------ LEDGER
const ledState = { account: "", kind: "", offset: 0, from: null, to: null }
async function vLedger() {
  if (ledState.to === null || ledState.to > S.head - 1) {
    ledState.to = S.cursor
    ledState.from = S.cursor
  }
  const q = new URLSearchParams({
    from: ledState.from,
    to: ledState.to,
    account: ledState.account,
    kind: ledState.kind,
    limit: 300,
    offset: ledState.offset,
  })
  const r = await api(`/api/timelines/${S.tid}/ledger?${q}`)
  main().innerHTML = `<h1>Ledger</h1>
    <p class="lead">Every payment, stored in SQLite: wages, purchases, taxes, transfers, loans, interest, dividends, imports and exports. Large firm-level flows keep the firm's name; small ones are rolled up into sector accounts. Accounts: <span class="pill">hh:&lt;region&gt;</span> households, <span class="pill">gov</span>, <span class="pill">bank</span>, <span class="pill">row</span> rest of world, <span class="pill">firm:&lt;id&gt;</span>, <span class="pill">sector:&lt;name&gt;</span>, <span class="pill">market:&lt;sector&gt;</span>.</p>
    <div class="card"><div class="toolbar">
      <label>From month <input type="number" id="lf" value="${ledState.from}" min="0" max="${S.head - 1}" style="width:80px"></label>
      <label>to <input type="number" id="lt" value="${ledState.to}" min="0" max="${S.head - 1}" style="width:80px"></label>
      <label>Account <input type="text" id="la" value="${esc(ledState.account)}" placeholder="e.g. gov, hh, firm:12" style="width:150px"></label>
      <label>Kind <select id="lk"><option value="">all</option>${r.kinds.map((k) => `<option ${k === ledState.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
      <button id="lgo" class="primary small">Query</button><button id="lcsv" class="small">Download CSV</button>
      <span class="muted">${fmtNum(r.total)} entries · showing ${ledState.offset + 1}–${Math.min(r.total, ledState.offset + 300)}</span>
      <button id="lprev" class="small" ${ledState.offset ? "" : "disabled"}>‹</button><button id="lnext" class="small" ${ledState.offset + 300 < r.total ? "" : "disabled"}>›</button></div>
      <div class="scroll"><table class="data"><thead><tr><th>Month</th><th>From</th><th>To</th><th>Kind</th><th class="num">Amount</th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr><td>${tickLabel(x.tick)}</td><td title="${esc(x.src)}">${esc(r.labels[x.src] || x.src)}</td><td title="${esc(x.dst)}">${esc(r.labels[x.dst] || x.dst)}</td><td>${esc(x.kind)}</td><td class="num">${fmtMoney(x.amount, 4)}</td></tr>`).join("")}</tbody></table></div></div>`
  const read = () => {
    ledState.from = +$("#lf").value
    ledState.to = +$("#lt").value
    ledState.account = $("#la").value.trim()
    ledState.kind = $("#lk").value
  }
  $("#lgo").addEventListener("click", () => {
    read()
    ledState.offset = 0
    render()
  })
  $("#lprev").addEventListener("click", () => {
    ledState.offset = Math.max(0, ledState.offset - 300)
    render()
  })
  $("#lnext").addEventListener("click", () => {
    ledState.offset += 300
    render()
  })
  $("#lcsv").addEventListener("click", () => {
    const csv =
      "tick,from,to,kind,amount\n" +
      r.rows
        .map((x) =>
          [x.tick, x.src, x.dst, x.kind, x.amount]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(","),
        )
        .join("\n")
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }))
    a.download = `ledger_${S.tid}_${ledState.from}-${ledState.to}.csv`
    a.click()
  })
}

// ------------------------------------------------------------------ EVENTS
const evState = { kinds: [], search: "" }
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
async function vEvents() {
  const q = new URLSearchParams({
    to: S.cursor,
    kinds: evState.kinds.join(","),
    search: evState.search,
    limit: 500,
  })
  const r = await api(`/api/timelines/${S.tid}/events?${q}`)
  main().innerHTML = `<h1>What happened</h1><p class="lead">Inventions, failed experiments, start-ups, bankruptcies, technology switches and policy decisions up to ${tickLabel(S.cursor)}.</p>
    <div class="card"><div class="toolbar">${EV_KINDS.map((k) => `<span class="chip ${evState.kinds.includes(k) ? "ok" : ""}" data-k="${k}">${k}</span>`).join("")}
      <input type="text" id="evs" placeholder="Search…" value="${esc(evState.search)}"></div>
      ${r.events.map((e) => `<div class="event"><span class="when">${tickLabel(e.tick)}</span><span class="kind"><span class="pill">${e.kind}</span></span><span>${esc(e.text)}${e.data?.good ? ` <a href="#" data-g="${e.data.good}">→</a>` : ""}</span></div>`).join("") || '<div class="muted">No events.</div>'}</div>`
  main()
    .querySelectorAll("[data-k]")
    .forEach((c) =>
      c.addEventListener("click", () => {
        const k = c.dataset.k
        evState.kinds = evState.kinds.includes(k)
          ? evState.kinds.filter((x) => x !== k)
          : [...evState.kinds, k]
        render()
      }),
    )
  $("#evs").addEventListener("change", (e) => {
    evState.search = e.target.value
    render()
  })
  main()
    .querySelectorAll("[data-g]")
    .forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault()
        go("product", a.dataset.g)
      }),
    )
}

// ------------------------------------------------------------------ CATALOG
const catState = { q: "", cat: "" }
function vCatalog() {
  const cats = [...new Set(S.catalog.goods.map((g) => g.cat))].sort()
  const sm = S.meta.summary
  main().innerHTML = `<h1>Catalog of everything</h1>
    <p class="lead">${sm.goods} goods and services, ${sm.processes} production processes, ${sm.knowledge} knowledge nodes and ${sm.occupations} occupations. Each product is a structured engineering object: inputs (with substitutes), equipment, precision tolerance, cleanroom class, energy, skills and knowledge. The year shown is when the world could first make it - derived from its whole supply chain, not typed in.</p>
    <div class="card"><div class="toolbar"><input type="text" id="cq" placeholder="Search…" value="${esc(catState.q)}"><select id="cc"><option value="">All categories</option>${cats.map((c) => `<option ${c === catState.cat ? "selected" : ""}>${c}</option>`).join("")}</select></div><div class="scroll" id="ctable"></div></div>`
  const draw = () => {
    const list = S.catalog.goods
      .filter(
        (g) =>
          (!catState.q || g.name.toLowerCase().includes(catState.q.toLowerCase())) &&
          (!catState.cat || g.cat === catState.cat),
      )
      .sort((a, b) => a.year - b.year)
    $("#ctable").innerHTML =
      `<table class="data"><thead><tr><th>Product</th><th>Category</th><th class="num">World since</th><th class="num">2025 world price</th><th>Unit</th><th class="num">Tolerance</th><th>Notes</th></tr></thead><tbody>${list
        .map(
          (g) => `<tr class="clickable" data-g="${g.id}">
      <td>${esc(g.name)}</td><td>${g.cat}</td><td class="num">${g.year < 0 ? -g.year + " BC" : g.year}</td><td class="num">${fmtMoney(g.price)}</td><td>${esc(g.unit)}</td><td class="num">${g.tol ? g.tol + " µm" : ""}</td>
      <td>${[g.need ? "consumer: " + (S.meta.needs[g.need] || g.need) : "", g.capital ? "capital good" : "", g.svc ? "service" : "", g.clean ? "cleanroom" : "", g.restricted ? "export-controlled" : "", g.nt ? "non-tradable" : ""].filter(Boolean).join(" · ")}</td></tr>`,
        )
        .join("")}</tbody></table>`
    $("#ctable")
      .querySelectorAll("tr[data-g]")
      .forEach((tr) => tr.addEventListener("click", () => go("product", tr.dataset.g)))
  }
  $("#cq").addEventListener("input", (e) => {
    catState.q = e.target.value
    draw()
  })
  $("#cc").addEventListener("change", (e) => {
    catState.cat = e.target.value
    draw()
  })
  draw()
}

// ------------------------------------------------------------------ ABOUT
function vAbout() {
  main().innerHTML = `<h1>How the simulation works</h1><div class="card" style="max-width:960px">
  <p>Outcomes are meant to <b>emerge</b> from constraints on materials, energy, labor, knowledge, geography and institutions - nothing says "region X is good at Y".</p>
  <h3>Three engines</h3>
  <p><b>Physical.</b> Every good is made by a process: inputs (with substitutes), primary and auxiliary equipment, labor by occupation, knowledge, tolerance (µm) and cleanroom class. Output is limited by equipment, the site (deposit grade and depletion, crop suitability from temperature and rainfall, solar/wind/hydro potential), workers and inputs. Yield falls when the maker's machines are less precise than the product's tolerance; precision-critical goods need cleanrooms. Machines are themselves products, so precision has to be built up: hand tools → lathes → grinders → CNC → ultra-precision machines → lithography steppers.</p>
  <p><b>Economic &amp; social.</b> Thousands of agents (each a group of people) age, study, work, move, have children and die. Firms hire in a matching labor market, set cost-plus prices that respond to inventories, invest when demand and profits justify it, borrow from a bank, export when competitive, and go bankrupt. Households spend by need (Engel curves shift spending from food to services as incomes rise). The government taxes, buys schools, hospitals, research, administration and infrastructure, pays benefits and borrows. A central bank follows a Taylor rule; the currency floats with the current account and relative inflation.</p>
  <p><b>Knowledge &amp; invention.</b> ${S.meta.summary.knowledge} knowledge nodes with prerequisites. Understanding, reproducing, manufacturing economically and improving are separate achievements: national science (research, literature absorption that needs an educated workforce, learning by doing, forgetting), firm designs (uncertain R&amp;D with inconclusive months, setbacks, prototype failures when inputs or precision are missing, reverse engineering limited by how opaque the product is), learning curves (Wright's law) and design generations that can overtake the world frontier.</p>
  <h3>Rewinding</h3><p>The full state is snapshotted every year into SQLite; the simulation is deterministic, so any month can be reconstructed by replay. A decision at a past month creates a branch that shares history up to that point.</p>
  <h3>Honest limits</h3><p>This is selective approximation, not physics: labor hours and equipment throughput are calibrated so processes cover their costs at 2025 world prices; the rest of the world is an exogenous frontier whose prices fall after each technology's introduction; finance is a single bank. Long runs show business cycles and can drift. Use it to explore mechanisms and trade-offs, not to forecast.</p></div>`
}

let booted = false
/** Mount the dashboard into the shell rendered by src/app/page.tsx. */
export function boot() {
  if (booted) return // React strict mode runs effects twice in development
  booted = true
  init().catch((e) => {
    main().innerHTML = `<div class="card">Failed to start: ${esc(e.message)}</div>`
    console.error(e)
  })
}
