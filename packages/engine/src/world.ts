/**
 * Simulation state and scenario generation.
 *
 * Agents: each Person represents `scale` real people of the same age, region, education and
 * occupation. Firms are representative firms producing one good with one process at a time.
 * Everything that matters for the next month lives in World as plain data (Maps, arrays,
 * records, the RNG state), so a structured clone of World is a complete snapshot (used for
 * rewind).
 */
import { type Catalog, eligible, engelShares, getCatalog } from "./catalog"
import * as physical from "./physical"
import { defaultPolicy, type Policy } from "./policy"
import { choice, gauss, pick, random, type RngState, seedRng, shuffle, uniform } from "./rng"

export const HOURS = 160
/** rest of world's market size relative to ours, per good */
export const WORLD_SCALE = 30

export interface Person {
  id: number
  /** months */
  age: number
  region: number
  edu: number
  field: string
  /** human capital from schooling 0..1 */
  h: number
  occ: string | null
  /** occupation -> 0..1 */
  skill: Record<string, number>
  /** firm id -> [fte, monthly wage per person] */
  jobs: Map<number, [number, number]>
  /** per person */
  savings: number
  school: string | null
  school_years: number
  guardian: number | null
  last_good: string | null
  urban: boolean
  unemp: number
  prev_wage: number
  immigrant: boolean
  income_last: number
  debt: number
  inactive: boolean
}

export interface FirmAccounts {
  revenue?: number
  wages?: number
  inputs?: number
  output?: number
  costs?: number
  exports?: number
  target_qty?: number
  util?: number
  va?: number
  [k: string]: number | undefined
}

export interface Firm {
  id: number
  name: string
  region: number
  good: string
  proc: string
  owner: "private" | "state" | "foreign"
  founded: number
  /** good id -> count (fractional allowed) */
  equip: Record<string, number>
  /** good id -> delivered precision (um) */
  eq_prec: Record<string, number>
  /** person id -> fte */
  staff: Map<number, number>
  cash: number
  debt: number
  inv: number
  inv_in: Record<string, number>
  price: number
  markup: number
  sales_ema: number
  demand_ema: number
  export_ema: number
  design: number
  cum_output: number
  gen: number
  quality: number
  rd_share: number
  rd_progress: number
  vacancies: Record<string, number>
  wage_offer: Record<string, number>
  distress: number
  alive: boolean
  /** equipment good -> qty to buy this month */
  orders: Record<string, number>
  cost_ema: number
  profit_ema: number
  util_ema: number
  last: FirmAccounts
  plan: number
  potential: number
  /** human-readable reason production is blocked */
  blocked: string | null
  subsidy_rate: number
  state_backed: boolean
}

export interface Deposit {
  qty: number
  qty0: number
  grade: number
  kind: "stock" | "renew" | "flow"
  regen: number
}

export interface Region {
  id: number
  name: string
  arch: string
  area: number
  urban_km2: number
  temp: number
  rain: number
  sun: number
  wind: number
  port: boolean
  deposits: Record<string, Deposit>
  land: Record<string, number>
  land_used: Record<string, number>
  infra: Record<string, number>
  dwellings: number
  rent: number
  pos: [number, number]
  pop: number
  urban_pop: number
  productivity: number
  suit: Record<string, number>
}

export interface Gov {
  cash: number
  debt: number
  revenue: Record<string, number>
  spending: Record<string, number>
  gdp_est: number
  students: Record<string, number>
  infra_stock: Record<string, number>
}

export interface Bank {
  loans: number
  bonds: number
  equity: number
  deposits: number
  reserves: number
}

export interface SimEvent {
  tick: number
  kind: string
  text: string
  data: Record<string, unknown>
}

export interface Stats {
  tfp_mult?: number
  wage_level?: number
  wage_level_vs_world?: number
  export_mult?: number
  absorb?: Record<string, number>
  seed_exports?: number
  seed_imports?: number
  seed_fte?: number
  seed_target_fte?: number
  seed_gdp?: number
  seed_scale?: number
  gdp_month?: number
  gdp_trailing?: number
  gdp_trend?: number
  cpi?: number
  avg_wage?: number
  median_wage?: number
  inflation?: number
  unemployment?: number
  lend_rate?: number
  dep_rate?: number
  budget?: Record<string, number>
  freight_mult?: number
  vacancies_by_occ?: Record<string, number>
  /** region id -> seats (student-years / yr) */
  school_seats?: Record<number, number>
  uni_seats?: Record<number, number>
  school_quality?: Record<number, number>
  enroll_ratio?: Record<number, number>
  uni_ratio?: Record<number, number>
  region?: Record<number, RegionStat>
  basket?: Record<string, number>
  basket_prices?: Record<string, number>
  cpi_hist?: number[]
  gdp_hist?: number[]
  rgdp_hist?: number[]
  shortage_ema?: Record<string, number>
  rva_trend?: number
  cons_pc_real?: number
  urbanization?: number
  avg_school_years?: number
  absorptive?: number
  gov_rev_ema?: number
  tfr?: number
  dropouts?: number
  immig_acc?: number
  row_balance?: number
  ca_ema?: number
  health_pc?: number
  health_access?: number
}

export interface RegionStat {
  name: string
  pop: number
  urban_pop: number
  unemployment: number
  avg_wage: number
  rent: number
  dwellings: number
  crowding: number
  dwelling_cap: number
  productivity: number
  infra: Record<string, number>
  va: number
  urban_km2: number
}

export interface Scenario {
  label: string
  desc: string
  year: number
  population: number
  agents: number
  knowledge_lag: number
  wage_mult: number
  edu: number[]
  infra: number
  fertility: number
  gov_debt: number
  domestic_share: number
  tfp: number
  participation: number
  crowding: number
  gen_lag: number
  savings_months: number
  regions: number
  burn_in: number
  id?: string
  seed?: number
  _housing_ref_price?: number
}

