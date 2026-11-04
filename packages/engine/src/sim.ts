/**
 * Monthly simulation step: the economic and social engine, wired to the physical and knowledge
 * engines.
 *
 * Order of a month:
 *   macro & policy -> demography & schooling -> regions -> firm plans -> labor market ->
 *   productive potential -> demand -> market clearing -> production -> incomes, taxes &
 *   transfers -> firm finance, entry & exit -> R&D & knowledge -> infrastructure & housing ->
 *   exchange rate -> metrics
 */
import { type Catalog, engelShares, eligible, getCatalog, type Good, type Process } from "./catalog"
import * as demography from "./demography"
import * as knowledgeEngine from "./knowledge-engine"
import * as physical from "./physical"
import { inList, lookupRate } from "./policy"
import { permutation, random, shuffle, uniform } from "./rng"
import {
  addEvent,
  firmName,
  HOURS,
  newFirm,
  type Firm,
  type Person,
  personFte,
  type Region,
  type RegionStat,
  WORLD_SCALE,
  type World,
  yearOf,
} from "./world"

export { WORLD_SCALE }

/** substitution elasticity between suppliers of the same good */
export const SIGMA = 5
/** import presence relative to domestic suppliers */
export const HOME_BIAS = 0.5
export const RD_INTENSITY: Record<string, number> = {
  semis: 0.15,
  pharma: 0.14,
  electronics: 0.08,
  software: 0.15,
  electrical: 0.05,
  capital: 0.04,
  component: 0.03,
  chem: 0.03,
  health: 0.06,
  personal: 0.02,
  toys: 0.02,
  consumer: 0.02,
}
export const RD_OCC: Record<string, string> = {
  semis: "process_engineer",
  electronics: "elec_engineer",
  electrical: "elec_engineer",
  pharma: "pharmacist",
  chem: "chem_engineer",
  personal: "chem_engineer",
  metal: "materials_engineer",
  software: "software_dev",
  capital: "mech_engineer",
  component: "mech_engineer",
  consumer: "mech_engineer",
  toys: "designer",
  health: "elec_engineer",
  mineral: "materials_engineer",
  energy: "elec_engineer",
  food: "chem_engineer",
  apparel: "designer",
  textile: "chem_engineer",
  agri: "agronomist",
  service: "software_dev",
  media: "designer",
  paper: "chem_engineer",
  wood: "mech_engineer",
  building: "civil_engineer",
  resource: "mech_engineer",
  public: "scientist",
}
export const SECTOR_OF_CAT: Record<string, string> = {
  resource: "Mining & extraction",
  agri: "Agriculture",
  food: "Food & beverages",
  textile: "Textiles & apparel",
  apparel: "Textiles & apparel",
  wood: "Wood & paper",
  paper: "Wood & paper",
  media: "Media & publishing",
  energy: "Energy & utilities",
  chem: "Chemicals & plastics",
  mineral: "Building materials",
  metal: "Metals",
  semis: "Semiconductors & electronics",
  electronics: "Semiconductors & electronics",
  component: "Machinery & components",
  electrical: "Electrical equipment",
  capital: "Machinery & components",
  building: "Construction",
  consumer: "Consumer goods",
  personal: "Consumer goods",
  toys: "Consumer goods",
  pharma: "Health & pharma",
  health: "Health & pharma",
  service: "Services",
  software: "Software & IT",
  public: "Public services",
}
const FREIGHT_GOODS = ["freight_trucking", "freight_rail"]
const INFRA_K: Record<string, number> = {
  road: 40000,
  rail: 25000,
  port: 4.0e8,
  grid: 350,
  broadband: 160,
  transit: 450,
  irrigation: 600,
}
const RURAL_OCCS = new Set(["farmer", "forester", "fisher", "miner"])

/** Per-firm scratch state for one month. */
export interface FirmState {
  sold: number
  wanted: number
  revenue: number
  export_rev: number
  inputs_bought: number
  subsidy: number
  exported: number
  freight_rev: number
  capex: number
  hours: Record<string, number>
  rd_occ: string
  rd_fte: number
  cap: number
  y: number
  plan: number
  gross: number
  labor_gross: number
  have_hours: Record<string, number>
  want_hours: Record<string, number>
  labor_cap: number
  offer: number
  prod_gross: number
  pot_gross: number
  net: number
  gross_done: number
  used_val: number
  land_rent: number
  dep_val: number
  dep_units: Record<string, number>
  wages: number
  interest: number
  profit: number
  tax: number
}

function newFirmState(): FirmState {
  return {
    sold: 0,
    wanted: 0,
    revenue: 0,
    export_rev: 0,
    inputs_bought: 0,
    subsidy: 0,
    exported: 0,
    freight_rev: 0,
    capex: 0,
    hours: {},
    rd_occ: "",
    rd_fte: 0,
    cap: 0,
    y: 0,
    plan: 0,
    gross: 0,
    labor_gross: 0,
    have_hours: {},
    want_hours: {},
    labor_cap: 0,
    offer: 0,
    prod_gross: 0,
    pot_gross: 0,
    net: 0,
    gross_done: 0,
    used_val: 0,
    land_rent: 0,
    dep_val: 0,
    dep_units: {},
    wages: 0,
    interest: 0,
    profit: 0,
    tax: 0,
  }
}

export type Flow = Record<string, number>

export const add = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v)
export const addR = (o: Record<string, number>, k: string, v: number) => {
  o[k] = (o[k] ?? 0) + v
}
const sum = (xs: Iterable<number>) => {
  let s = 0
  for (const x of xs) s += x
  return s
}

export const LEDGER_SEP = "\u0001"

/** Everything accumulated during one month (ledger, flows, government accounts...). */
export class Ctx {
  /** `${src}\u0001${dst}\u0001${kind}` -> amount */
  ledger = new Map<string, number>()
  stats: Record<string, number> = {}
  hhNeed: Record<string, number> = {}
  fs = new Map<number, FirmState>()
  flows = new Map<string, Flow>()
  rd_spill = new Map<number, [number, string[]]>()
  practiced = new Map<string, number>()
  freight_fee = new Map<number, number>()
  sea_fee = 0
  gov_spend: Record<string, number> = {}
  gov_rev: Record<string, number> = {}
  hh_spent = new Map<string, number>()
  region_va = new Map<number, number>()
  sector_va: Record<string, number> = {}
  gov_bought = new Map<string, Map<number, number>>()
  emissions = 0
  elec_mix: Record<string, number> = {}
  informal = new Map<number, number>()

  flow(gid: string): Flow {
    let f = this.flows.get(gid)
    if (!f) {
      f = {}
      this.flows.set(gid, f)
    }
    return f
  }

  firm(id: number): FirmState {
    let f = this.fs.get(id)
    if (!f) {
      f = newFirmState()
      this.fs.set(id, f)
    }
    return f
  }

  stat(k: string): number {
    return this.stats[k] ?? 0
  }

  addStat(k: string, v: number) {
    this.stats[k] = (this.stats[k] ?? 0) + v
  }

  *ledgerEntries(): Generator<[src: string, dst: string, kind: string, amount: number]> {
    for (const [k, v] of this.ledger) {
      const [a, b, c] = k.split(LEDGER_SEP)
      yield [a, b, c, v]
    }
  }
}

type Seller = [Firm, number]
type DemandKind = "firm" | "inv" | "hh" | "gov"
type Demand = [kind: DemandKind, key: number | string, region: number, qty: number]
interface HhGroup {
  region: number
  budget: number
  members: number
  adults: [Person, number][]
}

export const fmtG4 = (x: number): string => {
  if (!Number.isFinite(x)) return String(x)
  const a = Math.abs(x)
  if (a !== 0 && (a >= 1e4 || a < 1e-4)) {
    const [m, e] = x.toExponential(3).split("e")
    const exp = Number(e)
    return `${String(Number(m))}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`
  }
  return Number(x.toPrecision(4)).toLocaleString("en-US", { maximumFractionDigits: 10 })
}
export const pct0 = (x: number) => `${Math.round(x * 100)}%`

export class Sim {
  w: World
  cat: Catalog
  private elig = new Map<string, string[]>()
  ctx: Ctx | null = null
  private supplyRegions = new Map<string, Set<number>>()
  private hhGroups = new Map<string, HhGroup>()

  constructor(world: World) {
    this.w = world
    this.cat = getCatalog()
  }

  // ------------------------------------------------------------ helpers
  ledger(src: string, dst: string, kind: string, amount: number) {
    if (amount && this.ctx) add(this.ctx.ledger, src + LEDGER_SEP + dst + LEDGER_SEP + kind, amount)
  }

  eligibleOccs(edu: number, field: string): string[] {
    const key = `${edu}|${field}`
    let v = this.elig.get(key)
    if (!v) {
      v = Object.entries(this.cat.occupations)
        .filter(([, oc]) => eligible(oc, edu, field))
        .map(([o]) => o)
      this.elig.set(key, v)
    }
    return v
  }

  quitAllJobs(p: Person) {
    const w = this.w
    if (p.jobs.size) {
      let m = -Infinity
      for (const j of p.jobs.values()) m = Math.max(m, j[1])
      p.prev_wage = m
    }
    for (const fid of p.jobs.keys()) w.firms.get(fid)?.staff.delete(p.id)
    p.jobs = new Map()
  }

  faccount(f: Firm): string {
    return `firm:${f.id}`
  }

  tariff(gid: string): number {
    const g = this.cat.goods[gid]
    const pol = this.w.policy
    return (
      pol.tariff_general +
      Number(pol.tariff_by_category[g.cat] ?? 0) +
      Number(pol.tariff_by_category[gid] ?? 0)
    )
  }

  importOk(gid: string): boolean {
    const g = this.cat.goods[gid]
    if (g.restricted || g.nt || (g.svc && g.local)) return false
    if (g.year > yearOf(this.w)) return false
    if (inList(this.w.policy.import_bans, gid, g.cat)) return false
    return true
  }

  get informal(): Map<number, number> {
    return (this.ctx as Ctx).informal
  }

  // ---------------------------------------------------------------- step
  step(): [Ctx, Metrics] {
    const w = this.w
    const ctx = new Ctx()
    this.ctx = ctx
    this.macro()
    demography.step(this, ctx)
    this.regions()
    this.firmPlan(ctx)
    this.laborMarket(ctx)
    this.potential(ctx)
    const demand = this.demand(ctx)
    this.markets(ctx, demand)
    this.production(ctx)
    this.incomes(ctx)
    this.firmFinance(ctx)
    knowledgeEngine.step(this, ctx)
    knowledgeEngine.updateSkills(this)
    this.infrastructure(ctx)
    this.external(ctx)
    const metrics = this.metrics(ctx)
    w.tick += 1
    this.ctx = null
    return [ctx, metrics]
  }

  // ---------------------------------------------------------------- macro
  private macro() {
    const w = this.w
    const pol = w.policy
    const st = w.stats
    const infl = st.inflation ?? 0.02
    const u = st.unemployment ?? 0.06
    if (pol.policy_rate_mode === "fixed") w.policy_rate = Number(pol.policy_rate)
    else {
      // Taylor rule (natural unemployment ~8%), with interest-rate smoothing
      let target = 0.02 + infl + 0.5 * (infl - pol.inflation_target) - 0.3 * (u - 0.08)
      target = Math.max(0, Math.min(0.25, target))
      w.policy_rate = 0.9 * w.policy_rate + 0.1 * target
    }
    st.lend_rate = w.policy_rate + 0.025
    st.dep_rate = Math.max(0, w.policy_rate - 0.01)
    // budgets follow trend (not current) GDP: spending is a stabilizer
    const gdp = st.gdp_trend ?? st.gdp_trailing ?? st.gdp_month ?? 1e8
    st.budget = {
      education: pol.spend_education * gdp,
      health: pol.spend_health * gdp,
      research: pol.spend_research * gdp,
      infrastructure: pol.spend_infrastructure * gdp,
      admin: pol.spend_admin * gdp,
    }
  }

  // ------------------------------------------------------------- regions
  private regions() {
    const w = this.w
    const pop = new Map<number, number>()
    const urban = new Map<number, number>()
    for (const p of w.persons.values()) {
      add(pop, p.region, 1)
      if (p.urban) add(urban, p.region, 1)
    }
    const pol = w.policy
    for (const r of w.regions) {
      r.pop = pop.get(r.id) ?? 0
      r.urban_pop = urban.get(r.id) ?? 0
      const up = r.urban_pop * w.scale
      const density = up / Math.max(r.urban_km2, 1)
      const agglo = (Math.max(up, 2e4) / 1e6) ** 0.04
      const congestion = 0.12 * (1 - r.infra.transit) * Math.min(1, density / 12000)
      r.productivity = agglo * (1 - congestion)
      // cities grow outward when crowded, faster with roads and land release
      if (density > 6000) r.urban_km2 *= 1 + 0.0006 * pol.urban_expansion * (0.3 + r.infra.road)
    }
  }

  maxDwellings(r: Region): number {
    const w = this.w
    const rural = ((r.pop - r.urban_pop) * w.scale) / 2.8
    return r.urban_km2 * 2200 * w.policy.zoning_density + rural * 1.05
  }

  // -------------------------------------------------------------- firms
  rdOccFor(p: Process, g: Good): string {
    for (const k of p.know) {
      const node = this.cat.knowledge[k]
      if (node.kind !== "sci") {
        const occs = this.cat.knowledgeFields[node.field]
        if (occs?.length) return occs[0]
      }
    }
    return RD_OCC[g.cat] ?? "mech_engineer"
  }

