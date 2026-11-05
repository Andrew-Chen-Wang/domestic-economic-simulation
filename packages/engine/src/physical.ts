/**
 * Physical engine: what can physically be produced, where, how much, and how well.
 *
 * - Capacity comes from equipment x throughput, modified by geology (deposit grade and
 *   depletion), climate (crop suitability), and site potential (solar, wind, hydro).
 * - Yield and quality come from the precision gap between the maker's equipment and the
 *   product's tolerance, cleanroom availability, worker craft skill and the learning curve.
 * - Transport cost comes from mass x distance x infrastructure quality.
 */
import { corporateMaturity, processTechnology } from "./technology"
import type { Catalog, Input, Process } from "./catalog"
import { HOURS, type Firm, type Region, type World, yearOf } from "./world"

export const CLEAN_ORDER: Record<string, number> = {
  cleanroom_iso3: 3,
  cleanroom_iso5: 5,
  cleanroom_iso7: 7,
}
export const FREIGHT_PER_TKM_ROAD = 0.11
export const FREIGHT_PER_TKM_RAIL = 0.045
export const SEA_FREIGHT_PER_T = 60

const primaryEquip = (p: Process) => (p.equip ? p.equip[0] : null)

// ------------------------------------------------------------------ geography
export function regionsForProcess(w: World, cat: Catalog, p: Process): number[] {
  const out: number[] = []
  const eq = primaryEquip(p)
  for (const r of w.regions) {
    if (p.dep) {
      const d = r.deposits[p.dep]
      if (!d || d.qty <= 0) continue
    }
    if (eq !== null && eq in cat.endowments) {
      if ((r.land[eq] ?? 0) <= 0) continue
      if (p.good in cat.crops && (r.suit[p.good] ?? 0) < 0.25) continue
    }
    out.push(r.id)
  }
  return out
}

export function regionWeights(
  w: World,
  cat: Catalog,
  p: Process,
  regs: number[],
): Map<number, number> {
  const eq = primaryEquip(p)
  const out = new Map<number, number>()
  for (const rid of regs) {
    const r = w.regions[rid]
    if (p.dep) {
      const d = r.deposits[p.dep]
      out.set(rid, Math.max(1e-6, d.grade ** 2 * Math.sqrt(Math.max(d.qty, 0))))
    } else if (eq !== null && eq in cat.endowments) {
      out.set(rid, (r.land[eq] ?? 0) * (r.suit[p.good] ?? 0.6) ** 2)
    } else {
      out.set(rid, (r.pop + 50) * (r.port ? 1.5 : 1) * (0.5 + (r.infra.road ?? 0.5)))
    }
  }
  return out
}

/** Multiplier on equipment throughput from the physical site. */
export function siteFactor(_w: World, cat: Catalog, p: Process, r: Region): number {
  let f = 1
  const eq = primaryEquip(p)
  if (p.dep) {
    const d = r.deposits[p.dep]
    if (!d || d.qty <= 0) return 0
    if (d.kind === "stock") f *= d.grade * (0.45 + 0.55 * Math.min(1, d.qty / Math.max(d.qty0, 1)))
    else if (d.kind === "renew") f *= Math.min(1, 0.3 + d.qty / Math.max(d.qty0, 1))
    else f *= d.grade
  }
  if (eq !== null && eq in cat.endowments && p.good in cat.crops) {
    let suit = r.suit[p.good] ?? 0.5
    // irrigation tops up dry regions
    if (r.rain < 900) suit = suit + (1 - suit) * 0.5 * (r.infra.irrigation ?? 0)
    f *= suit
  }
  return f
}

export function capacityPerPrimary(w: World, cat: Catalog, p: Process, r: Region): number {
  return (p.rate ?? 0) * siteFactor(w, cat, p, r)
}