export interface World {
  tick: number
  start_year: number
  scale: number
  rng: RngState
  persons: Map<number, Person>
  firms: Map<number, Firm>
  regions: Region[]
  dist: number[][]
  knowledge: Record<string, number>
  /** progress on things nobody in the world knows yet */
  k_frontier: Record<string, number>
  policy: Policy
  gov: Gov
  bank: Bank
  fx: number
  /** domestic reference price per good (last avg) */
  prices: Record<string, number>
  price_index: number
  /** occupation -> average monthly wage per person */
  wage_index: Record<string, number>
  /** good -> imported qty, rolling */
  imports_12m: Record<string, number>
  produced_ever: Set<string>
  next_pid: number
  next_fid: number
  stats: Stats
  events: SimEvent[]
  scenario: Scenario
  policy_rate: number
}

export const yearOf = (w: World) => w.start_year + w.tick / 12
export const monthOf = (w: World) => w.tick % 12

export function newWorld(): World {
  return {
    tick: 0,
    start_year: 2025,
    scale: 500,
    rng: seedRng(1),
    persons: new Map(),
    firms: new Map(),
    regions: [],
    dist: [],
    knowledge: {},
    k_frontier: {},
    policy: defaultPolicy(),
    gov: { cash: 0, debt: 0, revenue: {}, spending: {}, gdp_est: 0, students: {}, infra_stock: {} },
    bank: { loans: 0, bonds: 0, equity: 0, deposits: 0, reserves: 0 },
    fx: 1,
    prices: {},
    price_index: 1,
    wage_index: {},
    imports_12m: {},
    produced_ever: new Set(),
    next_pid: 1,
    next_fid: 1,
    stats: {},
    events: [],
    scenario: SCENARIOS.emerging_2025,
    policy_rate: 0.04,
  }
}

export function newPerson(w: World, ageM: number, region: number): Person {
  const p: Person = {
    id: w.next_pid++,
    age: ageM,
    region,
    edu: 0,
    field: "general",
    h: 0.3,
    occ: null,
    skill: {},
    jobs: new Map(),
    savings: 0,
    school: null,
    school_years: 0,
    guardian: null,
    last_good: null,
    urban: true,
    unemp: 0,
    prev_wage: 0,
    immigrant: false,
    income_last: 0,
    debt: 0,
    inactive: false,
  }
  w.persons.set(p.id, p)
  return p
}

export function personFte(p: Person): number {
  let s = 0
  for (const j of p.jobs.values()) s += j[0]
  return s
}

export function newFirm(
  w: World,
  name: string,
  region: number,
  good: string,
  proc: string,
  owner: Firm["owner"] = "private",
): Firm {
  const f: Firm = {
    id: w.next_fid++,
    name,
    region,
    good,
    proc,
    owner,
    founded: w.tick,
    equip: {},
    eq_prec: {},
    staff: new Map(),
    cash: 0,
    debt: 0,
    inv: 0,
    inv_in: {},
    price: 0,
    markup: 0.15,
    sales_ema: 0,
    demand_ema: 0,
    export_ema: 0,
    design: 1,
    cum_output: 0,
    gen: 0,
    quality: 1,
    rd_share: 0,
    rd_progress: 0,
    vacancies: {},
    wage_offer: {},
    distress: 0,
    alive: true,
    orders: {},
    cost_ema: 0,
    profit_ema: 0,
    util_ema: 0.8,
    last: {},
    plan: 0,
    potential: 0,
    blocked: null,
    subsidy_rate: 0,
    state_backed: false,
  }
  w.firms.set(f.id, f)
  return f
}

export function addEvent(w: World, kind: string, text: string, data: Record<string, unknown> = {}) {
  w.events.push({ tick: w.tick, kind, text, data })
}

// ======================================================================== scenarios

export const SCENARIOS: Record<string, Scenario> = {
  emerging_2025: {
    label: "Emerging economy, 2025",
    desc:
      "A middle-income country: decent schooling, cheap labor, patchy infrastructure, " +
      "imports most high-tech goods and machinery.",
    year: 2025,
    population: 3_000_000,
    agents: 5000,
    knowledge_lag: 18,
    wage_mult: 0.3,
    edu: [0.05, 0.22, 0.43, 0.13, 0.14, 0.03],
    infra: 0.45,
    fertility: 2.3,
    gov_debt: 0.5,
    domestic_share: 0.65,
    tfp: 0.5,
    participation: 0.62,
    crowding: 3.6,
    gen_lag: 2,
    savings_months: 4,
    regions: 6,
    burn_in: 36,
  },
  advanced_2025: {
    label: "Advanced economy, 2025",
    desc: "A rich, highly educated country with dense infrastructure and an aging population.",
    year: 2025,
    population: 3_000_000,
    agents: 5000,
    knowledge_lag: 0,
    wage_mult: 1.0,
    edu: [0.0, 0.05, 0.37, 0.18, 0.3, 0.1],
    infra: 0.85,
    fertility: 1.6,
    gov_debt: 0.9,
    domestic_share: 0.6,
    tfp: 1.0,
    participation: 0.8,
    crowding: 2.3,
    gen_lag: 0,
    savings_months: 10,
    regions: 6,
    burn_in: 36,
  },
  industrializing_1950: {
    label: "Industrializing country, 1950",
    desc: "Mostly rural, low literacy; railways and electricity exist but factories are few.",
    year: 1950,
    population: 3_000_000,
    agents: 5000,
    knowledge_lag: 25,
    wage_mult: 0.1,
    edu: [0.35, 0.4, 0.18, 0.04, 0.025, 0.005],
    infra: 0.2,
    fertility: 5.5,
    gov_debt: 0.2,
    domestic_share: 0.75,
    tfp: 0.4,
    participation: 0.62,
    crowding: 4.8,
    gen_lag: 3,
    savings_months: 2,
    regions: 6,
    burn_in: 72,
  },
  agrarian_1850: {
    label: "Agrarian society, 1850",
    desc:
      "Pre-industrial: farms, craftsmen, sailing ships, a few steam engines. " +
      "Nothing modern can be made - or bought - until it is invented.",
    year: 1850,
    population: 2_000_000,
    agents: 4000,
    knowledge_lag: 10,
    wage_mult: 0.05,
    edu: [0.6, 0.3, 0.08, 0.015, 0.004, 0.001],
    infra: 0.08,
    fertility: 5.8,
    gov_debt: 0.1,
    domestic_share: 0.85,
    tfp: 0.35,
    participation: 0.6,
    crowding: 5.5,
    gen_lag: 1,
    savings_months: 2,
    regions: 5,
    burn_in: 72,
  },
}