  private firmPlan(ctx: Ctx) {
    const w = this.w
    const cat = this.cat
    const pol = w.policy
    for (const f of [...w.firms.values()]) {
      const p = cat.procs[f.proc]
      const g = cat.goods[f.good]
      const fs = ctx.firm(f.id)
      fs.hours = physical.laborHoursPerUnit(w, cat, f, p)
      const rdOcc = this.rdOccFor(p, g)
      fs.rd_occ = rdOcc
      if (f.design < 1) {
        f.rd_share = 1
        const wage = w.wage_index[rdOcc] ?? 3000
        const budget = Math.max(0, f.cash) * 0.05
        fs.rd_fte = Math.max(0.05, Math.min(4, budget / (wage * w.scale)))
        f.blocked = f.blocked || "product design in progress"
        continue
      }
      const [cap, why] = physical.equipmentCapacity(w, cat, f, p)
      const [y, q, why2] = physical.yieldQuality(w, cat, f, p)
      f.blocked = why ?? why2
      if (y > 0) f.quality = q
      const dem = Math.max(f.demand_ema, 0)
      const netcap = cap * y
      let plan: number
      if (g.svc) plan = Math.min(netcap, dem * 1.1 + 1e-9)
      else plan = Math.max(0, Math.min(netcap, dem + 0.5 * (dem - f.inv)))
      const laborNet = Math.min(netcap, Math.max(plan, dem * 1.08))
      fs.cap = cap
      fs.y = y
      fs.plan = plan
      fs.gross = y > 0 ? plan / y : 0
      fs.labor_gross = y > 0 ? laborNet / y : 0
      f.plan = plan
      // R&D staff: by sector intensity, boosted by the R&D tax credit
      const inten = (RD_INTENSITY[g.cat] ?? 0.005) * (1 + pol.rd_tax_credit)
      const rev = f.last.revenue ?? 0
      const wage = w.wage_index[rdOcc] ?? 3000
      fs.rd_fte = f.profit_ema > 0 ? (inten * rev) / Math.max(wage * w.scale, 1) : 0
      f.rd_share = fs.rd_fte <= 0 ? 0 : 1
    }
  }

  // --------------------------------------------------------- labor market
  /** Effective hours by occupation (skill-adjusted). */
  staffHours(f: Firm): Record<string, number> {
    const w = this.w
    const out: Record<string, number> = {}
    for (const [pid, fte] of f.staff) {
      const p = w.persons.get(pid)
      if (!p || p.occ === null) continue
      addR(out, p.occ, fte * w.scale * HOURS * physical.workerProductivity(p.skill[p.occ] ?? 0.2))
    }
    return out
  }

  private laborMarket(ctx: Ctx) {
    const w = this.w
    const cat = this.cat
    const rng = w.rng
    const S = w.scale
    const pol = w.policy
    const med = w.stats.median_wage ?? 1000
    const minWage = pol.minimum_wage * med
    const vacancies: [number, Firm, string, number][] = []
    const fireCost = pol.firing_cost_months
    for (const f of w.firms.values()) {
      const fs = ctx.firm(f.id)
      const have = this.staffHours(f)
      fs.have_hours = have
      const want: Record<string, number> = {}
      for (const [o, h] of Object.entries(fs.hours)) want[o] = fs.labor_gross * h
      if (fs.rd_fte > 0) addR(want, fs.rd_occ, fs.rd_fte * S * HOURS * 0.8)
      fs.want_hours = want
      // firing when overstaffed (or the firm is broke)
      for (const [o, h] of Object.entries(have)) {
        const need = want[o] ?? 0
        let excess = h - need * 1.3 - 0.02 * S * HOURS
        if (f.distress >= 2) excess = Math.max(excess, h * 0.15)
        if (excess > 0 && (f.util_ema < 0.75 || f.distress >= 2 || need === 0)) {
          const staff = [...f.staff.keys()]
            .filter((pid) => w.persons.get(pid)?.occ === o)
            .sort((a, b) => (w.persons.get(a)?.skill[o] ?? 0) - (w.persons.get(b)?.skill[o] ?? 0))
          for (const pid of staff) {
            if (excess <= 0) break
            const p = w.persons.get(pid) as Person
            const perFte = S * HOURS * physical.workerProductivity(p.skill[o] ?? 0.2)
            const cut = Math.min(f.staff.get(pid) ?? 0, excess / perFte)
            if (cut <= 0.01) continue
            const job = p.jobs.get(f.id)
            if (!job) continue
            const wage = job[1]
            const sev = fireCost * wage * cut * S
            f.cash -= sev
            p.savings += sev / S
            this.ledger(this.faccount(f), `hh:${p.region}`, "severance", sev)
            p.prev_wage = Math.max(p.prev_wage, wage)
            const left = (f.staff.get(pid) ?? 0) - cut
            f.staff.set(pid, left)
            job[0] -= cut
            if (left <= 0.01) {
              f.staff.delete(pid)
              p.jobs.delete(f.id)
            }
            excess -= cut * perFte
          }
        }
      }
      // vacancies
      for (const [o, need] of Object.entries(want)) {
        const gap = need - (have[o] ?? 0)
        if (gap > 0.01 * S * HOURS) {
          const base = w.wage_index[o] ?? 2000
          const prev = f.wage_offer[o] ?? base
          let offer = f.wage_offer[`_unfilled_${o}`]
            ? Math.max(minWage, Math.min(base * 1.6, prev * 1.03))
            : Math.max(minWage, 0.5 * prev + 0.5 * base)
          if (f.distress) offer = Math.max(minWage, base * 0.95)
          f.wage_offer[o] = offer
          vacancies.push([offer, f, o, gap / (S * HOURS * 0.8)])
        }
      }
    }
    // candidate pools
    const pool = new Map<string, Person[]>() // `${region}|${occ}` -> persons
    const anyp = new Map<number, Person[]>() // region -> fully unemployed persons
    const poolOf = (r: number, o: string) => pool.get(`${r}|${o}`) ?? []
    const ret = pol.retirement_age * 12
    for (const p of w.persons.values()) {
      if (p.school || p.occ === null || p.age < 15 * 12 || p.age >= ret || p.inactive) continue
      const free = 1 - personFte(p)
      if (free < 0.05) continue
      const k = `${p.region}|${p.occ}`
      const l = pool.get(k)
      if (l) l.push(p)
      else pool.set(k, [p])
      if (free > 0.95) {
        const a = anyp.get(p.region)
        if (a) a.push(p)
        else anyp.set(p.region, [p])
      }
    }
    for (const l of pool.values())
      l.sort((a, b) => (b.skill[b.occ as string] ?? 0) - (a.skill[a.occ as string] ?? 0))
    vacancies.sort((a, b) => b[0] - a[0])
    const vacByOcc: Record<string, number> = {}
    let hires = 0
    const nreg = w.regions.length
    for (const [offer, f, o, fte] of vacancies) {
      let remaining = fte
      const occ = cat.occupations[o]
      const sources: Person[][] = [poolOf(f.region, o)]
      // unemployed people can retrain into the occupation if qualified
      sources.push(
        (anyp.get(f.region) ?? []).filter(
          (p) => personFte(p) < 0.05 && eligible(occ, p.edu, p.field, p.skill[o] ?? 0),
        ),
      )
      for (const r2 of permutation(rng, nreg))
        if (r2 !== f.region)
          sources.push(poolOf(r2, o).filter((p) => personFte(p) < 0.05 && p.unemp >= 2))
      // long-term unemployed elsewhere will move and retrain if qualified
      for (const r2 of permutation(rng, nreg))
        if (r2 !== f.region)
          sources.push(
            (anyp.get(r2) ?? []).filter(
              (p) =>
                personFte(p) < 0.05 &&
                p.unemp >= 4 &&
                eligible(occ, p.edu, p.field, p.skill[o] ?? 0),
            ),
          )
      for (const src of sources) {
        for (const p of src) {
          if (remaining <= 0.01) break
          const pf = personFte(p)
          const free = 1 - pf
          if (free < 0.05) continue
          const reservation = Math.max(minWage * 0.9, 0.6 * p.prev_wage)
          if (offer < reservation && p.unemp < 6) continue
          const take = Math.min(free, remaining)
          if (p.occ !== o) {
            // switching occupation (only when fully unemployed)
            if (pf > 0.01) continue
            p.occ = o
            p.skill[o] = Math.max(p.skill[o] ?? 0, Math.min(0.5, 0.08 + 0.3 * p.h))
            p.urban = !RURAL_OCCS.has(o)
          }
          if (p.region !== f.region) {
            this.quitAllJobs(p)
            p.region = f.region
            for (const q of w.persons.values()) if (q.guardian === p.id) q.region = f.region
          }
          const job = p.jobs.get(f.id)
          if (job) {
            job[0] += take
            job[1] = 0.5 * (job[1] + offer)
          } else p.jobs.set(f.id, [take, offer])
          add(f.staff, p.id, take)
          remaining -= take
          hires += take
          // tacit know-how travels with experienced workers
          if (f.design < 1 && p.last_good === f.good)
            f.design = Math.min(0.95, f.design + 0.08 * (p.skill[o] ?? 0.3))
          p.last_good = f.good
        }
        if (remaining <= 0.01) break
      }
      f.wage_offer[`_unfilled_${o}`] = remaining > 0.05 ? 1 : 0
      if (remaining > 0.01) addR(vacByOcc, o, remaining)
    }
    w.stats.vacancies_by_occ = vacByOcc
    ctx.stats.hires = hires * S
    ctx.stats.vacancies = sum(Object.values(vacByOcc)) * S
  }

  // ------------------------------------------------------------ potential
  private potential(ctx: Ctx) {
    const w = this.w
    const cat = this.cat
    for (const f of w.firms.values()) {
      const fs = ctx.firm(f.id)
      if (f.design < 1 || fs.cap <= 0 || fs.y <= 0) {
        fs.labor_cap = 0
        fs.offer = 0
        fs.prod_gross = 0
        continue
      }
      const have = this.staffHours(f)
      fs.have_hours = have
      const hours = fs.hours
      const totH = sum(Object.values(hours)) || 1
      let H = 0
      for (const o of Object.keys(hours)) H += have[o] ?? 0
      const balanced = H / totH
      const g = cat.goods[f.good]
      const floor = g.clean || (g.tol && g.tol < 5) ? 0.02 : 0.25
      let lc = 1
      for (const [o, h] of Object.entries(hours)) {
        let r = h > 0 ? (have[o] ?? 0) / h : 1e18
        r = Math.max(r, floor * balanced)
        lc *= Math.max(r, 1e-12) ** (h / totH)
      }
      fs.labor_cap = lc
      const gross = Math.min(fs.cap, lc)
      fs.pot_gross = gross
      fs.offer = g.svc ? gross * fs.y : 0
      fs.prod_gross = !g.svc ? Math.min(fs.gross, gross) : 0
    }
  }

  // --------------------------------------------------------------- demand
  /** Expected price households face (before VAT). */
  hhPrice(gid: string): number {
    return this.w.prices[gid] ?? this.cat.goods[gid].price
  }

