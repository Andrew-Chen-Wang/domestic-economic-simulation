/**
 * Framework-agnostic API handlers. Each returns plain JSON-serializable data; the Hono router in
 * apps/internal-api wires them to HTTP routes, and the dashboard imports the return types.
 */
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { getCatalog, type Good } from "./catalog"
import { Engine, type Job } from "./engine"
import * as physical from "./physical"
import { defaultPolicy, type PolicyPatch, SCHEMA } from "./policy"
import { SECTOR_OF_CAT } from "./sim"
import type { GoodsRow } from "./store"
import { SCENARIOS, type World } from "./world"

export class ApiError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Repo-root `data/econsim.db` (found by walking up to pnpm-workspace.yaml), or $ECONSIM_DB. */
export function defaultDbPath(): string {
  if (process.env.ECONSIM_DB) return resolve(process.env.ECONSIM_DB)
  let dir = process.cwd()
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, "data", "econsim.db")
    const up = dirname(dir)
    if (up === dir) return resolve("data", "econsim.db")
    dir = up
  }
}

const g = globalThis as unknown as { __econsimEngine?: Engine }
/** One engine per server process (survives Next.js dev reloads). */
export function getEngine(): Engine {
  g.__econsimEngine ??= new Engine(defaultDbPath())
  return g.__econsimEngine
}

const CAT = () => getCatalog()

function timelineOr404(e: Engine, tid: number) {
  const tl = e.store.timeline(tid)
  if (!tl) throw new ApiError("unknown timeline", 404)
  return tl
}

function goodOr404(gid: string): Good {
  const g = CAT().goods[gid] as Good | undefined
  if (!g) throw new ApiError(`unknown good ${gid}`, 404)
  return g
}

// ------------------------------------------------------------------ catalog
export function meta(e: Engine) {
  const cat = CAT()
  return {
    scenarios: Object.fromEntries(
      Object.entries(SCENARIOS).map(([k, v]) => [
        k,
        { label: v.label, desc: v.desc, year: v.year, population: v.population },
      ]),
    ),
    policy_schema: SCHEMA,
    policy_default: defaultPolicy(),
    needs: Object.fromEntries(Object.entries(cat.needs).map(([k, v]) => [k, v[0]])),
    sectors: [...new Set(Object.values(SECTOR_OF_CAT))].toSorted(),
    categories: [...new Set(Object.values(cat.goods).map((g) => g.cat))].toSorted(),
    fields: Object.fromEntries(Object.entries(cat.fields).map(([k, v]) => [k, v[1]])),
    research_fields: [...new Set(Object.values(cat.knowledge).map((k) => k.field))].toSorted(),
    summary: cat.summary(),
    status: e.status(),
  }
}
export type MetaResponse = ReturnType<typeof meta>

export function goodBrief(g: Good) {
  return {
    id: g.id,
    name: g.name,
    cat: g.cat,
    unit: g.unit,
    price: g.price,
    year: g.year,
    need: g.need ? g.need[0] : null,
    tol: g.tol,
    clean: g.clean,
    capital: g.capital,
    svc: g.svc,
    nt: g.nt,
    local: g.local,
    restricted: g.restricted,
    sector: SECTOR_OF_CAT[g.cat] ?? "Other",
    kg: g.kg,
    opq: g.opq,
    prec: g.prec,
  }
}
export type GoodBrief = ReturnType<typeof goodBrief>

export function catalog() {
  const cat = CAT()
  return {
    goods: Object.values(cat.goods)
      .filter((g) => !g.endowment)
      .map(goodBrief),
    knowledge: Object.entries(cat.knowledge).map(([k, v]) => ({ ...v, year_eff: cat.kyear[k] })),
    occupations: Object.values(cat.occupations),
  }
}
export type CatalogResponse = ReturnType<typeof catalog>