const FIRM_PREFIX = [
  "Allied",
  "United",
  "Northern",
  "Pioneer",
  "Summit",
  "Vanguard",
  "Crescent",
  "Keystone",
  "Meridian",
  "Atlas",
  "Beacon",
  "Granite",
  "Liberty",
  "Harbor",
  "Evergreen",
  "Sterling",
  "Apex",
  "Union",
  "Frontier",
  "Cardinal",
  "Riverside",
  "Golden",
  "Prairie",
  "Orion",
  "Phoenix",
  "Royal",
  "Sovereign",
  "Titan",
]
const FIRM_SUFFIX: Record<string, string> = {
  resource: "Mining",
  agri: "Farms",
  food: "Foods",
  textile: "Textiles",
  apparel: "Apparel",
  wood: "Timber",
  paper: "Paper",
  media: "Press",
  energy: "Energy",
  chem: "Chemicals",
  mineral: "Materials",
  metal: "Metals",
  semis: "Semiconductor",
  component: "Components",
  electrical: "Electric",
  electronics: "Electronics",
  capital: "Machinery",
  building: "Construction",
  consumer: "Products",
  personal: "Cosmetics",
  toys: "Toys",
  pharma: "Pharma",
  health: "Medical",
  service: "Services",
  public: "Public",
  software: "Software",
}

export function firmName(rng: RngState, good: string, cat: Catalog): string {
  const g = cat.goods[good]
  if (g.cat === "public") return `Public ${g.name.split("(")[0].trim()}`
  if (good === "housing") return "Residential Properties"
  return `${choice(rng, FIRM_PREFIX)} ${FIRM_SUFFIX[g.cat] ?? "Industries"}`
}

export function generate(
  scenarioId = "emerging_2025",
  seed = 1,
  overrides: Partial<Scenario> = {},
): World {
  const cat = getCatalog()
  const sc: Scenario = { ...SCENARIOS[scenarioId], ...overrides }
  const rng = seedRng(seed)
  const w = newWorld()
  w.rng = seedRng(seed * 7919 + 13)
  w.scenario = { ...sc, id: scenarioId, seed }
  w.start_year = sc.year
  w.scale = sc.population / sc.agents
  w.policy = defaultPolicy()
  w.stats.tfp_mult = sc.tfp
  w.stats.wage_level = sc.wage_mult

  genRegions(w, cat, rng, sc)
  genKnowledge(w, cat, sc)
  genPopulation(w, cat, rng, sc)
  genEconomy(w, cat, rng, sc)
  addEvent(
    w,
    "info",
    `Simulation started: ${sc.label} (${sc.year}). ${sc.population.toLocaleString("en-US")} people in ` +
      `${w.regions.length} regions; ${w.firms.size} firms.`,
  )
  return w
}

// --------------------------------------------------------------------- regions
function genRegions(w: World, cat: Catalog, rng: RngState, sc: Scenario) {
  const archs = Object.keys(cat.archetypes)
  const n = sc.regions
  const pool = shuffle(
    rng,
    archs.filter((a) => a !== "coastal_plain"),
  )
  const chosen = ["coastal_plain", ...pool.slice(0, n - 1)] // at least one port
  const names = shuffle(rng, [...cat.regionNames])
  const lvl = sc.infra
  chosen.forEach((a, i) => {
    const A = cat.archetypes[a]
    const area = uniform(rng, 8000, 30000)
    const urbanKm2 = area * uniform(rng, 0.004, 0.012) * (0.4 + lvl)
    const temp = A.temp + uniform(rng, -3, 3)
    const rain = A.rain * uniform(rng, 0.75, 1.25)
    const sun = A.sun * uniform(rng, 0.9, 1.1)
    const wind = A.wind * uniform(rng, 0.8, 1.2)
    const px = Math.cos((2 * Math.PI * i) / n) * 300 + uniform(rng, -60, 60)
    const py = Math.sin((2 * Math.PI * i) / n) * 220 + uniform(rng, -50, 50)
    const r: Region = {
      id: i,
      name: names[i],
      arch: a,
      area,
      urban_km2: urbanKm2,
      temp,
      rain,
      sun,
      wind,
      port: A.port,
      deposits: {},
      land: {
        land_crop: area * 100 * A.crop_frac,
        land_pasture: area * 100 * A.pasture_frac,
        forest_land: area * 100 * A.forest_frac,
      },
      land_used: { land_crop: 0, land_pasture: 0, forest_land: 0 },
      infra: {},
      dwellings: 0,
      rent: 0,
      pos: [px, py],
      pop: 0,
      urban_pop: 0,
      productivity: 1,
      suit: {},
    }
    // geology
    for (const [dep, D] of Object.entries(cat.deposits)) {
      const geoOk = D.geo.includes("*") || D.geo.some((gg) => A.geo.includes(gg))
      let p = geoOk ? 0.75 : 0.06
      if (D.kind === "flow" && (dep === "solar" || dep === "water")) p = 1
      if (random(rng) < p) {
        let size = D.rich * Math.exp(gauss(rng, -0.4, 0.9))
        let grade = Math.min(1.3, Math.max(0.25, gauss(rng, 0.8, 0.25)))
        if (dep === "solar") {
          grade = r.sun
          size = D.rich * (r.area / 15000)
        } else if (dep === "wind") grade = r.wind
        else if (dep === "fish_stock" && !r.port) continue
        else if (dep === "forest") size = r.land.forest_land * 150 // t of standing timber
        r.deposits[dep] = { qty: size, qty0: size, grade, kind: D.kind, regen: D.regen ?? 0 }
      }
    }
    // crop/livestock suitability from climate
    for (const [crop, [tOpt, tTol, rOpt, rTol]] of Object.entries(cat.crops)) {
      const st = Math.exp(-(((r.temp - tOpt) / tTol) ** 2))
      const sr = Math.exp(-(((r.rain - rOpt) / rTol) ** 2))
      r.suit[crop] = 0.15 + 0.85 * st * sr
    }
    r.infra = {
      road: lvl * uniform(rng, 0.8, 1.1),
      rail: lvl * uniform(rng, 0.4, 1.0),
      port: r.port ? lvl : 0,
      grid: lvl * uniform(rng, 0.8, 1.1),
      broadband: Math.max(0, lvl - 0.1) * uniform(rng, 0.7, 1.1),
      transit: lvl * uniform(rng, 0.5, 1.0),
      irrigation: lvl * 0.5,
    }
    for (const k of Object.keys(r.infra)) r.infra[k] = Math.max(0, Math.min(1, r.infra[k]))
    w.regions.push(r)
  })
  // distances (km)
  const m = w.regions.length
  w.dist = Array.from({ length: m }, (_, i) =>
    Array.from({ length: m }, (_, j) => {
      if (i === j) return 40
      const a = w.regions[i].pos
      const b = w.regions[j].pos
      return Math.hypot(a[0] - b[0], a[1] - b[1]) * 1.3 + 30
    }),
  )
}