  private demand(ctx: Ctx): Map<string, Demand[]> {
    const w = this.w
    const cat = this.cat
    const pol = w.policy
    const S = w.scale
    const year = yearOf(w)
    const demand = new Map<string, Demand[]>()
    const push = (gid: string, d: Demand) => {
      const l = demand.get(gid)
      if (l) l.push(d)
      else demand.set(gid, [d])
    }
    const supplyRegions = new Map<string, Set<number>>()
    for (const f of w.firms.values()) {
      const fs = ctx.firm(f.id)
      if (
        f.design >= 1 &&
        ((!cat.goods[f.good].svc && f.inv > 0) || fs.offer > 0 || fs.prod_gross > 0)
      ) {
        let s = supplyRegions.get(f.good)
        if (!s) {
          s = new Set()
          supplyRegions.set(f.good, s)
        }
        s.add(f.region)
      }
    }
    this.supplyRegions = supplyRegions
    const available = (gid: string, r: number) => {
      const g = cat.goods[gid]
      const sr = supplyRegions.get(gid)
      if (sr?.size) {
        if (g.local) {
          if (sr.has(r)) return true
        } else return true
      }
      return this.importOk(gid)
    }

    // ---- firm intermediate inputs & equipment orders
    for (const f of w.firms.values()) {
      const fs = ctx.firm(f.id)
      const p = cat.procs[f.proc]
      const g = cat.goods[f.good]
      if (f.design >= 1 && fs.y > 0) {
        const gross = g.svc
          ? Math.min(fs.pot_gross, (Math.max(f.demand_ema, f.sales_ema) * 1.1) / fs.y)
          : fs.prod_gross
        const gf = physical.genFactor(w, cat, f)
        for (const [alts, q] of p.inputs) {
          let choice: [string, number] | null = null
          for (const a of alts) {
            if (available(a, f.region)) {
              const pa = w.prices[a] ?? 1e18
              if (choice === null || pa < choice[1]) choice = [a, pa]
            }
          }
          if (choice === null) continue
          const a = choice[0]
          const need = gross * q * gf
          let order: number
          if (cat.goods[a].svc) order = need
          else {
            let have = 0
            for (const x of alts) have += f.inv_in[x] ?? 0
            order = Math.max(0, 1.5 * need - have)
          }
          if (order > 1e-12) push(a, ["firm", f.id, f.region, order])
        }
      }
      for (const [eq, qty0] of Object.entries(f.orders)) {
        let qty = qty0
        if (qty <= 1e-12) continue
        if (eq === f.good && f.inv > 0) {
          // a machine maker equips itself from its own output
          const take = Math.min(f.inv, qty)
          f.inv -= take
          f.equip[eq] = (f.equip[eq] ?? 0) + take
          f.eq_prec[eq] = f.eq_prec[eq] ?? (cat.goods[eq].prec || 1000)
          f.orders[eq] = qty - take
          qty -= take
        }
        if (qty > 1e-12 && available(eq, f.region)) push(eq, ["inv", f.id, f.region, qty])
        else if (!available(eq, f.region) && cat.goods[eq].year > year + 5) f.orders[eq] = 0 // drop it
      }
    }
    // ---- households
    const kids = new Map<number, number>()
    for (const p of w.persons.values()) if (p.age < 18 * 12 && p.guardian) add(kids, p.guardian, 1)
    const med = Math.max(w.stats.median_wage ?? 1000, 1)
    const incs: [number, Person, number, number][] = []
    for (const p of w.persons.values()) {
      if (p.age < 18 * 12 && p.guardian !== null && w.persons.has(p.guardian)) continue
      const inc = p.income_last
      const nk = kids.get(p.id) ?? 0
      const mpc = 0.95 - 0.2 * Math.min(1, inc / (3 * med))
      const subsist = 0.3 * med * (1 + 0.4 * nk)
      // spending out of wealth rises once savings exceed a comfortable buffer
      const buffer = 6 * Math.max(inc, 0.5 * med)
      const wealthSpend =
        0.01 * Math.min(p.savings, buffer) + 0.04 * Math.max(0, p.savings - buffer)
      let c = Math.max(subsist, mpc * inc + wealthSpend)
      c = Math.min(c, Math.max(0, p.savings))
      incs.push([inc / (1 + 0.5 * nk), p, c, nk])
    }
    incs.sort((a, b) => a[0] - b[0])
    const n = incs.length
    const groups = new Map<string, HhGroup>()
    incs.forEach(([, p, c, nk], i) => {
      const tier = i < n * 0.5 ? 0 : i < n * 0.9 ? 1 : 2
      const key = `${p.region}:${tier}`
      let gr = groups.get(key)
      if (!gr) {
        gr = { region: p.region, budget: 0, members: 0, adults: [] }
        groups.set(key, gr)
      }
      gr.budget += c * S
      gr.members += (1 + nk) * S
      gr.adults.push([p, c])
    })
    this.hhGroups = groups
    const cpi = Math.max(w.price_index, 1e-6)
    const vat = pol.vat
    const csub = pol.subsidies_consumer
    const hhNeed: Record<string, number> = {}
    for (const [key, gr] of groups) {
      const r = gr.region
      const B = gr.budget
      if (B <= 0) continue
      const pcReal = B / gr.members / cpi
      const shares = engelShares(pcReal)
      let unspent = 0
      const plans: [string, number][] = []
      for (const [need, share] of Object.entries(shares)) {
        const goods = (cat.byNeed[need] ?? []).filter((gid) => available(gid, r))
        if (!goods.length) {
          unspent += share
          continue
        }
        const ws = goods.map((gid) => {
          const gg = cat.goods[gid]
          const [, wt, el] = gg.need ?? ["", 0, 0]
          const ref = (cat.worldPrice(gid, year) || gg.price * 3) * w.fx
          const pr = this.hhPrice(gid) * (1 - lookupRate(csub, gid, gg.cat))
          const rel = Math.max(0.05, pr / Math.max(ref, 1e-9))
          return wt * (Math.max(pcReal, 30) / 600) ** el * rel ** -1.5
        })
        const tw = sum(ws)
        goods.forEach((gid, i) => plans.push([gid, (share * ws[i]) / tw]))
      }
      const scaleUp = 1 / Math.max(1e-6, 1 - unspent)
      let goodsValue = 0
      for (const [gid, sh] of plans) {
        const gg = cat.goods[gid]
        let spend = B * sh * scaleUp
        if (!gg.svc) {
          goodsValue += spend * 0.15
          spend *= 0.85
        }
        const pr = this.hhPrice(gid) * (1 + vat) * (1 - lookupRate(csub, gid, gg.cat))
        push(gid, ["hh", key, r, spend / Math.max(pr, 1e-9)])
        addR(hhNeed, gg.need?.[0] ?? "misc", spend)
      }
      if (goodsValue > 0) {
        const pr = this.hhPrice("retail_trade") * (1 + vat)
        push("retail_trade", ["hh", key, r, goodsValue / Math.max(pr, 1e-9)])
      }
    }
    ctx.hhNeed = hhNeed
    // ---- government
    const bud = w.stats.budget ?? {}
    const regs = w.regions
    const totPop = sum(regs.map((r) => r.pop)) || 1
    const students = new Map<number, number>()
    const tert = new Map<number, number>()
    for (const p of w.persons.values()) {
      if (p.school === "school") add(students, p.region, 1)
      else if (p.school) add(tert, p.region, 1)
    }
    const ts = sum(students.values()) || 1
    const tt = sum(tert.values()) || 1
    const eduB = bud.education ?? 0
    const tshare = pol.education_tertiary_share
    const infraW = pol.infrastructure_regions
    const iw = new Map<number, number>()
    for (const r of regs)
      iw.set(r.id, Number(infraW[String(r.id)] ?? (r.pop / totPop) * regs.length))
    const tiw = sum(iw.values()) || 1
    for (const r of regs) {
      const items: [string, number][] = [
        ["public_education", (eduB * (1 - tshare) * (students.get(r.id) ?? 0)) / ts],
        [
          "public_university",
          eduB * tshare * (((tert.get(r.id) ?? 0) / tt) * 0.5 + (r.pop / totPop) * 0.5),
        ],
        ["public_health", ((bud.health ?? 0) * r.pop) / totPop],
        ["public_research", ((bud.research ?? 0) * r.pop) / totPop],
        ["public_admin_services", ((bud.admin ?? 0) * r.pop) / totPop],
        ["infrastructure_works", ((bud.infrastructure ?? 0) * (iw.get(r.id) ?? 0)) / tiw],
      ]
      for (const [gid, val] of items) {
        if (val <= 0) continue
        const pr = w.prices[gid] ?? cat.goods[gid].price
        push(gid, ["gov", r.id, r.id, val / Math.max(pr, 1e-9)])
      }
    }
    return demand
  }

  // --------------------------------------------------------------- markets
  private markets(ctx: Ctx, demand: Map<string, Demand[]>) {
    const w = this.w
    const cat = this.cat
    const sellersByGood = new Map<string, Seller[]>()
    for (const f of w.firms.values()) {
      if (f.design < 1) continue
      const fs = ctx.firm(f.id)
      const g = cat.goods[f.good]
      const avail = g.svc ? fs.offer : f.inv
      if (avail > 1e-12) {
        const l = sellersByGood.get(f.good)
        if (l) l.push([f, avail])
        else sellersByGood.set(f.good, [[f, avail]])
      }
    }
    const goods = [...new Set([...demand.keys(), ...sellersByGood.keys()])]
      .filter((g) => !FREIGHT_GOODS.includes(g))
      .toSorted()
    for (const gid of goods)
      this.clear(ctx, gid, demand.get(gid) ?? [], sellersByGood.get(gid) ?? [])
    this.clearFreight(ctx, sellersByGood)
    // household budgets: deduct actual spending from adults' savings
    for (const [key, gr] of this.hhGroups) {
      const spent = ctx.hh_spent.get(key) ?? 0
      const plan = sum(gr.adults.map(([, c]) => c)) * w.scale
      const ratio = plan > 0 ? spent / plan : 0
      for (const [p, c] of gr.adults) {
        p.savings -= c * ratio
        if (p.savings < 0) p.savings = 0
      }
    }
  }

  private clear(ctx: Ctx, gid: string, buyers: Demand[], sellers: Seller[]) {
    const w = this.w
    const cat = this.cat
    const g = cat.goods[gid]
    const pol = w.policy
    const year = yearOf(w)
    const vat = pol.vat
    const csub = lookupRate(pol.subsidies_consumer, gid, g.cat)
    const psub = lookupRate(pol.subsidies_producer, gid, g.cat)
    const impOk = this.importOk(gid)
    const tariff = impOk ? this.tariff(gid) : 0
    const byRegion = new Map<number, Demand[]>()
    for (const b of buyers) {
      const l = byRegion.get(b[2])
      if (l) l.push(b)
      else byRegion.set(b[2], [b])
    }
    const rem = new Map<Seller, number>()
    for (const s of sellers) rem.set(s, s[1])
    const remOf = (s: Seller) => rem.get(s) ?? 0
    const fl = ctx.flow(gid)
    const regions = shuffle(w.rng, [...byRegion.keys()])
    const mk = `market:${gid}`
    let paidTotal = 0
    let qtyTotal = 0
    for (const r of regions) {
      const bl = byRegion.get(r) ?? []
      const D = sum(bl.map((b) => b[3]))
      if (D <= 0) continue
      const cands: [Seller, number, number][] = []
      for (const s of sellers) {
        const f = s[0]
        if (g.local && f.region !== r) continue
        if (remOf(s) <= 1e-12) continue
        const tc = physical.transportCost(w, cat, gid, f.region, r)
        const eff = (f.price + tc) / Math.max(f.quality, 0.05) ** 1.2
        cands.push([s, tc, eff])
      }
      let impP: number | null = null
      if (impOk) {
        const ip = physical.importPrice(w, cat, gid, r)
        if (ip !== null) impP = ip * (1 + tariff)
      }
      const weights = cands.map((c) => remOf(c[0]) ** 0.5 * Math.max(c[2], 1e-12) ** -SIGMA)
      const wm = impP !== null ? HOME_BIAS * D ** 0.5 * Math.max(impP, 1e-12) ** -SIGMA : 0
      const tw = sum(weights) + wm
      const alloc = cands.map(() => 0)
      let impQ = 0
      if (tw > 0) {
        let left = D
        cands.forEach((c, i) => {
          const want = (D * weights[i]) / tw
          ctx.firm(c[0][0].id).wanted += want
          const take = Math.min(want, remOf(c[0]))
          alloc[i] = take
          left -= take
        })
        impQ = (D * wm) / tw
        left -= impQ
        // overflow: other domestic sellers with spare stock, then imports
        if (left > 1e-12) {
          const order = cands.map((_, i) => i).toSorted((a, b) => cands[a][2] - cands[b][2])
          for (const i of order) {
            const spare = remOf(cands[i][0]) - alloc[i]
            if (spare > 1e-12) {
              const t = Math.min(spare, left)
              alloc[i] += t
              left -= t
            }
            if (left <= 1e-12) break
          }
        }
        if (left > 1e-12 && impP !== null) {
          impQ += left
          left = 0
        }
        addR(fl, "shortage", Math.max(0, left))
      } else {
        addR(fl, "shortage", D)
        continue
      }
      const served = sum(alloc) + impQ
      if (served <= 0) continue
      // money: what buyers in this region pay in total
      let domVal = 0
      cands.forEach(([s, tc], i) => {
        const q = alloc[i]
        if (q <= 0) return
        const f = s[0]
        rem.set(s, remOf(s) - q)
        const rev = q * f.price
        f.cash += rev
        const fs = ctx.firm(f.id)
        fs.sold += q
        fs.revenue += rev
        this.ledger(mk, this.faccount(f), "sales", rev)
        if (psub > 0) {
          const sub = rev * psub
          f.cash += sub
          fs.subsidy += sub
          w.gov.cash -= sub
          addR(ctx.gov_spend, "producer subsidies", sub)
          this.ledger("gov", this.faccount(f), "subsidy", sub)
        }
        add(ctx.freight_fee, r, q * tc)
        if (tc > 0) this.ledger(mk, "market:freight", "transport", q * tc)
        domVal += q * (f.price + tc)
        if (!g.svc) f.inv -= q
        addR(fl, "dom_sold", q)
        addR(fl, "dom_value", rev)
      })
      let impVal = 0
      if (impQ > 0 && impP !== null) {
        const base = impP / (1 + tariff)
        impVal = impQ * impP
        const tariffRev = impQ * base * tariff
        const worldPart = impQ * (cat.worldPrice(gid, year) ?? 0) * w.fx
        const sea = ((impQ * physical.SEA_FREIGHT_PER_T * g.kg) / 1000) * w.fx
        const inland = Math.max(0, impQ * base - worldPart - sea)
        w.gov.cash += tariffRev
        addR(ctx.gov_rev, "tariffs", tariffRev)
        add(ctx.freight_fee, r, inland)
        ctx.sea_fee += sea
        addR(fl, "imports", impQ)
        addR(fl, "import_value", worldPart)
        ctx.addStat("imports", worldPart)
        this.ledger(mk, "row", "imports", worldPart)
        this.ledger(mk, "gov", "tariffs", tariffRev)
        this.ledger(mk, "market:freight", "transport", sea + inland)
      }
      const totalVal = domVal + impVal
      paidTotal += totalVal
      qtyTotal += served
      // buyers pay proportionally
      const frac = served / D
      const unit = totalVal / served
      for (const [kind, key, , q] of bl) {
        const got = q * frac
        const cost = got * unit
        if (kind === "hh") {
          const tax = cost * vat
          const sub = cost * csub
          add(ctx.hh_spent, key as string, cost + tax - sub)
          w.gov.cash += tax - sub
          addR(ctx.gov_rev, "VAT", tax)
          if (sub) addR(ctx.gov_spend, "consumer subsidies", sub)
          this.ledger(`hh:${r}`, mk, "consumption", cost - sub)
          if (tax) this.ledger(`hh:${r}`, "gov", "VAT", tax)
          if (sub) this.ledger("gov", `hh:${r}`, "consumer subsidy", sub)
          addR(fl, "hh_qty", got)
          addR(fl, "hh_value", cost + tax - sub)
        } else if (kind === "gov") {
          w.gov.cash -= cost
          addR(ctx.gov_spend, gid, cost)
          let gb = ctx.gov_bought.get(gid)
          if (!gb) {
            gb = new Map()
            ctx.gov_bought.set(gid, gb)
          }
          add(gb, key as number, got)
          this.ledger("gov", mk, "government purchase", cost)
          addR(fl, "gov_qty", got)
          addR(fl, "gov_value", cost)
        } else {
          const f = w.firms.get(key as number)
          if (!f) continue
          let hs = 0
          if (gid === "dwelling" && pol.housing_subsidy > 0) {
            hs = cost * pol.housing_subsidy
            w.gov.cash -= hs
            addR(ctx.gov_spend, "housing subsidy", hs)
            this.ledger("gov", this.faccount(f), "housing subsidy", hs)
          }
          f.cash -= cost - hs
          this.ledger(this.faccount(f), mk, kind === "inv" ? "investment" : "inputs", cost)
          const fs = ctx.firm(f.id)
          if (kind === "firm") {
            fs.inputs_bought += cost
            f.inv_in[gid] = (f.inv_in[gid] ?? 0) + got
            addR(fl, "firm_qty", got)
            addR(fl, "firm_value", cost)
          } else {
            fs.capex += cost
            const old = f.equip[gid] ?? 0
            const precNew = cat.goods[gid].prec || 1000
            f.equip[gid] = old + got
            const op = f.eq_prec[gid] ?? precNew
            f.eq_prec[gid] = (op * old + precNew * got) / Math.max(old + got, 1e-12)
            f.orders[gid] = Math.max(0, (f.orders[gid] ?? 0) - got)
            addR(fl, "inv_qty", got)
            addR(fl, "inv_value", cost)
          }
        }
      }
    }
    // exports: the rest of the world (WORLD_SCALE times our size, with a similar demand mix)
    // buys from domestic producers in proportion to how competitive they are.
    let wp = cat.worldPrice(gid, year)
    let frontierPremium = false
    if (wp === null && w.produced_ever.has(gid)) {
      wp = g.price * 2.5
      frontierPremium = true
    }
    const absorb = (w.stats.absorb ??= {})
    absorb[gid] = 0.9 * (absorb[gid] ?? qtyTotal) + 0.1 * qtyTotal
    if (wp && !g.nt && !(g.svc && g.local) && sellers.length) {
      const comps: [Seller, number, number][] = sellers.map((s) => {
        const f = s[0]
        const port = physical.nearestPort(w, f.region)
        const tc = physical.transportCost(w, cat, gid, f.region, port)
        const sea = ((physical.SEA_FREIGHT_PER_T * g.kg) / 1000) * w.fx
        return [s, ((wp) * w.fx * f.quality) / Math.max(f.price + tc + sea, 1e-12), tc]
      })
      let worldMkt = WORLD_SCALE * (w.stats.export_mult ?? 1) * Math.max(absorb[gid], 0)
      if (frontierPremium) worldMkt *= 0.3
      const totCap = sum(comps.map((x) => x[0][1])) || 1
      for (const [s, comp, tc] of comps) {
        const share = physical.exportShare(comp)
        const f = s[0]
        const fs = ctx.firm(f.id)
        let appetite = (worldMkt * share * s[1]) / totCap
        if (g.svc) appetite *= 0.5
        if (appetite <= 1e-12) continue
        fs.wanted += appetite
        const q = Math.min(remOf(s), appetite)
        if (q <= 1e-12) continue
        const rev = q * f.price
        f.cash += rev
        rem.set(s, remOf(s) - q)
        if (!g.svc) f.inv -= q
        fs.sold += q
        fs.exported += q
        fs.revenue += rev
        fs.export_rev += rev
        add(ctx.freight_fee, f.region, q * tc)
        if (psub > 0) {
          const sub = rev * psub
          f.cash += sub
          w.gov.cash -= sub
          addR(ctx.gov_spend, "producer subsidies", sub)
          this.ledger("gov", this.faccount(f), "subsidy", sub)
        }
        this.ledger("row", this.faccount(f), "exports", rev)
        addR(fl, "exports", q)
        addR(fl, "export_value", rev)
        ctx.addStat("exports", rev)
        if (frontierPremium && random(w.rng) < 0.05)
          addEvent(
            w,
            "trade",
            `${f.name} is exporting ${g.name} - something the rest of the world cannot yet make.`,
            { firm: f.id, good: gid },
          )
      }
    }
    // reference price: what buyers paid on average (net of tax)
    if (qtyTotal > 0) {
      const avg = paidTotal / qtyTotal
      w.prices[gid] = 0.7 * (w.prices[gid] ?? avg) + 0.3 * avg
    } else if (sellers.length) {
      const mn = Math.min(...sellers.map((s) => s[0].price))
      w.prices[gid] = 0.8 * (w.prices[gid] ?? sellers[0][0].price) + 0.2 * mn
    } else {
      const ip = impOk ? physical.importPrice(w, cat, gid, 0) : null
      if (ip) w.prices[gid] = 0.8 * (w.prices[gid] ?? ip) + 0.2 * ip * (1 + tariff)
    }
    w.imports_12m[gid] = (w.imports_12m[gid] ?? 0) * (11 / 12) + (fl.imports ?? 0)
  }