export function catalogGood(gid: string) {
  const cat = CAT()
  const g = goodOr404(gid)
  const ref = (a: string) => ({ id: a, name: cat.goods[a].name })
  const processes = g.processes.map((pid) => {
    const p = cat.procs[pid]
    return {
      id: pid,
      trad: p.trad,
      year: p.year,
      rate: p.rate,
      inputs: p.inputs.map(([alts, qty]) => ({
        alts: alts.map(ref),
        qty,
        optional: p.optional.has(alts[0]),
      })),
      equip: (p.equip ?? []).map((a) => ({ ...ref(a), prec: cat.goods[a].prec })),
      aux: Object.entries(p.aux).map(([name, [alts, ratio]]) => ({
        alts: alts.map(ref),
        ratio,
        optional: p.optional.has(name),
      })),
      labor: Object.entries(p.labor).map(([o, hours]) => ({
        occ: o,
        name: cat.occupations[o].name,
        hours,
      })),
      know: p.know.map((k) => ({ id: k, name: cat.knowledge[k].name, year: cat.kyear[k] })),
      dep: p.dep,
      co2: p.co2,
      design_effort: p.design_effort,
    }
  })
  const usedIn = [...new Set(cat.usedAsInput[gid].map((x) => cat.procs[x].good))].toSorted()
  const usedEq = [...new Set(cat.usedAsEquip[gid].map((x) => cat.procs[x].good))].toSorted()
  return {
    good: goodBrief(g),
    processes,
    used_in: usedIn.map(ref),
    used_as_equipment_by: usedEq.map(ref),
  }
}
export type CatalogGoodResponse = ReturnType<typeof catalogGood>

// ---------------------------------------------------------------- timelines
export function timelines(e: Engine) {
  return {
    timelines: e.store
      .timelines()
      .map((t) => ({ ...t, policy_events: e.store.policyEvents(t.id, 0, 10 ** 9, true) })),
    status: e.status(),
  }
}
export type TimelinesResponse = ReturnType<typeof timelines>
export type TimelineInfo = TimelinesResponse["timelines"][number]

export function createTimeline(
  e: Engine,
  body: { scenario?: string; seed?: number; name?: string | null; burn_in?: number | null },
) {
  const scenario = body.scenario ?? "emerging_2025"
  if (!(scenario in SCENARIOS)) throw new ApiError(`unknown scenario ${scenario}`)
  e.create(scenario, Number(body.seed ?? 1), body.name ?? null, body.burn_in ?? null)
  return { status: e.status() }
}

export function runTimeline(e: Engine, tid: number, months: number) {
  timelineOr404(e, tid)
  e.run(tid, Math.max(1, Math.min(1200, Math.trunc(months || 12))))
  return { status: e.status() }
}

export function setPolicy(
  e: Engine,
  tid: number,
  body: { patch?: PolicyPatch; note?: string; tick?: number | null; branch_name?: string | null },
) {
  timelineOr404(e, tid)
  const tick = body.tick === undefined || body.tick === null ? null : Math.trunc(body.tick)
  return e.applyPolicy(tid, body.patch ?? {}, body.note ?? "", tick, body.branch_name ?? null)
}

export function fork(e: Engine, tid: number, tick: number, name?: string | null) {
  timelineOr404(e, tid)
  return { timeline: e.fork(tid, tick, name || "Branch") }
}

export function rename(e: Engine, tid: number, name: string) {
  timelineOr404(e, tid)
  e.store.rename(tid, name)
  return { ok: true }
}

export function remove(e: Engine, tid: number) {
  timelineOr404(e, tid)
  e.delete(tid)
  return { ok: true }
}

export function status(e: Engine): Job | { state: "idle" } {
  return e.status()
}

export function series(e: Engine, tid: number, keys: string[] | null) {
  timelineOr404(e, tid)
  return { series: e.store.series(tid, keys) }
}

export function metricsAt(e: Engine, tid: number, tick: number | null) {
  const tl = timelineOr404(e, tid)
  const t = tick ?? tl.head_tick - 1
  return { tick: t, metrics: e.store.metricsAt(tid, t) }
}

const runningOn = (e: Engine, tid: number) => {
  const s = e.status()
  return e.busy() && "timeline" in s && s.timeline === tid
}

export function getPolicy(e: Engine, tid: number) {
  const tl = timelineOr404(e, tid)
  const pol = runningOn(e, tid) ? e.headWorld(tid).policy : e.effectivePolicy(tid)
  return {
    policy: pol,
    head: tl.head_tick,
    events: e.store.policyEvents(tid),
    regions: e.headWorld(tid).regions.map((r) => ({ id: r.id, name: r.name })),
  }
}
export type PolicyResponse = ReturnType<typeof getPolicy>

