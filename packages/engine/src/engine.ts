/**
 * Engine: creates worlds, runs timelines, applies policy decisions, and rewinds/branches by
 * deterministic replay from snapshots.
 *
 * Snapshot convention: a snapshot at tick t is the state at the *start* of month t, before that
 * month's policy decisions are applied. Running a month: apply decisions recorded for
 * (timeline, t) -> simulate month t -> write.
 *
 * Long jobs (creating a world, running decades) are async loops that yield to the event loop
 * between months, so the HTTP API stays responsive while a simulation runs in-process.
 */
import { type Catalog, getCatalog } from "./catalog"
import { applyPatch, type Policy, type PolicyPatch } from "./policy"
import { type Ctx, type Metrics, SECTOR_OF_CAT, Sim } from "./sim"
import { Store } from "./store"
import {
  addEvent,
  generate,
  personFte,
  SCENARIOS,
  type Scenario,
  type World,
  yearOf,
} from "./world"

export const SNAPSHOT_EVERY = 12

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r))

export async function createWorld(
  scenario = "emerging_2025",
  seed = 1,
  burnIn: number | null = null,
  overrides: Partial<Scenario> = {},
  progress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<World> {
  const w = generate(scenario, seed, overrides)
  const n = burnIn ?? SCENARIOS[scenario].burn_in ?? 36
  const s = new Sim(w)
  for (let i = 0; i < n; i++) {
    if (shouldCancel?.()) throw new Error("cancelled")
    s.step()
    progress?.(i + 1, n)
    await yieldToLoop()
  }
  settle(w, n)
  return w
}

/** Synchronous variant (tests, scripts). */
export function createWorldSync(
  scenario = "emerging_2025",
  seed = 1,
  burnIn: number | null = null,
): World {
  const w = generate(scenario, seed)
  const n = burnIn ?? SCENARIOS[scenario].burn_in ?? 36
  const s = new Sim(w)
  for (let i = 0; i < n; i++) s.step()
  settle(w, n)
  return w
}

/** The burn-in is pre-history: reset the clock, keep the settled state. */
function settle(w: World, burnIn: number) {
  w.tick = 0
  for (const f of w.firms.values())
    for (const state of Object.values(f.capabilities ?? {})) state.last_tick = -1
  w.price_index = 1
  const st = w.stats
  st.cpi_hist = [1]
  st.inflation = 0.02
  st.rgdp_hist = []
  w.events = w.events.filter((e) => e.kind === "info").slice(0, 1)
  for (const e of w.events) e.tick = 0
  addEvent(
    w,
    "info",
    `Economy settled after a ${burnIn}-month warm-up: ${w.firms.size} firms operating, ` +
      `unemployment ${((st.unemployment ?? 0) * 100).toFixed(1)}%. The clock starts now.`,
  )
}

export function describePatch(patch: PolicyPatch): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v))
      parts.push(
        `${k}: ${Object.entries(v as Record<string, unknown>)
          .map(([a, b]) => `${a}=${fmtVal(b)}`)
          .join(", ")}`,
      )
    else parts.push(`${k}=${fmtVal(v)}`)
  }
  return parts.join("; ")
}

const fmtVal = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : JSON.stringify(v)

export interface Job {
  kind: "create" | "run"
  state: "running" | "done" | "error" | "cancelled"
  done: number
  total: number
  timeline: number | null
  started: number
  finished?: number
  message: string
}

export class Engine {
  store: Store
  cat: Catalog
  /** timeline id -> World at its head tick */
  cache = new Map<number, World>()
  job: Job | null = null
  private cancelFlag = false
  private knownAccounts = new Map<number, Set<string>>()

  constructor(dbPath: string) {
    this.store = new Store(dbPath)
    this.cat = getCatalog()
  }

  // ----------------------------------------------------------------- jobs
  busy(): boolean {
    return this.job?.state === "running"
  }