// ------------------------------------------------------------------- knowledge
function genKnowledge(w: World, cat: Catalog, sc: Scenario) {
  const year = sc.year
  const lag = sc.knowledge_lag
  for (const k of Object.keys(cat.knowledge)) {
    const ky = cat.kyear[k]
    let lvl: number
    if (ky <= year - lag) lvl = 1
    else if (ky <= year) lvl = Math.max(0, 0.85 * (1 - (ky - (year - lag)) / Math.max(lag, 1)))
    else lvl = 0
    w.knowledge[k] = lvl
  }
  // prerequisites cap understanding
  for (let i = 0; i < 5; i++) {
    for (const [k, node] of Object.entries(cat.knowledge)) {
      if (node.prereqs.length) {
        const cap = Math.min(...node.prereqs.map((p) => w.knowledge[p]))
        w.knowledge[k] = Math.min(w.knowledge[k], cap + 0.15)
      }
    }
  }
}

// ------------------------------------------------------------------ population
/** Sample an age (years) from a stable population with growth implied by fertility. */
function agePyramid(rng: RngState, fertility: number): number {
  const growth = 0.012 * (fertility - 2)
  const dens = (a: number) => Math.exp(-growth * a) * Math.exp(-((a / 82) ** 6))
  let top = 0
  for (let a = 0; a < 96; a += 5) top = Math.max(top, dens(a))
  for (;;) {
    const a = uniform(rng, 0, 95)
    if (random(rng) * top < dens(a)) return a
  }
}

function genPopulation(w: World, cat: Catalog, rng: RngState, sc: Scenario) {
  const n = sc.agents
  let weights = w.regions.map((r) => {
    const A = cat.archetypes[r.arch]
    return (A.crop_frac + 0.3) * (r.port ? 1.6 : 1) * uniform(rng, 0.6, 1.4)
  })
  const tot = weights.reduce((a, b) => a + b, 0)
  weights = weights.map((x) => x / tot)
  const regionIdx = w.regions.map((_, i) => i)
  const eduDist = sc.edu
  const fieldEntries = Object.entries(cat.fields)
  const fields4 = fieldEntries.filter(([, [lvl]]) => lvl >= 4).map(([f]) => f)
  const fields3 = fieldEntries.filter(([, [lvl]]) => lvl === 3).map(([f]) => f)
  for (let i = 0; i < n; i++) {
    const reg = pick(rng, regionIdx, weights)
    const ageY = agePyramid(rng, sc.fertility)
    const p = newPerson(w, Math.trunc(ageY * 12), reg)
    if (ageY >= 22) {
      // older cohorts are less educated (history of expanding schooling)
      const shift = Math.max(0, (ageY - 30) / 60)
      const d = [
        eduDist[0] + shift * 0.3,
        eduDist[1] + shift * 0.1,
        ...eduDist.slice(2).map((x) => x * (1 - shift * 0.5)),
      ]
      p.edu = pick(rng, [0, 1, 2, 3, 4, 5], d)
      p.school_years = [0, 6, 12, 14, 16, 18][p.edu]
      p.field = p.edu >= 4 ? choice(rng, fields4) : p.edu === 3 ? choice(rng, fields3) : "general"
      p.h = Math.min(
        1,
        0.2 + 0.06 * p.school_years * (0.6 + 0.4 * sc.infra) + uniform(rng, -0.1, 0.1),
      )
    } else if (ageY >= 6) {
      const yrs = Math.trunc(ageY - 6)
      p.school = "school"
      p.school_years = Math.min(yrs, 12)
      p.edu = p.school_years >= 6 ? 1 : 0
      if (p.school_years >= 12) p.edu = 2
      p.h = Math.min(1, 0.15 + 0.05 * p.school_years)
      if (ageY >= 18) p.school = null
    }
    p.savings = 0
  }
  // guardians for children
  const byRegion = new Map<number, number[]>()
  for (const p of w.persons.values()) {
    if (p.age >= 25 * 12 && p.age <= 55 * 12) {
      const l = byRegion.get(p.region) ?? []
      l.push(p.id)
      byRegion.set(p.region, l)
    }
  }
  for (const p of w.persons.values()) {
    if (p.age < 18 * 12) {
      let lst = byRegion.get(p.region)
      if (!lst?.length) lst = [...byRegion.values()].flat()
      p.guardian = choice(rng, lst)
    }
  }
}

// -------------------------------------------------------------------- economy
type Feasible = Map<string, [pid: string, cost: number, regs: number[]]>

const cheapest = (alts: string[], price: (a: string) => number) => {
  let best = alts[0]
  let bp = price(best)
  for (const a of alts.slice(1)) {
    const v = price(a)
    if (v < bp) {
      best = a
      bp = v
    }
  }
  return best
}

const isAdultWorker = (p: Person) => p.age >= 18 * 12 && p.age < 65 * 12 && p.school === null