/** Cost to move one unit of `gid` between regions (domestic currency). */
export function transportCost(
  w: World,
  cat: Catalog,
  gid: string,
  rFrom: number,
  rTo: number,
): number {
  const kg = cat.goods[gid].kg
  if (kg <= 0) return 0
  const a = w.regions[rFrom]
  const b = w.regions[rTo]
  const d = w.dist[rFrom][rTo]
  const roadQ = 0.5 * (a.infra.road + b.infra.road)
  const railQ = Math.min(a.infra.rail, b.infra.rail)
  const road = FREIGHT_PER_TKM_ROAD / (0.35 + 0.65 * roadQ)
  const rail = railQ > 0.1 && d > 120 ? FREIGHT_PER_TKM_RAIL / (0.35 + 0.65 * railQ) : road
  const perTkm = Math.min(road, rail * (1.3 - 0.3 * railQ))
  return (kg / 1000) * d * perTkm * (w.stats.freight_mult ?? 1)
}

export function nearestPort(w: World, rTo: number): number {
  let best: [number, number] | null = null
  for (const r of w.regions) {
    if (r.port && (r.infra.port ?? 0) > 0.02) {
      const d = w.dist[r.id][rTo]
      if (best === null || d < best[1]) best = [r.id, d]
    }
  }
  return best ? best[0] : 0
}

/** Landed price of an import in region rTo (before tariff), or null. */
export function importPrice(w: World, cat: Catalog, gid: string, rTo: number): number | null {
  const wp = cat.worldPrice(gid, yearOf(w))
  if (wp === null) return null
  const g = cat.goods[gid]
  if (g.svc && (g.local || g.nt)) return null
  if (g.nt) return null
  const port = nearestPort(w, rTo)
  const pq = w.regions[port].infra.port ?? 0.3
  const sea = (g.kg / 1000) * SEA_FREIGHT_PER_T * (1.6 - 0.6 * pq)
  return wp * w.fx + sea * w.fx + transportCost(w, cat, gid, port, rTo)
}

// ---------------------------------------------------------------- production
/**
 * Share of good output given equipment precision vs required tolerance. Skilled craftsmen can do
 * better than their machines (scraping, lapping, selective fitting) - up to ~35%.
 */
export function precisionYield(tol: number | null, eqPrec: number, craft: number): number {
  if (!tol) return 1
  const eff = eqPrec * (1 - 0.35 * craft)
  const ratio = eff / tol
  if (ratio <= 1) return 1
  if (ratio >= 4) return 0
  return Math.max(0, 1 - 0.95 * ((ratio - 1) / 3) ** 0.7)
}

export function learningYield(f: Firm, complex: boolean): number {
  const ref = Math.max(f.plan, 1e-6) * 6
  const m = f.cum_output / (f.cum_output + ref)
  return complex ? 0.3 + 0.7 * m : 0.75 + 0.25 * m
}

/**
 * Wright's law: ~15% fewer hours per doubling of cumulative output. A brand-new line needs twice
 * the mature hours; a mature line is at the calibrated frontier level (1.0).
 */
export function learningLabor(f: Firm): number {
  const ref = Math.max(f.plan, 1e-6) * 3
  const doublings = Math.log2(1 + f.cum_output / ref)
  return Math.max(1, 2 * 0.85 ** doublings)
}

export function hasCleanroom(f: Firm, need: string | null): boolean {
  if (!need) return true
  const lvl = CLEAN_ORDER[need]
  for (const [k, v] of Object.entries(f.equip)) {
    if (k in CLEAN_ORDER && CLEAN_ORDER[k] <= lvl && v > 1e-6) return true
  }
  return false
}

/** Input & labor requirement relative to the world-frontier design; ~4% per generation. */
export function genFactor(w: World, cat: Catalog, f: Firm): number {
  return 0.96 ** (f.gen - worldGeneration(w, cat, f.good))
}

/**
 * Hours per unit at this firm, before worker skill. Includes the learning curve, design
 * generation, missing optional upgrades and the firm's total factor productivity.
 */