  /**
   * Transport fees collected in each region go to domestic carriers up to their capacity; the
   * rest is informal own-account haulage (households).
   */
  private clearFreight(ctx: Ctx, sellersByGood: Map<string, Seller[]>) {
    const w = this.w
    for (const [r, fee] of ctx.freight_fee) {
      if (fee <= 0) continue
      const carriers: Seller[] = []
      for (const gid of FREIGHT_GOODS)
        for (const s of sellersByGood.get(gid) ?? []) if (s[0].region === r) carriers.push(s)
      const capVal = sum(carriers.map((s) => s[1] * s[0].price))
      const servedVal = Math.min(fee, capVal)
      for (const s of carriers) {
        const f = s[0]
        const share = capVal > 0 ? (s[1] * f.price) / capVal : 0
        const v = servedVal * share
        const q = v / Math.max(f.price, 1e-9)
        f.cash += v
        const fs = ctx.firm(f.id)
        fs.sold += q
        fs.revenue += v
        fs.wanted += (fee * share) / Math.max(f.price, 1e-9)
        const ff = ctx.flow(f.good)
        addR(ff, "dom_sold", q)
        addR(ff, "dom_value", v)
        this.ledger("market:freight", this.faccount(f), "freight", v)
      }
      const rest = fee - servedVal
      if (rest > 0) {
        add(this.informal, r, rest)
        addR(
          ctx.flow("freight_trucking"),
          "shortage",
          rest / Math.max(w.prices.freight_trucking ?? 110, 1),
        )
      }
    }
    // sea freight: domestic shipping lines first, foreign carriers for the rest
    const ships = sellersByGood.get("freight_shipping") ?? []
    const capVal = sum(ships.map((s) => s[1] * s[0].price))
    const served = Math.min(ctx.sea_fee, capVal)
    for (const s of ships) {
      const f = s[0]
      const v = capVal > 0 ? (served * s[1] * f.price) / capVal : 0
      f.cash += v
      this.ledger("market:freight", this.faccount(f), "freight", v)
      const fs = ctx.firm(f.id)
      fs.sold += v / Math.max(f.price, 1e-9)
      fs.revenue += v
    }
    ctx.stats.sea_freight_foreign = ctx.sea_fee - served
    if (ctx.sea_fee - served > 0)
      this.ledger("market:freight", "row", "sea freight", ctx.sea_fee - served)
    ctx.addStat("imports", ctx.sea_fee - served)
  }

  // ------------------------------------------------------------ production
  private production(ctx: Ctx) {
    const w = this.w
    const cat = this.cat
    const pol = w.policy
    const ctax = pol.carbon_tax
    const cpi = w.price_index
    for (const f of [...w.firms.values()]) {
      const fs = ctx.firm(f.id)
      const p = cat.procs[f.proc]
      const g = cat.goods[f.good]
      let net = 0
      let gross = 0
      let usedVal = 0
      if (f.design >= 1 && fs.y > 0) {
        const y = fs.y
        const gf = physical.genFactor(w, cat, f)
        if (g.svc) {
          gross = fs.sold / y
          if (FREIGHT_GOODS.includes(f.good) || f.good === "freight_shipping")
            gross = Math.min(gross, fs.pot_gross)
        } else gross = fs.prod_gross
        // input limit
        let limit = gross
        const haveOf = (alts: string[]) => sum(alts.map((a) => f.inv_in[a] ?? 0))
        for (const [alts, q] of p.inputs) {
          if (p.optional.has(alts[0])) continue
          const need = q * gf
          if (need > 0) limit = Math.min(limit, haveOf(alts) / need)
        }
        if (!g.svc) {
          if (limit < gross * 0.999) {
            const short = p.inputs
              .filter(
                ([alts, q]) => !p.optional.has(alts[0]) && haveOf(alts) < q * gf * gross * 0.999,
              )
              .map(([alts]) => cat.goods[alts[0]].name)
            if (short.length && gross > 0) f.blocked = `short of ${short.slice(0, 2).join(", ")}`
          }
          gross = Math.max(0, limit)
        }
        net = gross * y
        for (const [alts, q] of p.inputs) {
          let need = gross * q * gf
          const order = [...alts].toSorted((a, b) => (w.prices[a] ?? 1e18) - (w.prices[b] ?? 1e18))
          for (const a of order) {
            if (need <= 0) break
            const have = f.inv_in[a] ?? 0
            const take = Math.min(have, need)
            if (take > 0) {
              f.inv_in[a] = have - take
              need -= take
              usedVal += take * (w.prices[a] ?? 0)
            }
          }
        }
        if (!g.svc) f.inv += net
        f.cum_output += net
        // depletion
        if (p.dep) {
          const d = w.regions[f.region].deposits[p.dep]
          if (d && (d.kind === "stock" || d.kind === "renew")) {
            d.qty = Math.max(0, d.qty - gross)
            if (d.qty <= 0 && d.kind === "stock")
              addEvent(
                w,
                "resource",
                `The ${p.dep} deposit in ${w.regions[f.region].name} is exhausted.`,
                {
                  region: f.region,
                },
              )
          }
        }
        if (!w.produced_ever.has(f.good) && net > 0) w.produced_ever.add(f.good)
        const val = net * f.price
        for (const k of p.know) add(ctx.practiced, k, val)
        const em = p.co2 * gross
        ctx.emissions += em
        if (ctax > 0 && em > 0) {
          const t = em * ctax * cpi
          f.cash -= t
          w.gov.cash += t
          addR(ctx.gov_rev, "carbon tax", t)
          this.ledger(this.faccount(f), "gov", "carbon tax", t)
        }
        if (f.good === "electricity") addR(ctx.elec_mix, f.proc, net)
      }
      // non-storable inputs do not keep
      for (const a of Object.keys(f.inv_in)) if (cat.goods[a].svc) delete f.inv_in[a]
      // land rent to rural landowners
      const eq = p.equip ? p.equip[0] : null
      let landRent = 0
      if (eq !== null && eq in cat.endowments) {
        const r = w.regions[f.region]
        const scarcity = 0.5 + (r.land_used[eq] ?? 0) / Math.max(r.land[eq] ?? 1, 1)
        landRent =
          (f.equip[eq] ?? 0) *
          cat.endowments[eq].rent *
          cpi *
          (w.stats.wage_level ?? 1) ** 0.5 *
          scarcity
        f.cash -= landRent
        add(this.informal, f.region, landRent)
        this.ledger(this.faccount(f), `hh:${f.region}`, "land rent", landRent)
      }
      // depreciation
      let depVal = 0
      const depUnits: Record<string, number> = {}
      for (const [e, n] of Object.entries(f.equip)) {
        if (e in cat.endowments) continue
        const life = cat.goods[e].life || 120
        const d = n / life
        f.equip[e] = n - d
        depUnits[e] = d
        depVal += d * (w.prices[e] ?? cat.goods[e].price)
      }
      fs.net = net
      fs.gross_done = gross
      fs.used_val = usedVal
      fs.land_rent = landRent
      fs.dep_val = depVal
      fs.dep_units = depUnits
      f.last.output = net
    }
    // renewable stocks regrow
    for (const r of w.regions)
      for (const d of Object.values(r.deposits))
        if (d.kind === "renew" && d.qty0 > 0)
          d.qty = Math.min(d.qty0, d.qty + d.regen * d.qty * (1 - d.qty / d.qty0) + d.qty0 * 0.0005)
  }

  // --------------------------------------------------------------- incomes
  incomeTax(monthly: number): number {
    const br = this.w.policy.income_tax
    const med = Math.max(this.w.stats.median_wage ?? 1000, 1)
    const edges = [0, 0.5 * med, 1.5 * med, 4 * med, Infinity]
    let tax = 0
    for (let i = 0; i < 4; i++) {
      const lo = edges[i]
      const hi = edges[i + 1]
      if (monthly > lo) tax += (Math.min(monthly, hi) - lo) * br[i]
    }
    return tax
  }