export function goods(e: Engine, tid: number, tick: number | null) {
  const tl = timelineOr404(e, tid)
  const cat = CAT()
  const t = tick ?? tl.head_tick - 1
  const rows = e.store.goodsAt(tid, t).map((r: GoodsRow) => {
    const g = cat.goods[r.good] as Good | undefined
    return {
      ...r,
      name: g?.name ?? r.good,
      cat: g?.cat ?? "",
      sector: g ? (SECTOR_OF_CAT[g.cat] ?? "Other") : "Other",
      unit: g?.unit ?? "",
      need: g?.need ? g.need[0] : null,
    }
  })
  return { tick: t, goods: rows }
}
export type GoodsResponse = ReturnType<typeof goods>

function worldFor(e: Engine, tid: number, tick: number | null): World {
  const tl = timelineOr404(e, tid)
  if (tick === null || tick >= tl.head_tick || runningOn(e, tid)) return e.headWorld(tid)
  return e.worldAt(tid, tick)
}

export function good(e: Engine, tid: number, gid: string, tick: number | null) {
  goodOr404(gid)
  const w = worldFor(e, tid, tick)
  return {
    series: e.store.goodSeries(tid, gid),
    explain: physical.explain(w, CAT(), gid),
    tick: w.tick,
  }
}
export type GoodResponse = ReturnType<typeof good>

function flowNode(a: string, accts: Record<string, { label: string; sector: string }>): string {
  if (a.startsWith("hh")) return "Households"
  if (a === "gov") return "Government"
  if (a === "bank") return "Banks"
  if (a === "row") return "Rest of world"
  if (a.startsWith("market:freight")) return "Transport & logistics"
  if (a.startsWith("market:") || a.startsWith("sector:")) return a.slice(a.indexOf(":") + 1)
  if (a.startsWith("firm:")) return accts[a]?.sector ?? "Other"
  return a
}

export function flows(e: Engine, tid: number, from: number | null, to: number | null) {
  const tl = timelineOr404(e, tid)
  const hi = to ?? tl.head_tick - 1
  const lo = from ?? Math.max(0, hi - 11)
  const agg = e.store.ledgerFlows(tid, lo, hi)
  const accts = e.store.accounts(tid)
  const links = new Map<
    string,
    { source: string; target: string; value: number; kinds: Record<string, number> }
  >()
  for (const [s, d, k, v] of agg.values()) {
    const a = flowNode(s, accts)
    const b = flowNode(d, accts)
    if (a === b || v <= 0) continue
    const key = `${a}\u0001${b}`
    let l = links.get(key)
    if (!l) {
      l = { source: a, target: b, value: 0, kinds: {} }
      links.set(key, l)
    }
    l.value += v
    l.kinds[k] = (l.kinds[k] ?? 0) + v
  }
  return { from: lo, to: hi, links: [...links.values()].toSorted((x, y) => y.value - x.value) }
}
export type FlowsResponse = ReturnType<typeof flows>

export function ledger(
  e: Engine,
  tid: number,
  q: {
    from: number | null
    to: number | null
    account: string | null
    kind: string | null
    limit: number | null
    offset: number | null
  },
) {
  const tl = timelineOr404(e, tid)
  const hi = q.to ?? tl.head_tick - 1
  const lo = q.from ?? hi
  const [rows, total] = e.store.ledgerRows(
    tid,
    lo,
    hi,
    q.account,
    q.kind,
    q.limit ?? 300,
    q.offset ?? 0,
  )
  const accts = e.store.accounts(tid)
  const labels: Record<string, string> = {}
  for (const r of rows) for (const a of [r.src, r.dst]) if (a in accts) labels[a] = accts[a].label
  return { rows, total, labels, kinds: e.store.ledgerKinds(tid) }
}
export type LedgerResponse = ReturnType<typeof ledger>

export function events(
  e: Engine,
  tid: number,
  q: {
    from: number | null
    to: number | null
    kinds: string[] | null
    limit: number | null
    search: string | null
  },
) {
  timelineOr404(e, tid)
  return {
    events: e.store.events(tid, q.from ?? 0, q.to ?? 10 ** 9, q.kinds, q.limit ?? 400, q.search),
  }
}
export type EventsResponse = ReturnType<typeof events>

export function detail(e: Engine, tid: number, kind: string, tick: number | null) {
  const tl = timelineOr404(e, tid)
  return e.store.detail(tid, tick ?? tl.head_tick, kind) ?? { tick: null, data: null }
}