export function laborHoursPerUnit(
  w: World,
  cat: Catalog,
  f: Firm,
  p: Process,
): Record<string, number> {
  const mult = learningLabor(f) * genFactor(w, cat, f)
  const pen = 1 + 0.12 * missingOptional(f, p)
  const tfp = firmTfp(w, cat, f, p)
  const out: Record<string, number> = {}
  for (const [o, h] of Object.entries(p.labor)) out[o] = (h * mult * pen) / tfp
  return out
}

/** Tacit process know-how: weakest relevant process/engineering node. */
export function knowHow(w: World, cat: Catalog, p: Process): number {
  let m = Infinity
  for (const k of p.know) {
    if (cat.knowledge[k].kind === "sci") continue
    m = Math.min(m, w.knowledge[k] ?? 0)
  }
  return m === Infinity ? 1 : m
}

export function firmTfp(w: World, cat: Catalog, f: Firm, p: Process): number {
  const r = w.regions[f.region]
  const kh = 0.35 + 0.65 * knowHow(w, cat, p)
  const organization =
    w.mechanism_version === 2
      ? 1 - 0.65 * processTechnology(cat, p).tacit_share * (1 - corporateMaturity(f, cat, p))
      : 1
  let infra = 0.55 + 0.25 * (r.infra.road ?? 0.5) + 0.2 * (r.infra.grid ?? 0.5)
  const g = cat.goods[f.good]
  if (g.svc && (g.cat === "service" || g.cat === "software"))
    infra *= 0.85 + 0.15 * (r.infra.broadband ?? 0.5)
  return organization * kh * infra * r.productivity * (w.stats.tfp_mult ?? 1)
}

export function workerProductivity(skill: number): number {
  return 0.4 + 0.8 * skill
}

export function missingOptional(f: Firm, p: Process): number {
  let n = 0
  for (const name of p.optional) {
    const aux = p.aux[name]
    if (aux && !aux[0].some((a) => (f.equip[a] ?? 0) > 1e-9)) n += 1
  }
  return Math.min(n, 4)
}

export function craftSkill(w: World, f: Firm): number {
  let tot = 0
  let s = 0
  for (const [pid, fte] of f.staff) {
    const per = w.persons.get(pid)
    if (!per) continue
    const sk = per.occ !== null ? (per.skill[per.occ] ?? 0.2) : 0.2
    tot += fte
    s += fte * sk
  }
  return tot > 0 ? s / tot : 0.2
}

/** Monthly output units the firm's equipment can produce, and the binding reason if zero. */
export function equipmentCapacity(
  w: World,
  cat: Catalog,
  f: Firm,
  p: Process,
): [number, string | null] {
  if (!p.equip) return [1e18, null]
  let n = 0
  for (const a of p.equip) if ((f.equip[a] ?? 0) > n) n = f.equip[a]
  if (n <= 1e-9) return [0, `no ${cat.goods[p.equip[0]].name}`]
  const r = w.regions[f.region]
  let cap = n * capacityPerPrimary(w, cat, p, r)
  if (p.dep) {
    const d = r.deposits[p.dep]
    if (!d || d.qty <= 0) return [0, `deposit of ${p.dep} exhausted`]
    if (d.kind === "flow" && p.dep === "hydro") cap = Math.min(cap, d.qty * (p.rate ?? 0) * d.grade)
    if (d.kind === "stock" || d.kind === "renew") cap = Math.min(cap, d.qty * 0.02)
  }
  for (const [name, [alts, ratio]] of Object.entries(p.aux)) {
    let have = 0
    for (const a of alts) have += f.equip[a] ?? 0
    if (p.optional.has(name) && have <= 1e-9) continue
    if (alts[0] in CLEAN_ORDER) continue // handled as a yield gate
    const need = ratio * n
    if (need > 0 && have < need) {
      if (have <= 1e-9) return [0, `missing ${cat.goods[alts[0]].name}`]
      cap = Math.min(cap, (cap * have) / need)
    }
  }
  return [cap, null]
}