  private incomes(ctx: Ctx) {
    const w = this.w
    const cat = this.cat
    const pol = w.policy
    const S = w.scale
    const st = w.stats
    const avgWage = st.avg_wage ?? 1000
    const med = st.median_wage ?? avgWage
    const ret = pol.retirement_age * 12
    const dep = (st.dep_rate ?? 0) / 12
    const lend = (st.lend_rate ?? 0) / 12
    const wagesByFirm = new Map<number, number>()
    const kids = new Map<number, number>()
    for (const p of w.persons.values()) if (p.age < 18 * 12 && p.guardian) add(kids, p.guardian, 1)
    let taxTotal = 0
    let benTotal = 0
    let penTotal = 0
    let childTotal = 0
    let intHh = 0
    const hhTaxR = new Map<number, number>()
    const hhBenR = new Map<number, number>()
    for (const p of w.persons.values()) {
      let gross = 0
      for (const [fid, [fte, wage]] of p.jobs) {
        const pay = fte * wage
        gross += pay
        add(wagesByFirm, fid, pay * S)
      }
      const tax = gross > 0 ? this.incomeTax(gross) : 0
      const net = gross - tax
      const fte = personFte(p)
      let ben = 0
      if (p.age >= ret) {
        ben += pol.pension_rate * avgWage
        penTotal += pol.pension_rate * avgWage
      } else if (p.occ && !p.school && p.age >= 18 * 12 && fte < 0.95 && !p.inactive) {
        if (fte < 0.5) p.unemp += 1
        const base = Math.max(p.prev_wage, 0.5 * med)
        const rate = pol.unemployment_benefit * (p.unemp <= 12 ? 1 : 0.5)
        const b = rate * base * (1 - fte)
        ben += b
        benTotal += b
      }
      if (fte >= 0.5) p.unemp = 0
      const nk = kids.get(p.id) ?? 0
      if (nk) {
        const cb = nk * pol.child_benefit * avgWage
        ben += cb
        childTotal += cb
      }
      const interest = Math.max(p.savings, 0) * dep
      intHh += interest
      p.savings += net + ben + interest
      p.income_last = net + ben + interest
      if (gross > 0) p.prev_wage = Math.max(p.prev_wage * 0.98, gross / Math.max(fte, 0.05))
      taxTotal += tax
      add(hhTaxR, p.region, tax * S)
      add(hhBenR, p.region, ben * S)
    }
    // firms pay wages
    for (const [fid, amt] of wagesByFirm) {
      const f = w.firms.get(fid)
      if (!f) continue
      f.cash -= amt
      ctx.firm(fid).wages = amt
      add(ctx.region_va, f.region, amt)
      this.ledger(this.faccount(f), `hh:${f.region}`, "wages", amt)
    }
    w.gov.cash += taxTotal * S
    addR(ctx.gov_rev, "income tax", taxTotal * S)
    for (const [r, t] of hhTaxR) this.ledger(`hh:${r}`, "gov", "income tax", t)
    for (const [r, b] of hhBenR) this.ledger("gov", `hh:${r}`, "transfers", b)
    w.gov.cash -= (benTotal + penTotal + childTotal) * S
    addR(ctx.gov_spend, "unemployment benefits", benTotal * S)
    addR(ctx.gov_spend, "pensions", penTotal * S)
    addR(ctx.gov_spend, "child benefits", childTotal * S)
    w.bank.equity -= intHh * S
    this.ledger("bank", "hh", "deposit interest", intHh * S)
    ctx.stats.wage_bill = sum(wagesByFirm.values())
    // informal incomes (own-account haulage, land rents) -> households in region
    for (const [r, amt] of this.informal) {
      const people = [...w.persons.values()].filter((p) => p.region === r && p.age >= 18 * 12)
      if (!people.length || amt <= 0) continue
      const per = amt / S / people.length
      for (const p of people) {
        p.savings += per
        p.income_last += per
      }
      this.ledger("market:freight", `hh:${r}`, "own-account & rents", amt)
    }
    // interest on firm debt & government debt
    let bankInt = 0
    for (const f of w.firms.values()) {
      if (f.debt > 0) {
        const i = f.debt * lend
        f.cash -= i
        bankInt += i
        ctx.firm(f.id).interest = i
        this.ledger(this.faccount(f), "bank", "interest", i)
      }
    }
    const gi = (w.gov.debt * (w.policy_rate + 0.005)) / 12
    w.gov.cash -= gi
    addR(ctx.gov_spend, "interest on debt", gi)
    this.ledger("gov", "bank", "interest", gi)
    w.bank.equity += bankInt + gi
    // property tax on dwellings
    const ptax = pol.property_tax / 12
    for (const f of w.firms.values()) {
      if (f.good === "housing") {
        const t = (f.equip.dwelling ?? 0) * (w.prices.dwelling ?? 2e5) * ptax
        f.cash -= t
        w.gov.cash += t
        addR(ctx.gov_rev, "property tax", t)
        this.ledger(this.faccount(f), "gov", "property tax", t)
      }
    }
    // ---- profits, corporate tax, dividends
    const wealthy = [...w.persons.values()]
      .filter((p) => p.age >= 18 * 12)
      .toSorted((a, b) => b.savings - a.savings)
    const top = wealthy.slice(0, Math.max(1, Math.trunc(wealthy.length / 4)))
    const topw = sum(top.map((p) => Math.max(p.savings, 1) ** 0.5))
    let divPool = 0
    const corpTax = pol.corporate_tax
    for (const f of w.firms.values()) {
      const fs = ctx.firm(f.id)
      const rev = fs.revenue + fs.subsidy + fs.freight_rev
      const costs = fs.wages + fs.used_val + fs.interest + fs.dep_val + fs.land_rent
      // unsold production adds to inventory (valued at cost) - not a loss
      const profit = rev - costs + (fs.net - fs.sold) * f.cost_ema * (cat.goods[f.good].svc ? 0 : 1)
      fs.profit = profit
      f.profit_ema = 0.85 * f.profit_ema + 0.15 * profit
      let tax = 0
      if (profit > 0 && f.owner !== "state") {
        tax = profit * corpTax
        f.cash -= tax
        w.gov.cash += tax
        addR(ctx.gov_rev, "corporate tax", tax)
        this.ledger(this.faccount(f), "gov", "corporate tax", tax)
      }
      fs.tax = tax
      const monthlyCosts = Math.max(costs, 1)
      if (f.cash > 3 * monthlyCosts && f.profit_ema > 0) {
        let div = 0.8 * Math.max(0, profit - tax) + 0.1 * (f.cash - 3 * monthlyCosts)
        div = Math.min(div, f.cash - 2 * monthlyCosts)
        if (div > 0) {
          f.cash -= div
          if (f.owner === "state") {
            w.gov.cash += div
            addR(ctx.gov_rev, "state firm profits", div)
            this.ledger(this.faccount(f), "gov", "dividends", div)
          } else if (f.owner === "foreign") {
            ctx.addStat("foreign_dividends", div)
            this.ledger(this.faccount(f), "row", "dividends", div)
          } else {
            divPool += div
            this.ledger(this.faccount(f), `hh:${f.region}`, "dividends", div)
          }
        }
      }
      // loan repayment from surplus cash (amortization, not a fire sale)
      if (f.debt > 0 && f.cash > 3 * monthlyCosts) {
        const rep = Math.min(f.debt, 0.05 * (f.cash - 3 * monthlyCosts), f.debt / 120)
        f.cash -= rep
        f.debt -= rep
        w.bank.loans -= rep
        this.ledger(this.faccount(f), "bank", "loan repayment", rep)
      }
    }
    // bank pays dividends when well capitalized
    const req = pol.bank_capital_ratio * (w.bank.loans + 0.2 * w.bank.bonds)
    if (w.bank.equity > req * 1.5) {
      const bd = 0.1 * (w.bank.equity - req * 1.5)
      w.bank.equity -= bd
      divPool += bd
      this.ledger("bank", "hh", "dividends", bd)
    }
    if (divPool > 0 && topw > 0) {
      // half to direct shareholders (the wealthy), half via pension funds and savings plans
      for (const p of top) {
        const d = (0.5 * divPool * Math.max(p.savings, 1) ** 0.5) / topw / S
        p.savings += d
        p.income_last += d
      }
      const adults = [...w.persons.values()].filter((p) => p.age >= 25 * 12)
      if (adults.length) {
        const per = (0.5 * divPool) / S / adults.length
        for (const p of adults) {
          p.savings += per
          p.income_last += per
        }
      }
    }
    ctx.stats.dividends = divPool
    // government financing
    const g = w.gov
    const gdp = st.gdp_trailing ?? st.gdp_month ?? 1e8
    if (g.cash < 0.05 * gdp) {
      const issue = 0.05 * gdp - g.cash
      g.cash += issue
      g.debt += issue
      w.bank.bonds += issue
      this.ledger("bank", "gov", "bond issuance", issue)
    } else if (g.cash > 0.4 * gdp && g.debt > 0) {
      const rep = Math.min(g.debt, g.cash - 0.3 * gdp)
      g.cash -= rep
      g.debt -= rep
      w.bank.bonds = Math.max(0, w.bank.bonds - rep)
      this.ledger("gov", "bank", "debt repayment", rep)
    }
  }

  // -------------------------------------------------------- firm finance
  bankCanLend(amount: number): boolean {
    const w = this.w
    const cap = w.bank.equity / Math.max(w.policy.bank_capital_ratio, 0.01)
    return w.bank.loans + 0.2 * w.bank.bonds + amount <= cap
  }

  lend(f: Firm, amount: number, kind = "loan") {
    const w = this.w
    f.debt += amount
    f.cash += amount
    w.bank.loans += amount
    this.ledger("bank", this.faccount(f), kind, amount)
  }

  capitalValue(f: Firm): number {
    const cat = this.cat
    let s = 0
    for (const [e, n] of Object.entries(f.equip))
      if (!(e in cat.endowments)) s += n * (this.w.prices[e] ?? cat.goods[e].price)
    return s
  }

  private firmFinance(ctx: Ctx) {
    const w = this.w
    const cat = this.cat
    const rng = w.rng
    const dead: Firm[] = []
    for (const f of [...w.firms.values()]) {
      const fs = ctx.firm(f.id)
      const g = cat.goods[f.good]
      const p = cat.procs[f.proc]
      const net = fs.net
      const sold = fs.sold
      const costs = fs.wages + fs.used_val + fs.dep_val + fs.interest + fs.land_rent
      f.last = {
        output: net,
        sold,
        revenue: fs.revenue,
        exports: fs.export_rev,
        wages: fs.wages,
        inputs: fs.inputs_bought,
        profit: fs.profit,
        subsidy: fs.subsidy,
        capex: fs.capex,
        util: fs.cap ? net / Math.max(fs.cap * fs.y, 1e-12) : 0,
        staff: sum(f.staff.values()) * w.scale,
        costs,
        va: fs.revenue + fs.subsidy - fs.used_val,
      }
      if (f.design < 1) {
        // R&D-stage firm: burns cash on salaries
        knowledgeEngine.firmRd(this, ctx, f)
        if (f.design >= 1) this.initialEquipment(f)
        this.solvency(ctx, f, costs, dead)
        continue
      }
      addR(ctx.sector_va, SECTOR_OF_CAT[g.cat] ?? "Other", f.last.va ?? 0)
      // expectations
      f.sales_ema = 0.7 * f.sales_ema + 0.3 * sold
      f.demand_ema = 0.75 * f.demand_ema + 0.25 * Math.max(fs.wanted, sold)
      f.export_ema = 0.8 * f.export_ema + 0.2 * fs.exported
      const netcap = fs.cap * fs.y
      const util = netcap > 0 ? net / netcap : 0
      f.util_ema = 0.8 * f.util_ema + 0.2 * util
      if (net > 1e-9) {
        // variable costs per unit + overheads spread over normal output (firms do not raise
        // prices just because a slump idles plant); financing costs hit profits, not prices
        const fixed = costs - fs.used_val - fs.interest
        const normal = Math.max(net, netcap > 0 ? 0.8 * netcap : net)
        const unit = fs.used_val / net + fixed / normal
        f.cost_ema = f.cost_ema <= 0 ? unit : 0.8 * f.cost_ema + 0.2 * unit
      }
      // pricing: markup responds to stock / utilization
      if (g.svc) {
        const u = fs.offer > 0 ? sold / fs.offer : 1
        if (u > 0.95) f.markup += 0.01
        else if (u < 0.6) f.markup -= 0.01
      } else {
        const ratio = f.inv / Math.max(f.sales_ema, 1e-9)
        if (ratio < 0.6) f.markup += 0.01
        else if (ratio > 1.6) f.markup -= 0.015
      }
      // markups drift back toward a normal margin
      f.markup += 0.01 * (0.15 - f.markup)
      f.markup = Math.max(-0.1, Math.min(0.8, f.markup))
      if (f.cost_ema > 0) f.price = 0.85 * f.price + 0.15 * f.cost_ema * (1 + f.markup)
      // chronic overcapacity: sell idle machines for scrap and repay debt
      if (f.util_ema < 0.45 && netcap > 0 && f.good !== "housing" && g.cat !== "public")
        this.downsize(f)
      // investment: maintenance every month, expansion occasionally
      this.maintain(ctx, f, fs)
      if (random(rng) < 0.25) this.invest(ctx, f, p, netcap)
      knowledgeEngine.firmRd(this, ctx, f)
      // process upgrades (e.g. hand tools -> machines when wages rise)
      if ((w.tick + f.id) % 12 === 0) this.considerSwitch(f)
      this.solvency(ctx, f, costs, dead)
    }
    for (const f of dead) this.bankrupt(ctx, f)
    this.entry(ctx)
  }