function genEconomy(w: World, cat: Catalog, rng: RngState, sc: Scenario) {
  const year = sc.year
  const S = w.scale
  const wm = sc.wage_mult
  w.fx = 1
  // reference prices: world price where it exists, else catalog price
  for (const [gid, g] of Object.entries(cat.goods)) {
    const wp = cat.worldPrice(gid, year)
    w.prices[gid] = wp || g.price * 4
  }
  for (const [o, occ] of Object.entries(cat.occupations))
    w.wage_index[o] = occ.ref_wage * HOURS * wm
  // domestic production feasibility at start
  const feasible: Feasible = new Map()
  for (const [gid, g] of Object.entries(cat.goods)) {
    if (g.endowment) continue
    let best: [string, number, number[]] | null = null
    for (const pid of g.processes) {
      const p = cat.procs[pid]
      if (p.year > year) continue
      if (!p.know.every((k) => (w.knowledge[k] ?? 0) >= 0.65)) continue
      const regs = physical.regionsForProcess(w, cat, p)
      if (!regs.length) continue
      // equipment must exist somewhere (world sells it, or it's a building)
      const eq = p.equip ? p.equip[0] : null
      if (eq !== null && !(eq in cat.endowments) && cat.goods[eq].year > year) continue
      const cost = physical.refUnitCost(w, cat, p, wm)
      if (best === null || cost < best[1]) best = [pid, cost, regs]
    }
    if (best) feasible.set(gid, best)
  }
  const pop = sc.population
  const pol = w.policy
  const domShare: Record<string, number> = {}
  for (const [gid, g] of Object.entries(cat.goods)) {
    if (!feasible.has(gid)) domShare[gid] = 0
    else if (g.nt || g.local || g.svc) domShare[gid] = 1
    else if (g.cat === "resource" || g.cat === "agri")
      domShare[gid] = Math.min(1, sc.domestic_share * 1.5)
    else domShare[gid] = sc.domestic_share
  }
  // export potential of tradables we can make cheaper than the world
  const comp = new Map<string, number>()
  for (const [gid, [pid]] of feasible) {
    const g = cat.goods[gid]
    if (g.nt || g.local || g.capital) continue
    const c = physical.refUnitCost(w, cat, cat.procs[pid], wm, sc.tfp)
    comp.set(gid, (w.prices[gid] * 0.92) / Math.max(c * 1.12 + (g.kg / 1000) * 60, 1e-9))
  }
  // ---- fixed point: production <-> incomes <-> demand, with exports calibrated so that
  // seeded employment matches the participating labor force
  let nAdults = 0
  let elderly = 0
  let kids = 0
  for (const p of w.persons.values()) {
    if (isAdultWorker(p)) nAdults++
    if (p.age >= 65 * 12) elderly++
    if (p.age < 18 * 12) kids++
  }
  const targetFte = nAdults * sc.participation * 0.93
  let gdp = pop * 2500 * wm ** 0.75 * 0.6
  let cons = gdp * 0.6
  let xMult = 1
  let plan = planEconomy(w, cat, sc, feasible, domShare, comp, cons, gdp, xMult)
  for (let it = 0; it < 14; it++) {
    plan = planEconomy(w, cat, sc, feasible, domShare, comp, cons, gdp, xMult)
    const need = plan.fte
    const avgW = plan.avg_wage
    const unemployed = Math.max(0, nAdults * sc.participation - need) * S
    const transfers =
      elderly * S * pol.pension_rate * avgW +
      unemployed * 0.4 * avgW * 0.8 +
      kids * S * pol.child_benefit * avgW
    const div = 0.5 * Math.max(0, plan.va - plan.wages) * 0.6
    const disp = plan.wages * 0.9 + transfers + div
    cons = 0.5 * cons + (0.5 * 0.92 * disp) / (1 + pol.vat)
    gdp = 0.5 * gdp + 0.5 * plan.va * 1.08
    if (it >= 3) {
      xMult *= Math.max(0.5, Math.min(2, (targetFte / Math.max(need, 1e-9)) ** 1.5))
      xMult = Math.max(0.05, Math.min(20, xMult))
    }
  }
  const { total, exports } = plan
  w.stats.export_mult = xMult
  const absorb: Record<string, number> = {}
  for (const [gid, v] of total) absorb[gid] = v / Math.max(w.prices[gid], 1e-9)
  w.stats.absorb = absorb
  w.stats.seed_exports = [...exports.values()].reduce((a, b) => a + b, 0)
  let seedImp = 0
  for (const [gid, v] of total) seedImp += v * (1 - (domShare[gid] ?? 0))
  w.stats.seed_imports = seedImp
  w.stats.seed_fte = plan.fte
  w.stats.seed_target_fte = targetFte
  w.stats.seed_gdp = gdp
  const gdpMonth = gdp
  w.scenario._housing_ref_price = w.prices.housing
  // capital stock implied: create firms
  const minValue = 250 * S // don't seed tiny industries
  const sortedFeasible = [...feasible.entries()].toSorted((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )
  const regionPops = () => {
    const pops = new Map<number, number>()
    for (const per of w.persons.values()) pops.set(per.region, (pops.get(per.region) ?? 0) + 1)
    let totp = 0
    for (const v of pops.values()) totp += v
    return { pops, totp }
  }
  const pickRegion = (rw: Map<number, number>) => pick(rng, [...rw.keys()], [...rw.values()])
  for (const [gid, [pid, , regs]] of sortedFeasible) {
    const g = cat.goods[gid]
    const val = (total.get(gid) ?? 0) * domShare[gid] + (exports.get(gid) ?? 0)
    if (g.capital && !g.svc) continue // seeded below from replacement demand
    if (val < minValue) continue
    const p = cat.procs[pid]
    const qty = val / Math.max(w.prices[gid], 1e-9)
    if (g.local || (g.nt && g.svc)) {
      // one producer per region proportional to population
      const { pops, totp } = regionPops()
      for (let rid = 0; rid < w.regions.length; rid++) {
        if (!regs.includes(rid)) continue
        const share = (pops.get(rid) ?? 0) / totp
        if (share * qty <= 0) continue
        seedFirm(w, cat, rng, gid, pid, rid, share * qty)
      }
    } else {
      const nf = Math.max(
        1,
        Math.min(4, Math.trunc(1 + Math.log10(Math.max(val / (20000 * S), 1)))),
      )
      const rw = physical.regionWeights(w, cat, p, regs)
      for (let k = 0; k < nf; k++) seedFirm(w, cat, rng, gid, pid, pickRegion(rw), qty / nf)
    }
  }
  // capital goods producers: sized to replacement demand from the plan
  for (const [gid, [pid, , regs]] of sortedFeasible) {
    const g = cat.goods[gid]
    if (!g.capital || g.svc) continue
    const val = (total.get(gid) ?? 0) * domShare[gid] + (exports.get(gid) ?? 0)
    if (val < minValue) continue
    const p = cat.procs[pid]
    const qty = val / Math.max(w.prices[gid], 1e-9)
    if (g.local) {
      const { pops, totp } = regionPops()
      for (const rid of regs)
        seedFirm(w, cat, rng, gid, pid, rid, (qty * (pops.get(rid) ?? 0)) / totp)
    } else {
      const rw = physical.regionWeights(w, cat, p, regs)
      seedFirm(w, cat, rng, gid, pid, pickRegion(rw), qty)
    }
  }
  seedHousing(w, sc)
  staffFirms(w, cat, rng, sc)
  initFinance(w, cat, rng, sc, gdpMonth)
  for (const f of w.firms.values()) w.produced_ever.add(f.good)
}

interface Plan {
  total: Map<string, number>
  exports: Map<string, number>
  fte: number
  wages: number
  va: number
  avg_wage: number
}

const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v)