/** Returns [yield, quality, reason]. */
export function yieldQuality(
  w: World,
  cat: Catalog,
  f: Firm,
  p: Process,
): [number, number, string | null] {
  const g = cat.goods[f.good]
  if (g.clean && !hasCleanroom(f, g.clean)) return [0, 0, `requires ${cat.goods[g.clean].name}`]
  for (const [name, [alts]] of Object.entries(p.aux)) {
    if (alts[0] in CLEAN_ORDER && !hasCleanroom(f, alts[0])) {
      if (p.optional.has(name)) continue
      return [0, 0, `requires ${cat.goods[alts[0]].name}`]
    }
  }
  let eq: string | null = null
  if (p.equip) {
    let best = -Infinity
    for (const a of p.equip) {
      const v = f.equip[a] ?? 0
      if (v > best) {
        best = v
        eq = a
      }
    }
  }
  const craft = craftSkill(w, f)
  const prec = precisionOf(cat, f, eq)
  const yp = prec ? precisionYield(g.tol, prec, craft) : 1
  if (yp <= 0)
    return [
      0,
      0,
      `equipment precision ${fmtG(prec ?? 0)}um too coarse for ${fmtG(g.tol ?? 0)}um tolerance`,
    ]
  const complex = Boolean(g.clean) || (g.tol !== null && g.tol < 5)
  const yl = learningYield(f, complex)
  const y = yp * yl * Math.min(1, 0.25 + f.design * 0.75)
  const wg = worldGeneration(w, cat, f.good)
  const q = (0.8 + 0.2 * yp) * qualityFactor(f.gen, wg) * (0.94 + 0.12 * craft)
  return [y, q, null]
}

const fmtG = (x: number) => String(Number(x.toPrecision(6)))

export const ASSEMBLY = new Set([
  "assembly_line",
  "welding_robot",
  "construction_equipment",
  "aircraft_assembly_hall",
  "shipyard",
  "industrial_robot",
])

/**
 * Precision (um) that limits this firm's output. Assembly equipment does not set tolerances -
 * those are embodied in the components - so the finest machine tool the firm owns governs.
 */
export function precisionOf(cat: Catalog, f: Firm, eq: string | null): number | null {
  let best: number | null = null
  for (const [a, n] of Object.entries(f.equip)) {
    if (n <= 1e-9 || ASSEMBLY.has(a) || a in CLEAN_ORDER) continue
    const pr = f.eq_prec[a] || cat.goods[a].prec
    if (!pr || cat.goods[a].cat === "building") continue
    if (best === null || pr < best) best = pr
  }
  if (best === null && eq !== null && !ASSEMBLY.has(eq)) best = f.eq_prec[eq] || cat.goods[eq].prec
  return best
}

/** Design improvements the world frontier has made since the good was introduced (~1 / 6 yrs). */
export function worldGeneration(w: World, cat: Catalog, gid: string): number {
  const age = yearOf(w) - cat.goods[gid].year
  if (w.mechanism_version === 2) {
    const pid = cat.goods[gid].processes[0]
    const pace = pid ? processTechnology(cat, cat.procs[pid]).frontier_years : null
    if (pace) return Math.max(0, Math.trunc(age / pace))
  }
  return Math.max(0, Math.min(8, Math.trunc(age / 6)))
}

export function qualityFactor(gen: number, worldGen: number): number {
  return 1.03 ** (gen - worldGen)
}

const minPrice = (alts: string[], f: (a: string) => number) => {
  let m = Infinity
  for (const a of alts) m = Math.min(m, f(a))
  return m
}