  private solvency(ctx: Ctx, f: Firm, costs: number, dead: Firm[]) {
    const w = this.w
    if (f.cash >= 0) {
      f.distress = Math.max(0, f.distress - 1)
      return
    }
    const need = -f.cash + costs
    if (f.owner === "state" || this.cat.goods[f.good].cat === "public") {
      w.gov.cash -= need
      f.cash += need
      addR(ctx.gov_spend, "state firm support", need)
      this.ledger("gov", this.faccount(f), "state support", need)
      return
    }
    if (f.owner === "foreign") {
      f.cash += need
      this.ledger("row", this.faccount(f), "parent capital", need)
      ctx.addStat("fdi", need)
      f.distress += 1
      if (f.distress > 18) dead.push(f)
      return
    }
    if (
      ["housing", "electricity", "fresh_water", "retail_trade"].includes(f.good) &&
      f.distress >= 6
    ) {
      // landlords/utilities are restructured, not liquidated: the bank writes down debt and
      // the assets keep operating
      const cut = Math.max(0, f.debt - 0.4 * this.capitalValue(f))
      if (cut > 0) {
        f.debt -= cut
        w.bank.equity -= cut
        w.bank.loans -= cut
        this.ledger("bank", this.faccount(f), "debt restructuring", cut)
      }
      f.distress = 0
    }
    const limit = 0.8 * this.capitalValue(f) + 4 * Math.max(f.last.revenue ?? 0, 0) + 3 * costs
    if (f.debt + need <= limit && this.bankCanLend(need)) {
      this.lend(f, need, "working capital loan")
      f.distress += f.profit_ema < 0 ? 1 : 0
    } else f.distress += 2
    if (f.distress >= 8) dead.push(f)
  }

  private bankrupt(ctx: Ctx, f: Firm) {
    const w = this.w
    const g = this.cat.goods[f.good]
    if (!w.firms.has(f.id)) return
    for (const pid of f.staff.keys()) {
      const p = w.persons.get(pid)
      const job = p?.jobs.get(f.id)
      if (p && job) {
        p.prev_wage = Math.max(p.prev_wage, job[1])
        p.jobs.delete(f.id)
      }
    }
    f.staff = new Map()
    const loss = Math.max(0, f.debt - Math.max(f.cash, 0) - 0.3 * this.capitalValue(f))
    w.bank.equity -= loss
    w.bank.loans -= f.debt
    this.ledger("bank", this.faccount(f), "loan write-off", loss)
    const r = w.regions[f.region]
    const eq = this.cat.procs[f.proc].equip
    if (eq && eq[0] in this.cat.endowments)
      r.land_used[eq[0]] = Math.max(0, (r.land_used[eq[0]] ?? 0) - (f.equip[eq[0]] ?? 0))
    f.alive = false
    w.firms.delete(f.id)
    ctx.addStat("bankruptcies", 1)
    addEvent(w, "bankruptcy", `${f.name} (${g.name}, ${r.name}) went bankrupt.`, {
      good: f.good,
      firm: f.id,
    })
  }

  private invest(ctx: Ctx, f: Firm, p: Process, netcap: number) {
    const w = this.w
    const cat = this.cat
    if (f.good === "housing") {
      this.investHousing(f)
      return
    }
    if (!p.equip) return
    // target capacity follows expected demand (expansion); maintenance replacement of worn-out
    // machines happens separately every month
    let eq = p.equip[0]
    for (const a of p.equip) if ((f.equip[a] ?? 0) > (f.equip[eq] ?? 0)) eq = a
    if ((f.equip[eq] ?? 0) <= 0 || netcap <= 0) return
    const desired = f.demand_ema * 1.15
    if (f.profit_ema < 0) return
    // expansion must beat the cost of borrowing (monetary policy channel)
    const kv = this.capitalValue(f)
    if (kv > 0 && (f.profit_ema * 12) / kv < (w.stats.lend_rate ?? 0.06) * 0.8) return
    const gap = desired - netcap - ((f.orders[eq] ?? 0) * netcap) / f.equip[eq]
    if (gap <= 0.03 * netcap) return
    const frac = Math.min(0.1, gap / netcap)
    const addq = new Map<string, number>([[eq, f.equip[eq] * frac]])
    for (const [name, [alts, ratio]] of Object.entries(p.aux)) {
      let a = alts[0]
      for (const x of alts) if ((f.equip[x] ?? 0) > (f.equip[a] ?? 0)) a = x
      if (p.optional.has(name) && cat.goods[a].year > yearOf(w)) continue
      addq.set(a, (addq.get(eq) ?? 0) * ratio)
    }
    if (eq in cat.endowments) {
      const r = w.regions[f.region]
      const free = (r.land[eq] ?? 0) - (r.land_used[eq] ?? 0)
      if (free <= 0) f.blocked = "no free land to expand"
      else {
        const take = Math.min(free, addq.get(eq) ?? 0)
        f.equip[eq] += take
        r.land_used[eq] = (r.land_used[eq] ?? 0) + take
      }
      addq.delete(eq)
    }
    if (p.dep) {
      const d = w.regions[f.region].deposits[p.dep]
      if (d && d.kind === "flow" && p.dep === "hydro" && (f.equip[eq] ?? 0) >= d.qty) return
    }
    let cost = 0
    for (const [a, q] of addq) cost += q * (w.prices[a] ?? cat.goods[a].price)
    if (cost <= 0) return
    const lastCosts = Math.max(f.last.costs ?? 0, 0)
    if (f.cash < cost + 2 * lastCosts) {
      const need = cost + 2 * lastCosts - f.cash
      const limit = 0.7 * (this.capitalValue(f) + cost) + 12 * Math.max(f.profit_ema, 0)
      if (f.debt + need > limit || !this.bankCanLend(need)) return
      this.lend(f, need, "investment loan")
    }
    for (const [a, q] of addq) f.orders[a] = (f.orders[a] ?? 0) + q
    ctx.addStat("orders_expand", cost)
  }

  private downsize(f: Firm) {
    const w = this.w
    const cat = this.cat
    const cut = 0.04
    let proceeds = 0
    for (const [e, n] of Object.entries(f.equip)) {
      const d = n * cut
      f.equip[e] = n - d
      if (e in cat.endowments) {
        const r = w.regions[f.region]
        r.land_used[e] = Math.max(0, (r.land_used[e] ?? 0) - d)
        continue
      }
      proceeds += d * (w.prices[e] ?? cat.goods[e].price) * 0.3
    }
    if (proceeds > 0) {
      // scrap buyers pay out of the domestic economy (a transfer from households)
      f.cash += proceeds
      add(this.informal, f.region, -proceeds)
      this.ledger(`hh:${f.region}`, this.faccount(f), "asset sales", proceeds)
      const rep = Math.min(f.debt, proceeds)
      f.debt -= rep
      f.cash -= rep
      w.bank.loans -= rep
      this.ledger(this.faccount(f), "bank", "loan repayment", rep)
    }
  }

  /** Replace machines that wore out this month if the plant is in use. */
  private maintain(ctx: Ctx, f: Firm, fs: FirmState) {
    const w = this.w
    const cat = this.cat
    if (f.util_ema < 0.4 || f.good === "housing") return
    if (f.profit_ema < -0.15 * Math.max(f.last.revenue ?? 0, 1)) return
    let cost = 0
    for (const [a, d] of Object.entries(fs.dep_units)) {
      if (d > 0 && (f.orders[a] ?? 0) < 3 * d) {
        f.orders[a] = (f.orders[a] ?? 0) + d
        cost += d * (w.prices[a] ?? cat.goods[a].price)
      }
    }
    ctx.addStat("orders_maint", cost)
    if (cost > f.cash && cost > 0) {
      const need = cost - Math.max(f.cash, 0)
      if (
        this.bankCanLend(need) &&
        f.debt + need < 0.8 * this.capitalValue(f) + 6 * Math.max(f.last.revenue ?? 0, 0)
      )
        this.lend(f, need, "investment loan")
    }
  }

  private investHousing(f: Firm) {
    const w = this.w
    const r = w.regions[f.region]
    const stock = f.equip.dwelling ?? 0
    const occ = f.demand_ema / Math.max(stock, 1)
    const cap = this.maxDwellings(r)
    const room = cap - stock - (f.orders.dwelling ?? 0)
    const costRent =
      (w.prices.dwelling ?? 2.2e5) *
      (1 - w.policy.housing_subsidy) *
      ((w.stats.lend_rate ?? 0.06) / 12 + 1 / 900) *
      1.1
    if (occ > 0.97 && f.price > costRent && room > 0) {
      const q = Math.min(room, stock * 0.006 * Math.min(3, ((occ / 0.97) * f.price) / costRent))
      const cost = q * (w.prices.dwelling ?? 2.2e5)
      if (f.cash < cost) {
        const need = cost - f.cash
        if (this.bankCanLend(need)) this.lend(f, need, "mortgage/construction loan")
        else return
      }
      f.orders.dwelling = (f.orders.dwelling ?? 0) + q
    } else if (room <= 0 && occ > 1) f.blocked = "zoning cap reached"
  }

  /** A firm that just finished its design orders production equipment. */
  initialEquipment(f: Firm) {
    const w = this.w
    const cat = this.cat
    const year = yearOf(w)
    const p = cat.procs[f.proc]
    const target = f.last.target_qty || f.demand_ema || 1
    const r = w.regions[f.region]
    const cpp = physical.capacityPerPrimary(w, cat, p, r) || p.rate || 1
    const n = (target * 1.2) / Math.max(cpp, 1e-12)
    if (p.equip) {
      let eq = p.equip[0]
      for (const a of p.equip) {
        if (w.produced_ever.has(a) || (cat.goods[a].year <= year && !cat.goods[a].restricted)) {
          eq = a
          break
        }
      }
      if (eq in cat.endowments) {
        const free = (r.land[eq] ?? 0) - (r.land_used[eq] ?? 0)
        const take = Math.max(0, Math.min(free, n))
        f.equip[eq] = (f.equip[eq] ?? 0) + take
        r.land_used[eq] = (r.land_used[eq] ?? 0) + take
      } else f.orders[eq] = (f.orders[eq] ?? 0) + n
      for (const [alts, ratio] of Object.values(p.aux)) {
        const a = alts.find((x) => w.produced_ever.has(x) || cat.goods[x].year <= year) ?? alts[0]
        f.orders[a] = (f.orders[a] ?? 0) + n * ratio
      }
    }
    f.demand_ema = Math.max(f.demand_ema, target)
    f.price = f.price || (w.prices[f.good] ?? cat.goods[f.good].price)
  }

  estUnitCost(p: Process, region: number): number | null {
    return physical.estUnitCost(this.w, this.cat, p, region)
  }

  /** Can this process be started domestically now? Returns [ok, reason]. */
  processFeasible(p: Process, region: number | null = null): [boolean, string | null] {
    const w = this.w
    const cat = this.cat
    const year = yearOf(w)
    for (const k of p.know)
      if ((w.knowledge[k] ?? 0) < 0.5)
        return [false, `science/know-how missing: ${cat.knowledge[k].name}`]
    if (p.equip) {
      const ok = p.equip.some((a) => {
        const ga = cat.goods[a]
        return (
          a in cat.endowments ||
          w.produced_ever.has(a) ||
          (ga.year <= year && !ga.restricted && !ga.nt) ||
          (ga.local && ga.year <= year)
        )
      })
      if (!ok) return [false, `no access to ${cat.goods[p.equip[0]].name}`]
    }
    const regs = physical.regionsForProcess(w, cat, p)
    if (!regs.length) return [false, "no suitable site (deposit, land or climate)"]
    if (region !== null && !regs.includes(region)) return [false, "site unsuitable"]
    return [true, null]
  }

  private considerSwitch(f: Firm) {
    const w = this.w
    const cat = this.cat
    const g = cat.goods[f.good]
    const cur = cat.procs[f.proc]
    if (g.processes.length < 2) return
    const c0 = this.estUnitCost(cur, f.region) ?? 1e18
    let best: [string, number] | null = null
    for (const pid of g.processes) {
      if (pid === f.proc) continue
      const p2 = cat.procs[pid]
      if (!this.processFeasible(p2, f.region)[0]) continue
      const c = this.estUnitCost(p2, f.region)
      if (c !== null && c < 0.8 * c0 && (best === null || c < best[1])) best = [pid, c]
    }
    if (best && f.cash > 0) {
      const old = f.proc
      f.proc = best[0]
      const p2 = cat.procs[best[0]]
      const target = Math.max(f.sales_ema, f.plan, 1e-9)
      const r = w.regions[f.region]
      // release land of the old process if it differs
      const oldEq = cat.procs[old].equip?.[0] ?? null
      const newEq = p2.equip?.[0] ?? null
      if (oldEq !== null && oldEq in cat.endowments && oldEq !== newEq) {
        r.land_used[oldEq] = Math.max(0, (r.land_used[oldEq] ?? 0) - (f.equip[oldEq] ?? 0))
        delete f.equip[oldEq]
      }
      f.last.target_qty = target
      if (newEq === null || !(newEq in cat.endowments) || newEq !== oldEq) this.initialEquipment(f)
      else {
        for (const [alts, ratio] of Object.values(p2.aux)) {
          const a = alts.find((x) => cat.goods[x].year <= yearOf(w)) ?? alts[0]
          f.orders[a] = (f.orders[a] ?? 0) + (f.equip[newEq] ?? 0) * ratio
        }
      }
      addEvent(
        w,
        "technology",
        `${f.name} switched ${g.name} production from ` +
          `${cat.procs[old].trad ? "traditional methods" : old} to ` +
          `${p2.trad ? "traditional methods" : "a modern process"} ` +
          `(est. unit cost ${fmtG4(c0)} -> ${fmtG4(best[1])}).`,
        { firm: f.id, good: f.good },
      )
    }
  }