/**
 * Input-output plan for given household consumption, GDP (sets public budgets) and export
 * multiplier. Returns production, labor and incomes.
 */
function planEconomy(
  w: World,
  cat: Catalog,
  sc: Scenario,
  feasible: Feasible,
  domShare: Record<string, number>,
  comp: Map<string, number>,
  cons: number,
  gdp: number,
  xMult: number,
): Plan {
  const S = w.scale
  const pol = w.policy
  const pop = sc.population
  const year = sc.year
  const consPc = cons / pop
  const shares = engelShares(consPc)
  const final = new Map<string, number>()
  for (const [need, goods] of Object.entries(cat.byNeed)) {
    const gs = goods.filter((g) => cat.goods[g].year <= year)
    if (!gs.length) continue
    const ws = gs.map((g) => {
      const nd = cat.goods[g].need ?? ["", 0, 0]
      return nd[1] * (Math.max(consPc, 30) / 600) ** nd[2]
    })
    const tot = ws.reduce((a, b) => a + b, 0) || 1
    gs.forEach((g, i) => addTo(final, g, (cons * shares[need] * ws[i]) / tot))
  }
  let goodsSpend = 0
  for (const [g, v] of final) if (!cat.goods[g].svc) goodsSpend += v
  for (const [g, v] of final) if (!cat.goods[g].svc) final.set(g, v * 0.85)
  addTo(final, "retail_trade", goodsSpend * 0.15)
  const edu = gdp * pol.spend_education
  final.set("public_education", edu * (1 - pol.education_tertiary_share))
  final.set("public_university", edu * pol.education_tertiary_share)
  final.set("public_health", gdp * pol.spend_health)
  final.set("public_research", gdp * pol.spend_research)
  final.set("public_admin_services", gdp * pol.spend_admin)
  final.set("infrastructure_works", gdp * pol.spend_infrastructure)
  const dwell = pop / sc.crowding
  addTo(final, "dwelling", (dwell * w.prices.dwelling) / (cat.goods.dwelling.life ?? 120))
  let total = new Map(final)
  let exports = new Map<string, number>()
  let repl = new Map<string, number>()
  const qtyOf = (gid: string, v: number) =>
    (v * domShare[gid] + (exports.get(gid) ?? 0)) / Math.max(w.prices[gid], 1e-9)
  for (let it = 0; it < 10; it++) {
    const inter = new Map(repl)
    for (const [gid, v] of total) {
      const fe = feasible.get(gid)
      if (!fe) continue
      const p = cat.procs[fe[0]]
      const q = qtyOf(gid, v)
      for (const [alts, qty] of p.inputs) {
        const a = cheapest(alts, (x) => w.prices[x])
        addTo(inter, a, q * qty * w.prices[a])
      }
    }
    total = new Map(final)
    for (const [gid, v] of inter) addTo(total, gid, v)
    exports = new Map()
    for (const [gid, c] of comp) {
      const t = total.get(gid) ?? 0
      if (t > 0) exports.set(gid, xMult * WORLD_SCALE * t * physical.exportShare(c) * 0.6)
    }
    // replacement investment for the capital this production needs
    repl = new Map()
    for (const [gid, v] of total) {
      const fe = feasible.get(gid)
      if (!fe || gid === "housing") continue
      const p = cat.procs[fe[0]]
      const q = qtyOf(gid, v)
      const eq = p.equip ? p.equip[0] : null
      if (eq === null || eq in cat.endowments || !p.rate) continue
      const n = (q * 1.2) / p.rate
      const items: [string, number][] = [[eq, n]]
      for (const [alts, r] of Object.values(p.aux)) items.push([alts[alts.length - 1], n * r])
      for (const [a, cnt] of items) {
        const ga = cat.goods[a]
        if (a in cat.endowments || ga.year > year) continue
        addTo(repl, a, (cnt * w.prices[a]) / (ga.life || 120))
      }
    }
  }
  // labor & incomes
  let fte = 0
  let wages = 0
  let va = 0
  for (const [gid, v] of total) {
    const fe = feasible.get(gid)
    if (!fe) continue
    const p = cat.procs[fe[0]]
    const q = qtyOf(gid, v)
    if (q <= 0) continue
    const kh = 0.35 + 0.65 * physical.knowHow(w, cat, p)
    const tfp = (kh * (0.55 + 0.45 * sc.infra) * sc.tfp) / 1.04 ** sc.gen_lag
    for (const [o, h] of Object.entries(p.labor)) {
      const hrs = (q * h) / tfp / 0.85
      fte += hrs / (HOURS * S)
      wages += (hrs * w.wage_index[o]) / HOURS
    }
    let inp = 0
    for (const [alts, qq] of p.inputs) inp += Math.min(...alts.map((a) => w.prices[a])) * qq
    va += q * Math.max(0, w.prices[gid] - inp)
  }
  return { total, exports, fte, wages, va, avg_wage: wages / Math.max(fte * S, 1e-9) }
}