/** Rough unit cost of running process p in a region at current prices and wages. */
export function estUnitCost(w: World, cat: Catalog, p: Process, region: number): number | null {
  let inp = 0
  for (const [alts, q] of p.inputs)
    inp += minPrice(alts, (a) => w.prices[a] ?? cat.goods[a].price * 3) * q
  const r = w.regions[region]
  const tfp =
    (0.35 + 0.65 * knowHow(w, cat, p)) *
    (0.55 + 0.25 * r.infra.road + 0.2 * r.infra.grid) *
    r.productivity *
    (w.stats.tfp_mult ?? 1)
  let lab = 0
  for (const [o, h] of Object.entries(p.labor))
    lab += (h * (w.wage_index[o] ?? 3000)) / HOURS / (0.8 * Math.max(tfp, 0.05))
  let k = 0
  const eq = primaryEquip(p)
  if (eq !== null) {
    const cpp = capacityPerPrimary(w, cat, p, r)
    if (cpp <= 0) return null
    const g = cat.goods[eq]
    if (eq in cat.endowments) {
      k = ((g.rent ?? 0) * w.price_index * (w.stats.wage_level ?? 1) ** 0.5) / cpp
    } else {
      const pe = w.prices[eq] ?? g.price
      let per = pe * (1 / (g.life || 120) + (w.stats.lend_rate ?? 0.06) / 12)
      for (const [alts, ratio] of Object.values(p.aux)) {
        const last = alts[alts.length - 1]
        const ga = cat.goods[last]
        per += ratio * (w.prices[last] ?? ga.price) * (1 / (ga.life || 120) + 0.005)
      }
      k = per / cpp
    }
  }
  return inp + lab + k
}

/**
 * Share of the world market a domestic supplier wins at a given quality-adjusted price
 * competitiveness (world price / our landed price).
 */
export function exportShare(comp: number): number {
  if (comp < 0.75) return 0
  return Math.min(0.06, 0.012 * comp ** 5)
}

export function refUnitCost(w: World, cat: Catalog, p: Process, wageMult: number, tfp = 1): number {
  let inp = 0
  for (const [alts, q] of p.inputs)
    inp += minPrice(alts, (a) => w.prices[a] ?? cat.goods[a].price) * q
  let lab = 0
  for (const [o, h] of Object.entries(p.labor))
    lab += (cat.occupations[o].ref_wage * wageMult * h) / (0.8 * tfp)
  const eq = primaryEquip(p)
  let k = 0
  if (eq !== null && p.rate) {
    const g = cat.goods[eq]
    k = g.endowment ? (g.rent ?? 0) / p.rate : (g.price * (1 / (g.life || 120) + 0.006)) / p.rate
  }
  return inp + lab + k
}

// ---------------------------------------------------------------- explainer
const r3 = (x: number) => Math.round(x * 1000) / 1000
const r2 = (x: number) => Math.round(x * 100) / 100
const r4 = (x: number) => Math.round(x * 10000) / 10000

export interface SupplyItem {
  id: string
  name: string
  role: string
  domestic: number
  importable: boolean
  endowment: boolean
  precision_um: number | null
  precision_ok: boolean
  ok: boolean
  world_year: number
  restricted: boolean
  alternatives?: string[]
  optional?: boolean
  qty?: number
}