  /**
   * Entrepreneurs, foreign investors and the state look for goods that are imported or in short
   * supply and could be made here profitably.
   */
  private entry(ctx: Ctx) {
    const w = this.w
    const cat = this.cat
    const rng = w.rng
    const pol = w.policy
    const S = w.scale
    const cands: [string, number][] = []
    const short = (w.stats.shortage_ema ??= {})
    for (const [gid, fl] of ctx.flows)
      short[gid] = 0.9 * (short[gid] ?? 0) + 0.1 * (fl.shortage ?? 0)
    for (const [gid, g] of Object.entries(cat.goods)) {
      if (g.endowment || g.cat === "public") continue
      const impQ = (w.imports_12m[gid] ?? 0) / 12
      const val = (impQ + (short[gid] ?? 0)) * (w.prices[gid] ?? g.price)
      if (val > 20 * S) cands.push([gid, val])
    }
    const ipGoods = new Set<string>()
    for (const item of pol.industrial_policy ?? []) {
      if (item in cat.goods) ipGoods.add(item)
      else
        for (const [gg, gv] of Object.entries(cat.goods))
          if (gv.cat === item && !gv.endowment) ipGoods.add(gg)
    }
    for (const gid of [...ipGoods].toSorted()) cands.push([gid, 1e9])
    if (!cands.length) return
    const picks: string[] = []
    const tot = sum(cands.map(([, v]) => v))
    for (let i = 0; i < Math.min(10, cands.length); i++) {
      let x = random(rng) * tot
      for (const [gid, v] of cands) {
        x -= v
        if (x <= 0) {
          if (!picks.includes(gid)) picks.push(gid)
          break
        }
      }
    }
    let created = 0
    for (const gid of picks) {
      if (created >= 4) break
      const g = cat.goods[gid]
      const existing = [...w.firms.values()].filter((f) => f.good === gid)
      if (existing.some((f) => f.design < 1)) continue // someone is already developing it
      if (existing.some((f) => f.util_ema < 0.7 && f.design >= 1) && !ipGoods.has(gid)) continue
      const gapQty = (w.imports_12m[gid] ?? 0) / 12 + (short[gid] ?? 0)
      let best: [string, number, number] | null = null
      for (const pid of g.processes) {
        const p = cat.procs[pid]
        if (!this.processFeasible(p)[0]) continue
        const regs = physical.regionsForProcess(w, cat, p)
        const rw = physical.regionWeights(w, cat, p, regs)
        let rid = -1
        let bestScore = -Infinity
        for (const [r, wt] of rw) {
          const sc = wt * uniform(rng, 0.7, 1.3)
          if (sc > bestScore) {
            bestScore = sc
            rid = r
          }
        }
        if (rid < 0) continue
        const c = this.estUnitCost(p, rid)
        if (c === null) continue
        if (best === null || c < best[1]) best = [pid, c, rid]
      }
      if (best === null) continue
      const [pid, cost, rid] = best
      const p = cat.procs[pid]
      const ip = this.importOk(gid) ? physical.importPrice(w, cat, gid, rid) : null
      let mkt = ip ? ip * (1 + this.tariff(gid)) : (w.prices[gid] ?? g.price)
      if ((short[gid] ?? 0) > (w.imports_12m[gid] ?? 0) / 12)
        mkt = Math.max(mkt, w.prices[gid] ?? mkt)
      const margin = mkt / Math.max(cost, 1e-12) - 1
      const state = ipGoods.has(gid)
      if (margin < 0.06 && !(state && margin > -0.35)) continue
      // start with a pilot plant; expand once demand is proven
      let target = Math.max(gapQty * uniform(rng, 0.07, 0.15), 1e-9)
      const simple = p.design_effort < 400 && p.know.every((k) => (w.knowledge[k] ?? 0) >= 0.8)
      let design = w.produced_ever.has(gid) || simple || p.trad ? 1 : 0
      let owner: Firm["owner"] = "private"
      if (
        design < 1 &&
        this.importOk(gid) &&
        random(rng) < pol.fdi_openness * Math.min(1, margin + 0.3) &&
        (w.stats.wage_level_vs_world ?? 1) < 0.9
      ) {
        owner = "foreign"
        design = 1
      }
      if (state) owner = "state"
      // financing
      const r = w.regions[rid]
      const cpp = physical.capacityPerPrimary(w, cat, p, r) || p.rate || 1
      const nEq = (target * 1.2) / Math.max(cpp, 1e-12)
      const eq = p.equip ? p.equip[0] : null
      let capex = 0
      if (eq !== null && !(eq in cat.endowments))
        capex = nEq * (w.prices[eq] ?? cat.goods[eq].price) * (1 + 0.3 * Object.keys(p.aux).length)
      if (design < 1) capex = 0 // R&D first; equipment after the design works
      const bankRoom =
        w.bank.equity / Math.max(pol.bank_capital_ratio, 0.01) - w.bank.loans - 0.2 * w.bank.bonds
      if (capex > 0.05 * Math.max(bankRoom, 0) && owner === "private") {
        const shrink = (0.05 * Math.max(bankRoom, 0)) / capex
        if (shrink < 0.05) continue
        capex *= shrink
        target *= shrink
      }
      const seedCash =
        pol.business_entry_cost +
        capex +
        target * cost * 2 +
        (design < 1 ? 6 * (w.wage_index[this.rdOccFor(p, g)] ?? 3000) * S : 0)
      const f = newFirm(w, firmName(rng, gid, cat), rid, gid, pid, owner)
      f.price = mkt * 0.97
      f.demand_ema = design >= 1 ? target : 0
      f.design = design
      f.last = { target_qty: target }
      f.state_backed = state
      if (owner === "foreign") {
        f.gen = Math.max(0, physical.worldGeneration(w, cat, gid) - 1)
        f.cash = seedCash
        this.ledger("row", this.faccount(f), "FDI", seedCash)
        ctx.addStat("fdi", seedCash)
      } else if (owner === "state") {
        f.cash = seedCash
        w.gov.cash -= seedCash
        addR(ctx.gov_spend, "industrial policy", seedCash)
        this.ledger("gov", this.faccount(f), "state investment", seedCash)
      } else {
        const equity = this.raiseEquity(seedCash * 0.35)
        const loan = seedCash - equity
        if (!this.bankCanLend(loan)) {
          w.firms.delete(f.id)
          continue
        }
        f.cash = equity
        this.ledger("hh", this.faccount(f), "equity", equity)
        this.lend(f, loan, "startup loan")
      }
      f.cash -= pol.business_entry_cost
      w.gov.cash += pol.business_entry_cost
      addR(ctx.gov_rev, "fees", pol.business_entry_cost)
      this.ledger(this.faccount(f), "gov", "registration fee", pol.business_entry_cost)
      if (design >= 1) this.initialEquipment(f)
      created += 1
      const how = { foreign: "Foreign investor", state: "State-backed", private: "Entrepreneurs" }[
        owner
      ]
      const extra = design >= 1 ? "" : " It must first develop the product (R&D)."
      addEvent(
        w,
        "entry",
        `${how} founded ${f.name} in ${r.name} to make ${g.name} ` +
          `(import price ${fmtG4(mkt)} vs est. cost ${fmtG4(cost)}).${extra}`,
        { firm: f.id, good: gid },
      )
      ctx.addStat("entries", 1)
    }
  }

  /** Wealthy households put savings into a new venture. */
  private raiseEquity(amount: number): number {
    const w = this.w
    const S = w.scale
    const rich = [...w.persons.values()]
      .filter((p) => p.age >= 18 * 12)
      .toSorted((a, b) => b.savings - a.savings)
      .slice(0, 50)
    const tot = sum(rich.map((p) => p.savings)) * S
    const take = Math.min(amount, 0.2 * tot)
    if (take <= 0) return 0
    for (const p of rich) p.savings -= (take * ((p.savings * S) / tot)) / S
    return take
  }

  // ------------------------------------------------- infrastructure, housing
  private infrastructure(ctx: Ctx) {
    const w = this.w
    const pol = w.policy
    const split = pol.infrastructure_split
    const ts = sum(Object.values(split).map((v) => Math.max(0, v))) || 1
    const bought = ctx.gov_bought.get("infrastructure_works") ?? new Map<number, number>()
    const price = w.prices.infrastructure_works ?? 1000
    for (const r of w.regions) {
      const val = ((bought.get(r.id) ?? 0) * price) / Math.max(w.price_index, 1e-6)
      for (const k of Object.keys(r.infra)) {
        let q = r.infra[k] * 0.9988
        let share = Math.max(0, split[k] ?? 0) / ts
        if (k === "port" && !r.port) share = 0
        if (share > 0 && val > 0) {
          let K: number
          if (k === "road" || k === "rail") K = INFRA_K[k] * r.area
          else if (k === "port") K = INFRA_K[k]
          else if (k === "irrigation") K = INFRA_K[k] * (r.land.land_crop ?? 1)
          else if (k === "transit") K = INFRA_K[k] * Math.max(r.urban_pop * w.scale, 1e4)
          else K = (INFRA_K[k] ?? 1000) * Math.max(r.pop * w.scale, 1e4)
          q += ((val * share) / K) * (1 - q)
        }
        r.infra[k] = Math.max(0, Math.min(1, q))
      }
      let dw = 0
      let rent: number | null = null
      for (const f of w.firms.values()) {
        if (f.good === "housing" && f.region === r.id) {
          dw += f.equip.dwelling ?? 0
          rent ??= f.price
        }
      }
      r.dwellings = dw
      r.rent = rent ?? w.prices.housing ?? 1000
    }
    // education & health service levels from what the state actually bought
    const seats: Record<number, number> = {}
    const useats: Record<number, number> = {}
    const qual: Record<number, number> = {}
    for (const r of w.regions) {
      seats[r.id] = (ctx.gov_bought.get("public_education")?.get(r.id) ?? 0) * 12
      useats[r.id] = (ctx.gov_bought.get("public_university")?.get(r.id) ?? 0) * 12
    }
    const teachSkill = new Map<number, number[]>()
    for (const f of w.firms.values()) {
      if (f.good !== "public_education") continue
      for (const pid of f.staff.keys()) {
        const p = w.persons.get(pid)
        if (!p) continue
        const l = teachSkill.get(f.region) ?? []
        l.push(p.occ !== null ? (p.skill[p.occ] ?? 0.3) : 0.3)
        teachSkill.set(f.region, l)
      }
    }
    const students = new Map<number, number>()
    for (const p of w.persons.values()) if (p.school === "school") add(students, p.region, 1)
    for (const r of w.regions) {
      const ratio = seats[r.id] / Math.max(1, (students.get(r.id) ?? 0) * w.scale)
      const tsk = teachSkill.get(r.id)
      const skills = tsk?.length ? tsk : [0.3]
      qual[r.id] = Math.min(1.3, ratio) * (0.5 + sum(skills) / skills.length)
    }
    w.stats.school_seats = seats
    w.stats.uni_seats = useats
    w.stats.school_quality = qual
    const pop = sum(w.regions.map((r) => r.pop)) * w.scale
    let healthVal =
      sum((ctx.gov_bought.get("public_health") ?? new Map<number, number>()).values()) *
      (w.prices.public_health ?? 1000)
    for (const gid of [
      "private_healthcare",
      "dental_care",
      "generic_medicines",
      "antibiotics",
      "vaccines",
      "biologic_drugs",
      "insulin",
    ])
      healthVal += ctx.flows.get(gid)?.hh_value ?? 0
    const hpc = healthVal / Math.max(pop, 1) / Math.max(w.price_index, 1e-6)
    w.stats.health_pc = hpc
    w.stats.health_access = Math.min(1, hpc / 180) ** 0.6
  }

  // -------------------------------------------------------------- external
  private external(ctx: Ctx) {
    const w = this.w
    const X = ctx.stat("exports")
    const M = ctx.stat("imports")
    const div = ctx.stat("foreign_dividends")
    const fdi = ctx.stat("fdi")
    const ca = X - M - div
    const gdp = Math.max(w.stats.gdp_trailing ?? w.stats.gdp_month ?? 1e8, 1)
    // imports drain domestic money abroad; exports bring it in
    w.stats.row_balance = (w.stats.row_balance ?? 0) + ca + fdi
    const ema = (w.stats.ca_ema ?? 0) * 0.9 + (0.1 * (ca + fdi)) / gdp
    w.stats.ca_ema = ema
    const infl = w.stats.inflation ?? 0.02
    // deficits, inflation above the world's and low interest rates weaken the currency
    let change = -0.03 * ema + (infl - 0.02) / 12 + (0.25 * (0.03 - w.policy_rate)) / 12
    change = Math.max(-0.025, Math.min(0.025, change))
    w.fx *= Math.exp(change)
    ctx.stats.current_account = ca
  }