function seedFirm(
  w: World,
  cat: Catalog,
  rng: RngState,
  gid: string,
  pid: string,
  rid: number,
  qtyMonth: number,
): Firm {
  const p = cat.procs[pid]
  const g = cat.goods[gid]
  const f = newFirm(
    w,
    firmName(rng, gid, cat),
    rid,
    gid,
    pid,
    g.cat === "public" ? "state" : "private",
  )
  let capPerEq = physical.capacityPerPrimary(w, cat, p, w.regions[rid])
  if (capPerEq <= 0) capPerEq = p.rate || 1
  const nEq = (qtyMonth * 1.2) / Math.max(capPerEq, 1e-12)
  if (p.equip) {
    const eq = p.equip[0]
    f.equip[eq] = nEq
    f.eq_prec[eq] = cat.goods[eq].prec || 1000
    if (eq in cat.endowments) {
      const r = w.regions[rid]
      r.land_used[eq] = (r.land_used[eq] ?? 0) + nEq
    }
    for (const [alts, ratio] of Object.values(p.aux)) {
      let a = alts[0]
      if (cat.goods[a].year > w.start_year && alts.length > 1) a = alts[alts.length - 1]
      if (cat.goods[a].year > w.start_year) continue
      f.equip[a] = (f.equip[a] ?? 0) + nEq * ratio
      f.eq_prec[a] = cat.goods[a].prec || 1000
    }
  }
  f.price = w.prices[gid]
  f.markup = 0.12
  f.sales_ema = qtyMonth
  f.demand_ema = qtyMonth
  f.inv = g.svc ? 0 : qtyMonth * 0.8
  for (const [alts, q] of p.inputs) {
    const a = cheapest(alts, (x) => w.prices[x])
    if (!cat.goods[a].svc) f.inv_in[a] = q * qtyMonth * 1.2
  }
  f.plan = qtyMonth
  f.design = 1
  f.cum_output = qtyMonth * 12 * 25 // decades of industry experience
  f.gen = Math.max(0, physical.worldGeneration(w, cat, gid) - (w.scenario.gen_lag ?? 1))
  return f
}

function seedHousing(w: World, sc: Scenario) {
  const pops = new Map<number, number>()
  for (const p of w.persons.values()) pops.set(p.region, (pops.get(p.region) ?? 0) + 1)
  for (const r of w.regions) {
    const people = (pops.get(r.id) ?? 0) * w.scale
    r.dwellings = people / sc.crowding
    for (const f of w.firms.values()) {
      if (f.good === "housing" && f.region === r.id) {
        f.equip = { dwelling: r.dwellings }
        f.eq_prec = { dwelling: 5000 }
        break
      }
    }
    r.rent = w.prices.housing
  }
}

/**
 * Assign the initial workforce. Fields of study are (re)drawn so that the educated population
 * roughly matches the occupations the economy needs - this stands in for the country's history
 * before the simulation starts.
 */
function staffFirms(w: World, cat: Catalog, rng: RngState, sc: Scenario) {
  const S = w.scale
  const need: [Firm, string, number][] = []
  const occTotal = new Map<string, number>()
  for (const f of w.firms.values()) {
    const p = cat.procs[f.proc]
    const hrs = physical.laborHoursPerUnit(w, cat, f, p)
    for (const [occ, h] of Object.entries(hrs)) {
      const fte = (f.plan * h) / (HOURS * S * 0.85)
      if (fte > 1e-4) {
        need.push([f, occ, fte])
        addTo(occTotal, occ, fte)
      }
    }
  }
  // field demand from occupations
  const fieldNeed = new Map<string, number>()
  for (const [occ, fte] of occTotal) {
    const o = cat.occupations[occ]
    if (o.edu >= 3) {
      let fs = o.fields.filter((x) => x !== "*")
      if (!fs.length) fs = ["business"]
      for (const x of fs) addTo(fieldNeed, x, fte / fs.length)
    }
  }
  const adults = shuffle(rng, [...w.persons.values()].filter(isAdultWorker))
  const needFields = [...fieldNeed.keys()]
  for (const p of adults) {
    if (p.edu >= 3 && fieldNeed.size) {
      let lvlFields = needFields.filter((f) => cat.fields[f][0] <= Math.max(p.edu, 3))
      if (p.edu === 3) {
        const l3 = needFields.filter((f) => cat.fields[f][0] === 3)
        if (l3.length) lvlFields = l3
      }
      if (lvlFields.length)
        p.field = pick(
          rng,
          lvlFields,
          lvlFields.map((f) => (fieldNeed.get(f) ?? 0) + 0.3),
        )
    }
  }
  // assign by most demanding occupations first
  need.sort((a, b) => cat.occupations[b[1]].edu - cat.occupations[a[1]].edu)
  const free = new Map<number, number>()
  for (const p of adults) free.set(p.id, 1)
  const byRegion = new Map<number, Person[]>()
  for (const p of adults) {
    const l = byRegion.get(p.region) ?? []
    l.push(p)
    byRegion.set(p.region, l)
  }
  for (const [f, occ, fte] of need) {
    const o = cat.occupations[occ]
    let remaining = fte
    const pools: Person[][] = [byRegion.get(f.region) ?? []]
    for (const [r, l] of byRegion) if (r !== f.region) pools.push(l)
    outer: for (const strict of [true, false]) {
      for (const pool of pools) {
        for (const p of pool) {
          if (remaining <= 1e-6) break
          const fr = free.get(p.id) ?? 0
          if (fr <= 1e-6) continue
          if (p.occ && p.occ !== occ) continue
          if (strict && !eligible(o, p.edu, p.field)) continue
          if (!strict && p.edu + 1 < o.edu) continue
          const take = Math.min(fr, remaining)
          free.set(p.id, fr - take)
          remaining -= take
          p.occ = occ
          const yrs = Math.max(0, p.age / 12 - 18 - p.school_years + 6)
          const cap = 0.55 + 0.12 * Math.max(0, p.edu - o.edu) + 0.3 * p.h
          p.skill[occ] = Math.min(cap, 0.25 + 0.025 * yrs + 0.2 * p.h)
          p.jobs.set(f.id, [take, w.wage_index[occ]])
          f.staff.set(p.id, (f.staff.get(p.id) ?? 0) + take)
        }
        if (remaining <= 1e-6) break outer
      }
    }
  }
  // everyone else: an occupation they could do, unemployed or outside the labor force
  const part = sc.participation
  const jobless = adults.filter((p) => p.jobs.size === 0).length / Math.max(adults.length, 1)
  const pInactive = Math.min(0.9, Math.max(0, (1 - part) / Math.max(jobless, 1e-6)))
  const occEntries = Object.entries(cat.occupations)
  for (const p of adults) {
    if (p.jobs.size === 0 && random(rng) < pInactive) p.inactive = true
    if (p.occ === null) {
      let opts = occEntries.filter(([, oc]) => eligible(oc, p.edu, p.field)).map(([o]) => o)
      const narrowed = opts.filter((o) => cat.occupations[o].edu >= Math.min(p.edu, 2) - 1)
      if (narrowed.length) opts = narrowed
      p.occ = opts.length ? choice(rng, opts) : "laborer"
      p.skill[p.occ] = 0.3
    }
    p.urban = !["farmer", "forester", "fisher", "miner"].includes(p.occ)
    p.prev_wage = w.wage_index[p.occ] ?? 0
  }
}