/** Why can (or can't) this country make this good? Scientific, engineering, manufacturing, economic. */
export function explain(w: World, cat: Catalog, gid: string) {
  const g = cat.goods[gid]
  const year = yearOf(w)
  const producers = [...w.firms.values()].filter((f) => f.good === gid && f.alive)
  const processes = g.processes.map((pid) => {
    const p = cat.procs[pid]
    const sci = p.know.map((k) => {
      const node = cat.knowledge[k]
      const lvl = w.knowledge[k] ?? 0
      return {
        id: k,
        name: node.name,
        level: r3(lvl),
        world_knows: cat.kyear[k] <= year,
        kind: node.kind,
        ok: lvl >= 0.5,
      }
    })
    const sciOk = sci.every((x) => x.ok)
    let best: Firm | null = null
    for (const f of producers) if (best === null || f.design > best.design) best = f
    const rd = [...w.firms.values()].filter((f) => f.good === gid && f.design < 1)
    const engOk = producers.some((f) => f.design >= 1)
    const items: SupplyItem[] = []
    for (const a of p.equip ?? []) items.push(supplyItem(w, cat, [a], "equipment", g.tol))
    for (const [name, [alts]] of Object.entries(p.aux)) {
      const it = supplyItem(w, cat, alts, "aux equipment", null)
      it.optional = p.optional.has(name)
      items.push(it)
    }
    for (const [alts, q] of p.inputs) {
      const it = supplyItem(w, cat, alts, "input", null)
      it.qty = q
      it.optional = p.optional.has(alts[0])
      items.push(it)
    }
    const regs = regionsForProcess(w, cat, p)
    const site: { ok: boolean; regions: string[]; deposit?: string } = {
      ok: regs.length > 0,
      regions: regs.map((r) => w.regions[r].name),
    }
    if (p.dep) site.deposit = p.dep
    const labor = Object.entries(p.labor).map(([o, h]) => {
      const occ = cat.occupations[o]
      let n = 0
      let sk = 0
      let ns = 0
      for (const per of w.persons.values()) {
        if (per.occ !== o) continue
        if (per.age >= 216) n += w.scale
        sk += per.skill[o] ?? 0
        ns += 1
      }
      return {
        occ: o,
        name: occ.name,
        hours: r4(h),
        workers: n,
        avg_skill: ns ? r2(sk / ns) : 0,
        ok: n > 0,
      }
    })
    const manOk = items.every((i) => i.ok || i.optional) && site.ok && labor.every((l) => l.ok)
    const domCost = refUnitCost(w, cat, p, w.stats.wage_level ?? 1) * w.price_index
    const imp = g.year <= year && !g.restricted ? importPrice(w, cat, gid, 0) : null
    return {
      id: pid,
      trad: p.trad,
      year: p.year,
      layers: {
        scientific: { ok: sciOk, items: sci },
        engineering: {
          ok: engOk || (sciOk && w.produced_ever.has(gid)),
          best_design: best ? r3(best.design) : 0,
          in_rd: rd.map((f) => ({ firm: f.name, progress: r3(f.design), blocked: f.blocked })),
          design_effort_py: Math.round(p.design_effort),
          reverse_engineering: r2(1 - g.opq),
        },
        manufacturing: {
          ok: manOk,
          tolerance_um: g.tol,
          cleanroom: g.clean,
          site,
          supplies: items,
          labor,
        },
        economic: {
          ok: imp === null || domCost <= imp * 1.05,
          est_domestic_cost: r4(domCost),
          import_price: imp ? r4(imp) : null,
          domestic_price: r4(w.prices[gid] ?? 0),
        },
      },
    }
  })
  return {
    good: gid,
    name: g.name,
    world_year: g.year,
    world_available: g.year <= year && !g.restricted,
    restricted: g.restricted,
    producers: producers.map((f) => ({
      id: f.id,
      name: f.name,
      region: w.regions[f.region].name,
      design: r3(f.design),
      corporate_maturity:
        w.mechanism_version === 2 ? r3(corporateMaturity(f, cat, cat.procs[f.proc])) : null,
      gen: f.gen,
      quality: r3(f.quality),
      output: f.last.output ?? 0,
      blocked: f.blocked,
    })),
    processes,
  }
}

function supplyItem(
  w: World,
  cat: Catalog,
  alts: string[],
  role: string,
  tol: number | null,
): SupplyItem {
  const year = yearOf(w)
  let best: SupplyItem | null = null
  for (const a of alts) {
    const g = cat.goods[a]
    let dom = 0
    for (const f of w.firms.values()) if (f.good === a && f.alive && (f.last.output ?? 0) > 0) dom++
    const world = g.year <= year && !g.restricted && !g.nt
    const endow = a in cat.endowments
    const prec = g.prec
    const precOk = tol && prec ? prec <= tol * 4 : true
    const ok = (dom > 0 || world || endow) && precOk
    const it: SupplyItem = {
      id: a,
      name: g.name,
      role,
      domestic: dom,
      importable: world,
      endowment: endow,
      precision_um: prec,
      precision_ok: precOk,
      ok,
      world_year: g.year,
      restricted: g.restricted,
    }
    if (best === null || (ok && !best.ok)) best = it
  }
  const out = best as SupplyItem
  out.alternatives = alts.map((a) => cat.goods[a].name)
  return out
}

export type { Input }