  // --------------------------------------------------------------- metrics
  private metrics(ctx: Ctx): Metrics {
    const w = this.w
    const cat = this.cat
    const S = w.scale
    const st = w.stats
    const pol = w.policy
    const persons = [...w.persons.values()]
    const pop = persons.length * S
    const ret = pol.retirement_age * 12
    // labor
    let lf = 0
    let emp = 0
    const wages: [number, number][] = []
    const occEmp: Record<string, number> = {}
    const occWage: Record<string, number> = {}
    for (const p of persons) {
      if (p.school || p.age < 15 * 12 || p.age >= ret || p.occ === null || p.inactive) continue
      lf += 1
      emp += personFte(p)
      for (const [fte, wage] of p.jobs.values()) {
        wages.push([wage, fte])
        addR(occEmp, p.occ, fte)
        addR(occWage, p.occ, fte * wage)
      }
    }
    const unemp = lf ? 1 - emp / lf : 0
    wages.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const tw = sum(wages.map((x) => x[1]))
    let acc = 0
    let med = st.median_wage ?? 1000
    for (const [wg, fte] of wages) {
      acc += fte
      if (acc >= tw / 2) {
        med = wg
        break
      }
    }
    const avgWage = tw ? sum(wages.map(([wg, f]) => wg * f)) / tw : (st.avg_wage ?? 1000)
    st.median_wage = med
    st.avg_wage = avgWage
    st.unemployment = unemp
    // expenditure GDP
    let C = 0
    let I = 0
    for (const fl of ctx.flows.values()) {
      C += fl.hh_value ?? 0
      I += fl.inv_value ?? 0
    }
    let G = 0
    for (const [k, v] of Object.entries(ctx.gov_spend)) if (k in cat.goods) G += v
    const X = ctx.stat("exports")
    const M = ctx.stat("imports")
    let dinv = 0
    for (const f of w.firms.values()) {
      const fs = ctx.fs.get(f.id)
      if (fs && !cat.goods[f.good].svc) dinv += (fs.net - fs.sold) * f.price
    }
    const gdp = Math.max(C + G + I + dinv + X - M, 1)
    // wages respond to slack in each occupation (an occupational Phillips curve) on top of
    // expected inflation; existing contracts follow slowly
    const occLf: Record<string, number> = {}
    for (const p of persons)
      if (p.occ && !p.school && !p.inactive && p.age >= 15 * 12 && p.age < ret)
        addR(occLf, p.occ, 1)
    const vac = st.vacancies_by_occ ?? {}
    const expInfl = Math.max(-0.02, Math.min(0.15, st.inflation ?? 0.02)) / 12
    // wages also track the trend in labor productivity (real output per worker)
    const rva = gdp / Math.max(w.price_index, 1e-9) / Math.max(emp, 1e-9)
    const prev = st.rva_trend ?? rva
    st.rva_trend = 0.98 * prev + 0.02 * rva
    const occs = Object.values(cat.occupations)
    const refAvg = sum(occs.map((oc) => oc.ref_wage)) / occs.length
    const wiVals = Object.values(w.wage_index)
    const meanIdx = sum(wiVals) / Math.max(wiVals.length, 1)
    for (const o of Object.keys(cat.occupations)) {
      const lfo = occLf[o] ?? 0
      if (lfo <= 0) continue
      const uO = 1 - (occEmp[o] ?? 0) / lfo
      const vO = Math.min(0.3, (vac[o] ?? 0) / Math.max(lfo, 3))
      let chg = 0.7 * expInfl + 0.015 * (vO - uO + 0.07)
      chg = Math.max(-0.012, Math.min(0.012, chg))
      const wi = (w.wage_index[o] ?? 1000) * (1 + chg)
      // scarce skills earn premiums, but substitution, training and immigration keep the wage
      // structure within a band of the world's
      const rel = (cat.occupations[o].ref_wage / refAvg) * meanIdx
      w.wage_index[o] = Math.max(0.5 * rel, Math.min(2 * rel, wi))
    }
    for (const p of persons) {
      for (const job of p.jobs.values()) {
        const tgt =
          (p.occ !== null ? (w.wage_index[p.occ] ?? job[1]) : job[1]) *
          (0.85 + 0.3 * (p.occ !== null ? (p.skill[p.occ] ?? 0.5) : 0.5))
        const d = tgt - job[1]
        job[1] += d * (d > 0 ? 0.04 : 0.015)
      }
    }
    // CPI from the household basket (chained)
    const basket: Record<string, number> = {}
    const pricesNow: Record<string, number> = {}
    for (const [gid, fl] of ctx.flows) {
      const q = fl.hh_qty ?? 0
      if (q > 0) {
        basket[gid] = q
        pricesNow[gid] = (fl.hh_value ?? 0) / Math.max(q, 1e-12)
      }
    }
    const prevBasket = st.basket ?? {}
    const prevPrices = st.basket_prices ?? {}
    let num = 0
    let den = 0
    for (const [gid, q] of Object.entries(prevBasket)) {
      if (gid in pricesNow && gid in prevPrices) {
        num += q * pricesNow[gid]
        den += q * prevPrices[gid]
      }
    }
    if (den > 0) w.price_index *= Math.max(0.9, Math.min(1.1, num / den))
    st.basket = basket
    st.basket_prices = { ...prevPrices, ...pricesNow }
    const hist = (st.cpi_hist ??= [])
    hist.push(w.price_index)
    if (hist.length > 13) hist.shift()
    const infl =
      hist.length > 1 ? (hist[hist.length - 1] / hist[0]) ** (12 / (hist.length - 1)) - 1 : 0
    st.inflation = hist.length > 3 ? 0.7 * (st.inflation ?? infl) + 0.3 * infl : 0.02
    const gh = (st.gdp_hist ??= [])
    gh.push(gdp)
    if (gh.length > 12) gh.shift()
    st.gdp_month = gdp
    st.gdp_trailing = sum(gh) / gh.length
    st.gdp_trend = 0.97 * (st.gdp_trend ?? st.gdp_trailing) + 0.03 * st.gdp_trailing
    const realGdp = gdp / w.price_index
    const rg = (st.rgdp_hist ??= [])
    rg.push(realGdp)
    if (rg.length > 24) rg.shift()
    const growth = rg.length >= 24 ? sum(rg.slice(-12)) / sum(rg.slice(0, 12)) - 1 : 0
    const consPc = C / Math.max(pop, 1) / w.price_index
    st.cons_pc_real = 0.9 * (st.cons_pc_real ?? consPc) + 0.1 * consPc
    // people
    let nUrban = 0
    for (const p of persons) if (p.urban) nUrban++
    const urban = nUrban / Math.max(persons.length, 1)
    const adults = persons.filter((p) => p.age >= 25 * 12)
    st.urbanization = urban
    st.avg_school_years = sum(adults.map((p) => p.school_years)) / Math.max(adults.length, 1)
    const hiEdu = adults.filter((p) => p.edu >= 4).length / Math.max(adults.length, 1)
    st.absorptive = Math.min(1, 0.15 + hiEdu * 2.5)
    let ref = 0
    let act = 0
    for (const o of Object.keys(occEmp)) {
      ref += cat.occupations[o].ref_wage * HOURS * occEmp[o]
      act += occWage[o]
    }
    st.wage_level_vs_world = act / Math.max(ref, 1) / Math.max(w.fx, 1e-9)
    const incomes = persons
      .filter((p) => p.age >= 18 * 12)
      .map((p) => p.income_last)
      .toSorted((a, b) => a - b)
    let gini = 0
    if (incomes.length) {
      const n = incomes.length
      const tot = sum(incomes)
      if (tot > 0) {
        let cum = 0
        incomes.forEach((x, i) => {
          cum += (i + 1) * x
        })
        gini = (2 * cum) / (n * tot) - (n + 1) / n
      }
    }
    const poverty = incomes.filter((x) => x < 0.4 * med).length / Math.max(incomes.length, 1)
    const wealth = persons
      .filter((p) => p.age >= 18 * 12)
      .map((p) => p.savings)
      .toSorted((a, b) => a - b)
    const top10w = sum(wealth.slice(Math.trunc(wealth.length * 0.9))) / Math.max(sum(wealth), 1)
    const eduCounts = [0, 0, 0, 0, 0, 0]
    for (const p of adults) eduCounts[p.edu] += 1
    // life expectancy at birth from current death risks (rough period table)
    const health = st.health_access ?? 0.5
    let le = 0
    let surv = 1
    for (let a = 0; a < 110; a++) {
      const m = demography.annualMortality(a + 0.5, health)
      le += surv * (1 - m / 2)
      surv *= 1 - m
    }
    // regions
    const reg: Record<number, RegionStat> = {}
    for (const r of w.regions) {
      const rp = persons.filter((p) => p.region === r.id)
      const lfr = rp.filter(
        (p) => !p.school && p.age >= 15 * 12 && p.age < ret && p.occ !== null && !p.inactive,
      )
      const er = sum(lfr.map(personFte))
      const wr: number[] = []
      for (const p of rp) for (const j of p.jobs.values()) wr.push(j[1])
      reg[r.id] = {
        name: r.name,
        pop: rp.length * S,
        urban_pop: r.urban_pop * S,
        unemployment: lfr.length ? 1 - er / lfr.length : 0,
        avg_wage: wr.length ? sum(wr) / wr.length : avgWage,
        rent: r.rent,
        dwellings: r.dwellings,
        crowding: (rp.length * S) / Math.max(r.dwellings, 1),
        dwelling_cap: this.maxDwellings(r),
        productivity: r.productivity,
        infra: { ...r.infra },
        va: ctx.region_va.get(r.id) ?? 0,
        urban_km2: r.urban_km2,
      }
    }
    st.region = reg
    // government
    const rev = sum(Object.values(ctx.gov_rev))
    const spend = sum(Object.values(ctx.gov_spend))
    st.gov_rev_ema = 0.9 * (st.gov_rev_ema ?? rev) + 0.1 * rev
    const elecDem = ctx.flows.get("electricity") ?? {}
    const kn = Object.values(w.knowledge)
    const enroll = st.enroll_ratio
    const enrollVals = enroll ? Object.values(enroll) : []
    return {
      year: Math.round(yearOf(w) * 1000) / 1000,
      population: pop,
      gdp,
      real_gdp: realGdp,
      gdp_pc: gdp / Math.max(pop, 1),
      real_gdp_pc: realGdp / Math.max(pop, 1),
      growth,
      C,
      G,
      I,
      dInv: dinv,
      X,
      M,
      trade_balance: X - M,
      cpi: w.price_index,
      inflation: st.inflation,
      policy_rate: w.policy_rate,
      fx: w.fx,
      unemployment: unemp,
      labor_force: lf * S,
      employment: emp * S,
      avg_wage: avgWage,
      median_wage: med,
      real_avg_wage: avgWage / w.price_index,
      gini,
      poverty,
      top10_wealth: top10w,
      gov_revenue: rev,
      gov_spending: spend,
      gov_deficit: spend - rev,
      gov_debt: w.gov.debt,
      debt_gdp: w.gov.debt / Math.max(st.gdp_trailing * 12, 1),
      gov_rev_detail: { ...ctx.gov_rev },
      gov_spend_detail: { ...ctx.gov_spend },
      bank_loans: w.bank.loans,
      bank_equity: w.bank.equity,
      firms: w.firms.size,
      entries: ctx.stat("entries"),
      bankruptcies: ctx.stat("bankruptcies"),
      births: ctx.stat("births"),
      deaths: ctx.stat("deaths"),
      tfr: st.tfr ?? 2,
      life_expectancy: le,
      urbanization: urban,
      avg_school_years: st.avg_school_years,
      tertiary_share: hiEdu,
      edu_attainment: eduCounts.map((c) => c / Math.max(adults.length, 1)),
      enrollment: enrollVals.length ? sum(enrollVals) / enrollVals.length : null,
      health_pc: st.health_pc ?? 0,
      emissions: ctx.emissions,
      electricity: elecDem.dom_sold ?? 0,
      electricity_shortage: elecDem.shortage ?? 0,
      elec_mix: { ...ctx.elec_mix },
      knowledge_index: sum(kn) / kn.length,
      research_py: ctx.stat("research_py"),
      rd_py: ctx.stat("rd_py"),
      hires: ctx.stat("hires"),
      vacancies: ctx.stat("vacancies"),
      migrants: ctx.stat("migrants"),
      immigrants: ctx.stat("immigrants"),
      emigrants: ctx.stat("emigrants"),
      fdi: ctx.stat("fdi"),
      current_account: ctx.stat("current_account"),
      wage_level_vs_world: st.wage_level_vs_world,
      housing_rent: w.prices.housing ?? 0,
      crowding: pop / Math.max(sum(w.regions.map((r) => r.dwellings)), 1),
      sector_va: { ...ctx.sector_va },
      hh_need: ctx.hhNeed,
      occ_employment: Object.fromEntries(Object.entries(occEmp).map(([o, v]) => [o, v * S])),
      occ_wage: Object.fromEntries(
        Object.entries(occEmp)
          .filter(([, v]) => v > 0)
          .map(([o, v]) => [o, occWage[o] / v]),
      ),
      dividends: ctx.stat("dividends"),
      wage_bill: ctx.stat("wage_bill"),
      domestic_products: w.produced_ever.size,
      regions: reg,
    }
  }
}

export interface Metrics {
  year: number
  population: number
  gdp: number
  real_gdp: number
  gdp_pc: number
  real_gdp_pc: number
  growth: number
  C: number
  G: number
  I: number
  dInv: number
  X: number
  M: number
  trade_balance: number
  cpi: number
  inflation: number
  policy_rate: number
  fx: number
  unemployment: number
  labor_force: number
  employment: number
  avg_wage: number
  median_wage: number
  real_avg_wage: number
  gini: number
  poverty: number
  top10_wealth: number
  gov_revenue: number
  gov_spending: number
  gov_deficit: number
  gov_debt: number
  debt_gdp: number
  gov_rev_detail: Record<string, number>
  gov_spend_detail: Record<string, number>
  bank_loans: number
  bank_equity: number
  firms: number
  entries: number
  bankruptcies: number
  births: number
  deaths: number
  tfr: number
  life_expectancy: number
  urbanization: number
  avg_school_years: number
  tertiary_share: number
  edu_attainment: number[]
  enrollment: number | null
  health_pc: number
  emissions: number
  electricity: number
  electricity_shortage: number
  elec_mix: Record<string, number>
  knowledge_index: number
  research_py: number
  rd_py: number
  hires: number
  vacancies: number
  migrants: number
  immigrants: number
  emigrants: number
  fdi: number
  current_account: number
  wage_level_vs_world: number
  housing_rent: number
  crowding: number
  sector_va: Record<string, number>
  hh_need: Record<string, number>
  occ_employment: Record<string, number>
  occ_wage: Record<string, number>
  dividends: number
  wage_bill: number
  domestic_products: number
  regions: Record<number, RegionStat>
}