/**
 * Seeded firms charge cost-based prices: non-tradables (housing, local services) at local cost,
 * tradables between cost and the import price.
 */
function setPrices(w: World, cat: Catalog) {
  for (let it = 0; it < 4; it++) {
    const byGood = new Map<string, [number, number][]>()
    for (const f of w.firms.values()) {
      const p = cat.procs[f.proc]
      const c = physical.estUnitCost(w, cat, p, f.region)
      const g = cat.goods[f.good]
      if (c === null || c <= 0) continue
      if (g.nt || g.local || g.svc) f.price = c * 1.15
      else {
        const wp = cat.worldPrice(f.good, yearOf(w)) || g.price
        f.price = Math.max(c * 1.05, Math.min(wp, c * 1.4))
      }
      f.cost_ema = c
      const l = byGood.get(f.good) ?? []
      l.push([f.plan, f.price])
      byGood.set(f.good, l)
    }
    for (const [gid, lst] of byGood) {
      let tot = 0
      let val = 0
      for (const [q, pr] of lst) {
        tot += q
        val += q * pr
      }
      if (tot > 0) w.prices[gid] = val / tot
    }
  }
  // housing stock consistent with what households can afford at cost-based rents
  for (const f of w.firms.values()) {
    if (f.good === "housing") {
      const value = f.plan * (w.scenario._housing_ref_price ?? cat.goods.housing.price)
      const q = value / Math.max(f.price, 1e-9)
      f.plan = f.sales_ema = f.demand_ema = q
      f.equip.dwelling = q * 1.04
      w.regions[f.region].dwellings = f.equip.dwelling
    }
  }
}

function initFinance(w: World, cat: Catalog, rng: RngState, sc: Scenario, gdpMonth0: number) {
  const S = w.scale
  setPrices(w, cat)
  // household savings
  for (const p of w.persons.values()) {
    if (p.age >= 18 * 12) {
      let wage = 0
      for (const j of p.jobs.values()) wage += j[0] * j[1]
      const inc =
        wage * 0.85 +
        (1 - personFte(p)) * 0.25 * (p.occ !== null ? (w.wage_index[p.occ] ?? 500) : 500)
      p.income_last = inc
      p.prev_wage = Math.max(p.prev_wage, wage)
      p.savings = Math.max(0, Math.max(inc, 200) * sc.savings_months * Math.exp(gauss(rng, 0, 0.9)))
    }
  }
  // firms: cash for ~2 months of costs, debt half of capital value
  const inputUnitCost = (pid: string) => {
    let s = 0
    for (const [alts, q] of cat.procs[pid].inputs)
      s += Math.min(...alts.map((a) => w.prices[a])) * q
    return s
  }
  for (const f of w.firms.values()) {
    let wages = 0
    for (const pid of f.staff.keys()) {
      const j = w.persons.get(pid)?.jobs.get(f.id)
      if (j) wages += j[0] * j[1]
    }
    wages *= S
    const inputs = inputUnitCost(f.proc) * f.plan
    f.cash = 2 * (wages + inputs) + 1e4
    let kval = 0
    for (const [e, n] of Object.entries(f.equip))
      if (!(e in cat.endowments)) kval += n * (w.prices[e] ?? 0)
    f.debt = (f.good === "housing" ? 0.15 : 0.35) * kval
    f.last = { revenue: f.plan * f.price, wages, inputs }
  }
  let hhDep = 0
  for (const p of w.persons.values()) hhDep += p.savings
  hhDep *= S
  let firmDep = 0
  let loans = 0
  for (const f of w.firms.values()) {
    firmDep += Math.max(0, f.cash)
    loans += f.debt
  }
  const govDebt = sc.gov_debt * gdpMonth0 * 12
  w.gov = {
    cash: gdpMonth0 * 0.3,
    debt: govDebt,
    revenue: {},
    spending: {},
    gdp_est: gdpMonth0,
    students: {},
    infra_stock: {},
  }
  w.bank = {
    loans,
    bonds: govDebt,
    equity: 0.1 * (loans + govDebt),
    deposits: hhDep + firmDep + w.gov.cash,
    reserves: 0,
  }
  w.bank.reserves = w.bank.deposits + w.bank.equity - w.bank.loans - w.bank.bonds
  w.policy_rate = 0.04
  // value added implied by the seeded firms (better than the a-priori guess)
  let va = 0
  for (const f of w.firms.values()) va += f.plan * Math.max(0, f.price - inputUnitCost(f.proc))
  const gdpMonth = Math.max(va * 1.08, (w.stats.seed_gdp ?? gdpMonth0) * 0.5)
  w.gov.cash = gdpMonth * 0.3
  w.gov.debt = sc.gov_debt * gdpMonth * 12
  w.bank.bonds = w.gov.debt
  w.bank.equity = 0.1 * (w.bank.loans + w.bank.bonds)
  w.stats.gdp_month = gdpMonth
  w.stats.gdp_trailing = gdpMonth
  w.stats.gdp_trend = gdpMonth
  w.stats.cpi = 1
  const wi = Object.values(w.wage_index)
  w.stats.avg_wage = wi.reduce((a, b) => a + b, 0) / wi.length
}