  status(): Job | { state: "idle" } {
    return this.job ? { ...this.job } : { state: "idle" }
  }

  cancel() {
    this.cancelFlag = true
  }

  private start(
    kind: Job["kind"],
    fn: () => Promise<void>,
    total: number,
    tid: number | null = null,
  ): Job {
    if (this.busy()) throw new Error("Another simulation job is running")
    this.cancelFlag = false
    const job: Job = {
      kind,
      state: "running",
      done: 0,
      total,
      timeline: tid,
      started: Date.now() / 1000,
      message: "",
    }
    this.job = job
    fn()
      .then(() => {
        if (job.state === "running") job.state = "done"
      })
      .catch((e: unknown) => {
        if (this.cancelFlag) job.state = "cancelled"
        else {
          job.state = "error"
          job.message = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)
        }
      })
      .finally(() => {
        job.finished = Date.now() / 1000
      })
    return job
  }

  // ----------------------------------------------------------- creation
  private async createWork(
    scenario: string,
    seed: number,
    name: string | null,
    burnIn: number | null,
  ) {
    const sc = SCENARIOS[scenario]
    const w = await createWorld(
      scenario,
      seed,
      burnIn,
      {},
      (i) => {
        if (this.job) this.job.done = i
      },
      () => this.cancelFlag,
    )
    const tid = this.store.createTimeline({
      name: name || sc.label,
      scenario,
      seed,
      startYear: w.start_year,
      scale: w.scale,
    })
    this.store.saveSnapshot(tid, 0, w)
    this.writeDetails(tid, w)
    this.store.writeEvents(tid, w.events)
    w.events = []
    this.cache.set(tid, w)
    if (this.job) this.job.timeline = tid
    return tid
  }

  /** Start creating a world in the background; poll status() for progress. */
  create(
    scenario: string,
    seed = 1,
    name: string | null = null,
    burnIn: number | null = null,
  ): Job {
    if (!(scenario in SCENARIOS)) throw new Error(`unknown scenario ${scenario}`)
    const total = burnIn ?? SCENARIOS[scenario].burn_in ?? 36
    return this.start(
      "create",
      async () => {
        await this.createWork(scenario, seed, name, burnIn)
      },
      total,
    )
  }

  /** Create a world and wait for it (tests, scripts). */
  async createNow(
    scenario: string,
    seed = 1,
    name: string | null = null,
    burnIn: number | null = null,
  ) {
    return this.createWork(scenario, seed, name, burnIn)
  }

  // ---------------------------------------------------------- world access
  private eventsAt(tid: number, tick: number) {
    const owner = this.store.ownerOf(tid, tick)
    return this.store.policyEvents(owner, tick, tick + 1, true)
  }

  /** Reconstruct the state at the start of `tick` on this timeline. */
  worldAt(tid: number, tick: number, includeEvents = false): World {
    const tl = this.store.timeline(tid)
    if (!tl) throw new Error("unknown timeline")
    const cached = this.cache.get(tid)
    if (tick === tl.head_tick && cached && !includeEvents) return cached
    const snap = this.store.nearestSnapshot(tid, tick)
    if (snap === null) throw new Error("no snapshot available")
    const w = this.store.loadSnapshot(...snap) as World
    const sim = new Sim(w)
    while (w.tick < tick) {
      for (const e of this.eventsAt(tid, w.tick)) w.policy = applyPatch(w.policy, e.patch)
      sim.step()
      w.events = []
    }
    if (includeEvents)
      for (const e of this.eventsAt(tid, w.tick)) w.policy = applyPatch(w.policy, e.patch)
    return w
  }

  headWorld(tid: number): World {
    const cached = this.cache.get(tid)
    if (cached) return cached
    const tl = this.store.timeline(tid)
    if (!tl) throw new Error("unknown timeline")
    const w = this.worldAt(tid, tl.head_tick)
    this.cache.set(tid, w)
    return w
  }

  effectivePolicy(tid: number): Policy {
    const w = this.headWorld(tid)
    let pol = w.policy
    for (const e of this.eventsAt(tid, w.tick)) pol = applyPatch(pol, e.patch)
    return pol
  }

  // --------------------------------------------------------------- running
  private async runWork(tid: number, months: number, yieldEvery: boolean) {
    const w = this.headWorld(tid)
    const sim = new Sim(w)
    for (let i = 0; i < months; i++) {
      if (this.cancelFlag && this.job) {
        this.job.state = "cancelled"
        break
      }
      const t = w.tick
      for (const e of this.eventsAt(tid, t)) {
        w.policy = applyPatch(w.policy, e.patch)
        addEvent(w, "policy", `Policy decision: ${e.note || describePatch(e.patch)}`, {
          patch: e.patch,
        })
      }
      const [ctx, m] = sim.step()
      this.write(tid, t, w, ctx, m)
      if (w.tick % SNAPSHOT_EVERY === 0) this.store.saveSnapshot(tid, w.tick, w)
      if (w.tick % 12 === 0) this.writeDetails(tid, w)
      this.store.setHead(tid, w.tick)
      if (this.job) this.job.done = i + 1
      if (yieldEvery) await yieldToLoop()
    }
    // always leave a snapshot and details at the head
    this.store.saveSnapshot(tid, w.tick, w)
    this.writeDetails(tid, w)
    this.store.setHead(tid, w.tick)
  }

  /** Start running a timeline in the background; poll status() for progress. */
  run(tid: number, months: number): Job {
    if (!this.store.timeline(tid)) throw new Error("unknown timeline")
    return this.start("run", () => this.runWork(tid, months, true), months, tid)
  }

  /** Run and wait (tests, scripts). */
  async runNow(tid: number, months: number) {
    if (!this.store.timeline(tid)) throw new Error("unknown timeline")
    await this.runWork(tid, months, false)
  }

  private write(tid: number, tick: number, w: World, ctx: Ctx, m: Metrics) {
    const out = new Map<string, number>()
    const prod = new Map<string, number>()
    for (const f of w.firms.values()) {
      const fs = ctx.fs.get(f.id)
      if (fs && fs.net > 0) {
        out.set(f.good, (out.get(f.good) ?? 0) + fs.net)
        prod.set(f.good, (prod.get(f.good) ?? 0) + 1)
      }
    }
    const rows: (string | number)[][] = []
    for (const gid of new Set([...ctx.flows.keys(), ...out.keys()])) {
      const fl = ctx.flows.get(gid) ?? {}
      const nums = [
        out.get(gid) ?? 0,
        fl.dom_sold ?? 0,
        fl.imports ?? 0,
        fl.exports ?? 0,
        fl.hh_qty ?? 0,
        fl.hh_value ?? 0,
        fl.gov_value ?? 0,
        fl.inv_value ?? 0,
        fl.firm_value ?? 0,
        fl.import_value ?? 0,
        fl.export_value ?? 0,
        fl.shortage ?? 0,
      ]
      if (nums.some((x) => Math.abs(x) > 1e-12))
        rows.push([gid, w.prices[gid] ?? 0, ...nums, prod.get(gid) ?? 0])
    }
    this.store.writeMonth(tid, tick, m, rows, this.compactLedger(tid, w, ctx, m), w.events)
    w.events = []
  }

  /**
   * Keep large flows at firm level; roll small ones up into sector accounts. Market
   * pseudo-accounts are per sector.
   */
  private compactLedger(
    tid: number,
    w: World,
    ctx: Ctx,
    m: Metrics,
  ): [string, string, string, number][] {
    const cat = this.cat
    const thr = 0.0002 * Math.max(m.gdp, 1)
    let known = this.knownAccounts.get(tid)
    if (!known) {
      known = new Set()
      this.knownAccounts.set(tid, known)
    }
    const newAcc: [string, string, string][] = []
    const acc = (a: string, amount: number): string => {
      if (a.startsWith("market:")) {
        const gid = a.slice(7)
        const g = cat.goods[gid] as (typeof cat.goods)[string] | undefined
        return `market:${g ? (SECTOR_OF_CAT[g.cat] ?? "Other") : gid}`
      }
      if (a.startsWith("firm:")) {
        const f = w.firms.get(Number(a.slice(5)))
        const sector = f ? (SECTOR_OF_CAT[cat.goods[f.good].cat] ?? "Other") : "Other"
        if (amount < thr) return `sector:${sector}`
        if (f && !known.has(a)) {
          known.add(a)
          newAcc.push([a, `${f.name} (${cat.goods[f.good].name})`, sector])
        }
      }
      return a
    }
    const agg = new Map<string, [string, string, string, number]>()
    for (const [s, d, k, amount] of ctx.ledgerEntries()) {
      if (Math.abs(amount) <= 1e-6) continue
      const s2 = acc(s, amount)
      const d2 = acc(d, amount)
      const key = `${s2}\u0001${d2}\u0001${k}`
      const cur = agg.get(key)
      if (cur) cur[3] += amount
      else agg.set(key, [s2, d2, k, amount])
    }
    if (newAcc.length) this.store.writeAccounts(tid, newAcc)
    return [...agg.values()]
  }

  writeDetails(tid: number, w: World) {
    const cat = this.cat
    const S = w.scale
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4
    const firms = [...w.firms.values()].map((f) => {
      const g = cat.goods[f.good]
      let staff = 0
      for (const v of f.staff.values()) staff += v
      return {
        id: f.id,
        name: f.name,
        good: f.good,
        good_name: g.name,
        cat: g.cat,
        sector: SECTOR_OF_CAT[g.cat] ?? "Other",
        region: f.region,
        owner: f.owner,
        founded: f.founded,
        proc: f.proc,
        trad: cat.procs[f.proc].trad,
        output: f.last.output ?? 0,
        revenue: f.last.revenue ?? 0,
        exports: f.last.exports ?? 0,
        profit: f.profit_ema,
        staff: staff * S,
        cash: f.cash,
        debt: f.debt,
        price: f.price,
        design: f.design,
        gen: f.gen,
        quality: f.quality,
        util: f.util_ema,
        blocked: f.blocked,
        equipment: Object.fromEntries(
          Object.entries(f.equip)
            .filter(([, n]) => n > 1e-6)
            .map(([e, n]) => [e, r4(n)]),
        ),
      }
    })
    this.store.writeDetail(tid, w.tick, "firms", firms)
    this.store.writeDetail(
      tid,
      w.tick,
      "knowledge",
      Object.fromEntries(Object.entries(w.knowledge).map(([k, v]) => [k, r4(v)])),
    )
    interface OccRow {
      lf: number
      emp: number
      skill: number
      inactive: number
      wage: number
      edu: number[]
      vacancies?: number
    }
    const occ: Record<string, OccRow> = {}
    const ret = w.policy.retirement_age * 12
    for (const p of w.persons.values()) {
      if (p.occ === null || p.school || p.age < 15 * 12 || p.age >= ret) continue
      const o = (occ[p.occ] ??= {
        lf: 0,
        emp: 0,
        skill: 0,
        inactive: 0,
        wage: 0,
        edu: [0, 0, 0, 0, 0, 0],
      })
      if (p.inactive) {
        o.inactive += S
        continue
      }
      o.lf += S
      o.emp += personFte(p) * S
      o.skill += (p.skill[p.occ] ?? 0) * S
      o.edu[p.edu] += S
    }
    for (const [o, d] of Object.entries(occ)) {
      d.skill = d.lf ? d.skill / d.lf : 0
      d.wage = w.wage_index[o] ?? 0
      d.vacancies = (w.stats.vacancies_by_occ?.[o] ?? 0) * S
    }
    this.store.writeDetail(tid, w.tick, "labor", occ)
    const regions = w.regions.map((r) => ({
      id: r.id,
      name: r.name,
      arch: r.arch,
      area: r.area,
      urban_km2: r.urban_km2,
      temp: r.temp,
      rain: r.rain,
      sun: r.sun,
      wind: r.wind,
      port: r.port,
      pos: r.pos,
      pop: r.pop * S,
      urban_pop: r.urban_pop * S,
      infra: r.infra,
      dwellings: r.dwellings,
      rent: r.rent,
      productivity: r.productivity,
      land: r.land,
      land_used: r.land_used,
      deposits: Object.fromEntries(
        Object.entries(r.deposits).map(([k, d]) => [
          k,
          { qty: d.qty, qty0: d.qty0, grade: d.grade, kind: d.kind },
        ]),
      ),
      suit: Object.fromEntries(
        Object.entries(r.suit).map(([k, v]) => [k, Math.round(v * 1000) / 1000]),
      ),
    }))
    this.store.writeDetail(tid, w.tick, "regions", { regions, dist: w.dist })
    this.store.writeDetail(tid, w.tick, "state", {
      produced_ever: [...w.produced_ever].toSorted(),
      fx: w.fx,
      price_index: w.price_index,
      gov: { cash: w.gov.cash, debt: w.gov.debt, gdp_est: w.gov.gdp_est },
      bank: w.bank,
      policy: w.policy,
      year: yearOf(w),
      prices: w.prices,
    })
  }

  // ---------------------------------------------------------- decisions
  /**
   * Record a decision. At the head it applies to this timeline; at an earlier tick it creates a
   * branch (rewind).
   */
  applyPolicy(
    tid: number,
    patch: PolicyPatch,
    note = "",
    tick: number | null = null,
    branchName: string | null = null,
  ): { timeline: number; tick: number; branched: boolean } {
    const tl = this.store.timeline(tid)
    if (!tl) throw new Error("unknown timeline")
    const head = tl.head_tick
    if (tick === null || tick >= head) {
      this.store.addPolicy(tid, head, patch, note)
      return { timeline: tid, tick: head, branched: false }
    }
    const nw = this.fork(tid, tick, branchName || `${tl.name} / alt @ ${tick}`, patch, note)
    return { timeline: nw, tick, branched: true }
  }

  fork(
    tid: number,
    tick0: number,
    name: string,
    patch: PolicyPatch | null = null,
    note = "",
  ): number {
    if (this.busy()) throw new Error("A simulation job is running")
    const tl = this.store.timeline(tid)
    if (!tl) throw new Error("unknown timeline")
    const tick = Math.max(0, Math.min(Math.trunc(tick0), tl.head_tick))
    const w = structuredClone(this.worldAt(tid, tick, false))
    const nw = this.store.createTimeline({
      name,
      scenario: tl.scenario,
      seed: tl.seed,
      parentId: tid,
      forkTick: tick,
      startYear: tl.start_year,
      scale: tl.scale,
      note: note || null,
    })
    if (patch && Object.keys(patch).length) this.store.addPolicy(nw, tick, patch, note)
    this.store.saveSnapshot(nw, tick, w)
    this.writeDetails(nw, w)
    this.cache.set(nw, w)
    return nw
  }

  delete(tid: number) {
    if (this.busy()) throw new Error("A simulation job is running")
    const gone = this.descendants(tid)
    gone.add(tid)
    for (const t of gone) this.cache.delete(t)
    this.store.deleteTimeline(tid)
  }

  private descendants(tid: number): Set<number> {
    const out = new Set<number>()
    for (const t of this.store.timelines()) {
      if (t.parent_id === tid) {
        out.add(t.id)
        for (const d of this.descendants(t.id)) out.add(d)
      }
    }
    return out
  }
}
