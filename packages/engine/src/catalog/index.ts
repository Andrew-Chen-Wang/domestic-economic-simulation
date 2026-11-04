/**
 * Catalog builder.
 *
 * Parses the human-readable tables, generates traditional (pre-industrial) alternative processes,
 * works out when each good first became possible in the world (from its knowledge + input +
 * equipment chain), and calibrates labor hours and equipment throughput so that, at 2025 frontier
 * wages and prices, every process covers its costs. Physical quantities (inputs, energy, mass,
 * tolerances) come straight from the tables.
 *
 * Table format (goods-data.ts):
 *   id | name | cat | unit | kg/unit | world price (2025 W$/unit) | inputs | equipment | labor | knowledge | options
 *
 * inputs     `good:qty` per unit of output. `a/b/c:qty` = substitutable inputs.
 * equipment  primary capital good (or land/deposit), then `+aux:ratio`. `@rate` fixes output per
 *            unit of primary equipment per month; otherwise it is calibrated.
 * labor      `occupation:weight`; hours are calibrated from value added.
 * options    need=group:weight:elasticity, svc, local, nt, tol=um, clean=id, prec=um, life=m,
 *            dep=x, co2=t, opq=0..1, alt=trad, lx/kx, vas, restricted
 */
import * as goodsData from "./goods-data"
import * as knowledgeData from "./knowledge-data"
import * as peopleData from "./people-data"
import * as resources from "./resources-data"

export const MONTHLY_RATE = 0.005 // cost of capital used for calibration (6%/yr)
export const HOURS_PER_MONTH = peopleData.HOURS_PER_MONTH
export const EDU_LEVELS = peopleData.EDU_LEVELS

export const NEEDS: Record<string, [string, [number, number, number]]> = {
  food: ["Food & groceries", [0.42, 0.18, 0.08]],
  alcohol_tobacco: ["Alcohol & tobacco", [0.03, 0.03, 0.02]],
  clothing: ["Clothing & footwear", [0.07, 0.05, 0.04]],
  housing: ["Housing", [0.15, 0.22, 0.23]],
  utilities: ["Energy & utilities", [0.06, 0.05, 0.03]],
  furnishing: ["Furnishings & appliances", [0.03, 0.05, 0.05]],
  health: ["Health", [0.03, 0.05, 0.08]],
  transport: ["Transport", [0.05, 0.11, 0.12]],
  communication: ["Communication", [0.02, 0.04, 0.03]],
  recreation: ["Recreation & culture", [0.03, 0.07, 0.1]],
  education: ["Education", [0.02, 0.02, 0.02]],
  restaurants: ["Restaurants & hotels", [0.03, 0.06, 0.08]],
  personal_care: ["Personal care & cosmetics", [0.02, 0.03, 0.03]],
  misc: ["Financial & other services", [0.02, 0.04, 0.09]],
}
const ENGEL_POINTS = [100, 600, 3000] as const

/** Budget shares by need at a given real per-capita consumption (W$/month). */
export function engelShares(perCapitaReal: number): Record<string, number> {
  const x = Math.log(Math.max(perCapitaReal, 20))
  const p = ENGEL_POINTS.map((v) => Math.log(v))
  const out: Record<string, number> = {}
  let tot = 0
  for (const [need, [, s]] of Object.entries(NEEDS)) {
    let v: number
    if (x <= p[0]) v = s[0]
    else if (x >= p[2]) v = s[2]
    else if (x <= p[1]) v = s[0] + ((x - p[0]) / (p[1] - p[0])) * (s[1] - s[0])
    else v = s[1] + ((x - p[1]) / (p[2] - p[1])) * (s[2] - s[1])
    out[need] = v
    tot += v
  }
  for (const k of Object.keys(out)) out[k] /= tot
  return out
}

export type Input = [alts: string[], qty: number]

export interface Good {
  id: string
  name: string
  cat: string
  unit: string
  kg: number
  price: number
  price_listed: number
  need: [need: string, weight: number, elasticity: number] | null
  svc: boolean
  local: boolean
  nt: boolean
  tol: number | null
  clean: string | null
  prec: number | null
  life: number | null
  opq: number
  restricted: boolean
  capital: boolean
  processes: string[]
  vas: number | null
  endowment?: boolean
  rent?: number
  year: number
}

export interface Process {
  id: string
  good: string
  inputs: Input[]
  equip: string[] | null
  rate: number | null
  aux: Record<string, Input>
  labor_w: Record<string, number>
  labor: Record<string, number>
  know: string[]
  dep: string | null
  co2: number
  lx: number
  kx: number
  trad: boolean
  alt_trad: boolean
  vas: number | null
  optional: Set<string>
  year: number
  unit_cost_ref: number
  design_effort: number
  _orig_inputs?: Input[]
}

export interface KnowledgeNode {
  id: string
  name: string
  kind: "sci" | "eng" | "proc"
  year: number
  diff: number
  prereqs: string[]
  field: string
}

export interface Occupation {
  id: string
  name: string
  edu: number
  fields: string[]
  ref_wage: number
}

function* splitRows(table: string, min = 11): Generator<string[]> {
  for (const line of table.trim().split("\n")) {
    const s = line.trim()
    if (!s || s.startsWith("#")) continue
    const cols = line.split("|").map((c) => c.trim())
    while (cols.length < min) cols.push("")
    yield cols
  }
}

const words = (s: string) => s.split(/\s+/).filter(Boolean)

function rsplit1(s: string, sep: string): [string, string] {
  const i = s.lastIndexOf(sep)
  return [s.slice(0, i), s.slice(i + 1)]
}

function parseInputs(s: string): Input[] {
  const out: Input[] = []
  for (const tok of words(s)) {
    const [name, qty] = rsplit1(tok, ":")
    const q = Number(qty)
    if (q <= 0) continue
    out.push([name.split("/"), q])
  }
  return out
}

function parseEquip(s: string): [string[] | null, number | null, Record<string, Input>] {
  if (!s) return [null, null, {}]
  const parts = s.split("+")
  let first = parts[0]
  let rate: number | null = null
  if (first.includes("@")) {
    const [f, r] = first.split("@")
    first = f
    rate = Number(r)
  }
  const aux: Record<string, Input> = {}
  for (const p of parts.slice(1)) {
    const [name, ratio] = rsplit1(p, ":")
    aux[name] = [name.split("/"), Number(ratio)]
  }
  return [first.split("/"), rate, aux]
}

function parseLabor(s: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const tok of words(s)) {
    const [name, w] = rsplit1(tok, ":")
    const v = Number(w)
    if (v > 0) out[name] = v
  }
  return out
}

function parseOpts(s: string): Record<string, string | true> {
  const o: Record<string, string | true> = {}
  for (const tok of words(s)) {
    const i = tok.indexOf("=")
    if (i >= 0) o[tok.slice(0, i)] = tok.slice(i + 1)
    else o[tok] = true
  }
  return o
}

const optNum = (o: Record<string, string | true>, k: string): number | null =>
  typeof o[k] === "string" ? Number(o[k]) : null
const optStr = (o: Record<string, string | true>, k: string): string | null =>
  typeof o[k] === "string" ? o[k] : null

function parseKnowledge(): Record<string, KnowledgeNode> {
  const nodes: Record<string, KnowledgeNode> = {}
  for (const cols of splitRows(knowledgeData.TABLE, 7)) {
    const [id, name, kind, year, diff, prereq, field] = cols
    nodes[id] = {
      id,
      name,
      kind: kind as KnowledgeNode["kind"],
      year: Number(year),
      diff: Number(diff),
      prereqs: words(prereq),
      field,
    }
  }
  return nodes
}

function parseOccupations(): Record<string, Occupation> {
  const occ: Record<string, Occupation> = {}
  for (const cols of splitRows(peopleData.TABLE, 5)) {
    const [id, name, edu, fields, wage] = cols
    occ[id] = { id, name, edu: Number(edu), fields: words(fields), ref_wage: Number(wage) }
  }
  return occ
}

/**
 * Can a person with this education/field work in an occupation? Experience substitutes for
 * credentials: someone with real skill in an occupation can keep working in it.
 */
export function eligible(occ: Occupation, edu: number, field: string, skill = 0): boolean {
  if (skill >= 0.35) return true
  if (edu < occ.edu) return false
  return occ.fields.includes("*") || occ.fields.includes(field)
}

const OVERHEADS: [string, number, "goods" | "all" | "modern" | "consumer"][] = [
  ["wholesale_logistics", 0.035, "goods"],
  ["business_services", 0.02, "all"],
  ["financial_services", 0.01, "all"],
  ["software_services", 0.008, "modern"],
  ["advertising_marketing", 0.012, "consumer"],
]
export const OVERHEAD_IDS = new Set(OVERHEADS.map((o) => o[0]))

const minOf = (xs: Iterable<number>) => {
  let m = Infinity
  for (const x of xs) if (x < m) m = x
  return m
}

export class Catalog {
  knowledge = parseKnowledge()
  knowledgeFields = knowledgeData.FIELDS
  occupations = parseOccupations()
  fields = peopleData.FIELDS
  deposits = resources.DEPOSITS
  archetypes = resources.ARCHETYPES
  crops = resources.CROPS
  regionNames = resources.REGION_NAMES
  needs = NEEDS
  endowments = { ...goodsData.ENDOWMENTS }
  goods: Record<string, Good> = {}
  procs: Record<string, Process> = {}
  errors: string[] = []
  kyear: Record<string, number> = {}
  avail: Record<string, number> = {}
  procAvail: Record<string, number> = {}
  consumerGoods: string[] = []
  capitalGoods: string[] = []
  byNeed: Record<string, string[]> = {}
  usedAsInput: Record<string, string[]> = {}
  usedAsEquip: Record<string, string[]> = {}

  constructor() {
    this.parse()
    this.overheads()
    this.genTrad()
    this.resolve()
    this.availability()
    this.calibrate()
    this.derived()
  }

  // ------------------------------------------------------------------ parse
  private addRow(cols: string[], isAlt = false) {
    let g: Good
    let pid: string
    let o: Record<string, string | true>
    let inputs: string, equip: string, labor: string, know: string
    if (isAlt) {
      let gid: string, opts: string
      ;[pid, gid, inputs, equip, labor, know, opts] = cols
      const found = this.goods[gid]
      if (!found) {
        this.errors.push(`alt process ${pid}: unknown good ${gid}`)
        return
      }
      g = found
      o = parseOpts(opts)
    } else {
      const [gid, name, cat, unit, kg, price, inp, eq, lab, kn, opts] = cols
      ;[inputs, equip, labor, know] = [inp, eq, lab, kn]
      o = parseOpts(opts)
      let need: Good["need"] = null
      const ns = optStr(o, "need")
      if (ns) {
        const parts = ns.split(":")
        need = [parts[0], Number(parts[1]), parts.length > 2 ? Number(parts[2]) : 0]
      }
      const capital = cat === "capital" || cat === "building"
      const life = optNum(o, "life")
      g = {
        id: gid,
        name,
        cat,
        unit,
        kg: Number(kg || 0),
        price: Number(price),
        price_listed: Number(price),
        need,
        svc: Boolean(o.svc),
        local: Boolean(o.local),
        nt: Boolean(o.nt),
        tol: optNum(o, "tol"),
        clean: optStr(o, "clean"),
        prec: optNum(o, "prec"),
        life: life === null ? (capital ? 240 : null) : Math.trunc(life),
        opq: optNum(o, "opq") ?? 0.2,
        restricted: Boolean(o.restricted),
        capital,
        processes: [],
        vas: optNum(o, "vas"),
        year: 0,
      }
      this.goods[gid] = g
      pid = gid
    }
    const [alts, rate, aux] = parseEquip(equip)
    this.procs[pid] = {
      id: pid,
      good: g.id,
      inputs: parseInputs(inputs),
      equip: alts,
      rate,
      aux,
      labor_w: parseLabor(labor),
      labor: {},
      know: words(know),
      dep: optStr(o, "dep"),
      co2: optNum(o, "co2") ?? 0,
      lx: optNum(o, "lx") ?? 1,
      kx: optNum(o, "kx") ?? 1,
      trad: false,
      alt_trad: o.alt === "trad",
      vas: optNum(o, "vas") ?? g.vas,
      optional: new Set(),
      year: 0,
      unit_cost_ref: 0,
      design_effort: 0,
    }
    g.processes.push(pid)
  }

  private parse() {
    for (const cols of splitRows(goodsData.TABLE)) this.addRow(cols)
    for (const cols of splitRows(goodsData.EXTRA_CAPITAL)) this.addRow(cols)
    for (const cols of splitRows(goodsData.ALT_PROCESSES)) this.addRow(cols, true)
    for (const [eid, e] of Object.entries(this.endowments)) {
      this.goods[eid] = {
        id: eid,
        name: e.name,
        cat: "endowment",
        unit: "ha",
        kg: 0,
        price: e.rent / MONTHLY_RATE,
        price_listed: e.rent / MONTHLY_RATE,
        need: null,
        svc: false,
        local: true,
        nt: true,
        tol: null,
        clean: null,
        prec: null,
        life: 10 ** 6,
        opq: 0,
        restricted: false,
        capital: true,
        processes: [],
        endowment: true,
        rent: e.rent,
        vas: null,
        year: 0,
      }
    }
  }

  /** Every business buys services: distribution, legal & accounting, finance, IT and marketing. */
  private overheads() {
    for (const p of Object.values(this.procs)) {
      const g = this.goods[p.good]
      if (g.cat === "public" || g.endowment || OVERHEAD_IDS.has(g.id)) continue
      if (g.cat === "building" && g.svc) continue
      const have = new Set(p.inputs.map(([alts]) => alts[0]))
      const modern = p.know.some((k) => (this.knowledge[k]?.year ?? 0) >= 1960)
      for (const [sid, share, scope] of OVERHEADS) {
        if (have.has(sid) || !(sid in this.goods)) continue
        if (scope === "goods" && (g.svc || g.local)) continue
        if (scope === "modern" && !modern) continue
        if (scope === "consumer" && !g.need) continue
        if (g.svc && sid === "wholesale_logistics") continue
        p.inputs.push([[sid], (share * g.price) / this.goods[sid].price])
      }
    }
  }

  /**
   * Pre-industrial way of making the same thing: hand tools (and draft animals on farms), many
   * more labor hours, lower land yields, and only inputs pre-industrial societies could make.
   */
  private genTrad() {
    const oldKnowOk = (k: string) => (this.knowledge[k]?.year ?? 9999) <= 1780
    for (const [pid, p] of Object.entries(this.procs)) {
      if (!p.alt_trad) continue
      const g = this.goods[p.good]
      const tp: Process = {
        ...p,
        id: `${pid}__trad`,
        trad: true,
        alt_trad: false,
        optional: new Set(),
      }
      const isLand = p.equip !== null && p.equip[0] in this.endowments
      let lx: number
      if (isLand) {
        tp.rate = (p.rate ?? 1) * 0.35
        tp.aux = { horses: [["horses"], 0.04], hand_tools: [["hand_tools"], 0.05] }
        lx = 6
      } else {
        tp.equip = ["hand_tools"]
        tp.rate = null
        tp.aux = {}
        lx = g.cat === "resource" ? 10 : 7
      }
      tp.lx = p.lx * lx
      tp.kx = 0.4
      tp.inputs = [] // filtered after availability is known
      tp._orig_inputs = p.inputs
      tp.know = p.know.filter(oldKnowOk)
      // a craftsman/laborer does what specialists do in the modern plant
      const lw: Record<string, number> = {}
      for (const [occ0, w] of Object.entries(p.labor_w)) {
        const o = this.occupations[occ0]
        const occ = o && o.edu >= 3 ? "craftsman" : occ0
        lw[occ] = (lw[occ] ?? 0) + w
      }
      tp.labor_w = lw
      this.procs[tp.id] = tp
      g.processes.push(tp.id)
    }
  }

  private resolve() {
    const clean = (list: Input[]): Input[] =>
      list
        .map(([alts, q]): Input => [alts.filter((a) => a in this.goods), q])
        .filter(([alts]) => alts.length > 0)
    for (const [pid, p] of Object.entries(this.procs)) {
      for (const [alts] of [...p.inputs, ...(p._orig_inputs ?? [])])
        for (const a of alts) if (!(a in this.goods)) this.errors.push(`${pid}: unknown input ${a}`)
      for (const a of p.equip ?? [])
        if (!(a in this.goods)) this.errors.push(`${pid}: unknown equipment ${a}`)
      for (const [alts] of Object.values(p.aux))
        for (const a of alts)
          if (!(a in this.goods)) this.errors.push(`${pid}: unknown aux equipment ${a}`)
      for (const occ of Object.keys(p.labor_w))
        if (!(occ in this.occupations)) this.errors.push(`${pid}: unknown occupation ${occ}`)
      for (const k of p.know)
        if (!(k in this.knowledge)) this.errors.push(`${pid}: unknown knowledge ${k}`)
      if (p.dep && !(p.dep in this.deposits)) this.errors.push(`${pid}: unknown deposit ${p.dep}`)
    }
    for (const g of Object.values(this.goods)) {
      if (g.clean && !(g.clean in this.goods))
        this.errors.push(`${g.id}: unknown cleanroom ${g.clean}`)
      if (g.need && !(g.need[0] in NEEDS)) this.errors.push(`${g.id}: unknown need ${g.need[0]}`)
    }
    for (const k of Object.values(this.knowledge))
      for (const pr of k.prereqs)
        if (!(pr in this.knowledge)) this.errors.push(`knowledge ${k.id}: unknown prereq ${pr}`)
    // drop broken references so the sim can still run
    for (const p of Object.values(this.procs)) {
      p.inputs = clean(p.inputs)
      if (p._orig_inputs) p._orig_inputs = clean(p._orig_inputs)
      p.labor_w = Object.fromEntries(
        Object.entries(p.labor_w).filter(([o]) => o in this.occupations),
      )
      p.know = p.know.filter((k) => k in this.knowledge)
    }
  }

  /** Year the world frontier could first make each good/process. */
  private availability() {
    const INF = 10 ** 6
    const NEVER = -(10 ** 4)
    const kyear: Record<string, number> = {}
    for (const [k, v] of Object.entries(this.knowledge)) kyear[k] = v.year
    // knowledge is only usable once prerequisites exist
    for (let i = 0; i < 10; i++)
      for (const [k, v] of Object.entries(this.knowledge))
        for (const pr of v.prereqs) kyear[k] = Math.max(kyear[k], kyear[pr] ?? NEVER)
    this.kyear = kyear
    // Optimistic fixed point: start everything at "always possible" and push dates up to the
    // latest prerequisite. Production cycles (kilns need concrete, which needs cement) are
    // bootstrappable in reality, so they resolve to the date their knowledge appears.
    let avail: Record<string, number> = {}
    for (const gid of Object.keys(this.goods)) avail[gid] = NEVER
    const pav: Record<string, number> = {}
    for (const pid of Object.keys(this.procs)) pav[pid] = NEVER
    const coreOf = (p: Process) => (p.know.length ? Math.max(...p.know.map((k) => kyear[k])) : null)

    for (let it = 0; it < 300; it++) {
      let changed = false
      const next: Record<string, number> = {}
      for (const [gid, g] of Object.entries(this.goods)) next[gid] = g.endowment ? NEVER : INF
      for (const [pid, p] of Object.entries(this.procs)) {
        const core = coreOf(p)
        let y = core ?? NEVER
        const gSelf = p.good
        const req: string[][] = []
        if (!p.trad) for (const [alts] of p.inputs) req.push(alts)
        for (const [alts] of Object.values(p.aux)) req.push(alts)
        for (const alts of req) {
          const aY = minOf(alts.map((a) => (a !== gSelf ? avail[a] : NEVER)))
          if (core !== null && aY > core + 10) continue // later invention: an optional upgrade
          y = Math.max(y, aY)
        }
        if (p.equip) y = Math.max(y, minOf(p.equip.map((a) => (a !== gSelf ? avail[a] : NEVER))))
        if (y !== pav[pid]) {
          pav[pid] = y
          changed = true
        }
        if (y < next[gSelf]) next[gSelf] = y
      }
      for (const gid of Object.keys(next)) if (next[gid] !== avail[gid]) changed = true
      avail = next
      if (!changed) break
    }
    // mark optional inputs / aux equipment per process
    for (const p of Object.values(this.procs)) {
      const core = coreOf(p)
      const opt = new Set<string>()
      if (core !== null) {
        for (const [alts] of p.inputs)
          if (minOf(alts.map((a) => avail[a])) > core + 10) opt.add(alts[0])
        for (const [name, [alts]] of Object.entries(p.aux))
          if (minOf(alts.map((a) => avail[a])) > core + 10) opt.add(name)
      }
      // overhead services are bought when available, never a hard requirement
      for (const [alts] of p.inputs) if (OVERHEAD_IDS.has(alts[0])) opt.add(alts[0])
      p.optional = opt
    }
    // traditional processes keep only inputs that existed before ~1800
    for (const p of Object.values(this.procs)) {
      if (p.trad && p._orig_inputs) {
        p.inputs = p._orig_inputs
          .map(([alts, q]): Input => [alts.filter((a) => avail[a] <= 1800), q])
          .filter(([alts]) => alts.length > 0)
      }
      delete p._orig_inputs
    }
    this.avail = avail
    this.procAvail = pav
    for (const [gid, g] of Object.entries(this.goods)) g.year = avail[gid]
    for (const [pid, p] of Object.entries(this.procs)) p.year = pav[pid]
  }

  /**
   * Pass 1: derive labor hours and equipment throughput from listed prices. Pass 2: with
   * quantities fixed, raise world prices where the frontier process cannot cover its costs.
   */
  private calibrate() {
    const wage: Record<string, number> = {}
    for (const [o, v] of Object.entries(this.occupations)) wage[o] = v.ref_wage
    const listed: Record<string, number> = {}
    for (const [gid, g] of Object.entries(this.goods)) listed[gid] = g.price

    const eqMonthly = (gid: string, price: Record<string, number>) => {
      const g = this.goods[gid]
      if (g.endowment) return g.rent ?? 0
      return price[gid] * (1 / (g.life || 120) + MONTHLY_RATE)
    }
    const perPrimaryCost = (p: Process, price: Record<string, number>) => {
      let c = p.equip ? eqMonthly(p.equip[0], price) : 0
      for (const [alts, ratio] of Object.values(p.aux))
        c += ratio * minOf(alts.map((a) => eqMonthly(a, price)))
      return c
    }
    const inputCost = (p: Process, price: Record<string, number>) => {
      let s = 0
      for (const [alts, q] of p.inputs) s += minOf(alts.map((a) => price[a])) * q
      return s
    }

    for (const p of Object.values(this.procs)) {
      const g = this.goods[p.good]
      const inp = inputCost(p, listed)
      let vas = p.vas ?? (g.capital ? 0.6 : 0.55)
      if (g.cat === "resource") vas = Math.min(vas, 0.4)
      const kshare = (1 - vas) * 0.6
      const va = Math.max(listed[p.good] - inp, 0.25 * listed[p.good])
      const ppc = perPrimaryCost(p, listed)
      let rate: number | null
      if (p.rate !== null && p.equip) rate = p.rate
      else if (p.equip) {
        rate = ppc / Math.max(kshare * va * p.kx, 1e-9)
        if (p.trad) rate = ppc / Math.max(kshare * va * 0.4, 1e-9)
      } else rate = null
      // machines that make themselves: <=2 machine-months per unit
      if (rate !== null && p.equip && p.equip.includes(p.good)) rate = Math.max(rate, 0.5)
      const lw = p.labor_w
      const entries = Object.entries(lw)
      const wsum = entries.reduce((s, [, w]) => s + w, 0) || 1
      const avgW = entries.length ? entries.reduce((s, [o, w]) => s + wage[o] * w, 0) / wsum : 20
      const hoursTotal = ((vas * va) / avgW) * p.lx
      p.labor = {}
      for (const [o, w] of entries) p.labor[o] = (hoursTotal * w) / wsum
      p.rate = rate
    }

    const price = { ...listed }
    for (let it = 0; it < 25; it++) {
      for (const [pid, p] of Object.entries(this.procs)) {
        const g = this.goods[p.good]
        const inp = inputCost(p, price)
        const kcost = p.rate ? perPrimaryCost(p, price) / p.rate : 0
        let lcost = 0
        for (const [o, h] of Object.entries(p.labor)) lcost += wage[o] * h
        const full = inp + kcost + lcost
        p.unit_cost_ref = full
        if (!p.trad && pid === g.processes[0] && !g.endowment) {
          const need = Math.min(full * 1.12, listed[g.id] * 4)
          if (need > price[g.id]) price[g.id] = need
        }
      }
    }
    for (const [gid, g] of Object.entries(this.goods)) {
      g.price_listed = listed[gid]
      g.price = price[gid]
    }
  }

  private derived() {
    this.consumerGoods = Object.values(this.goods)
      .filter((g) => g.need)
      .map((g) => g.id)
    this.capitalGoods = Object.values(this.goods)
      .filter((g) => g.capital && !g.endowment)
      .map((g) => g.id)
    for (const gid of this.consumerGoods) {
      const n = this.goods[gid].need?.[0] ?? ""
      ;(this.byNeed[n] ??= []).push(gid)
    }
    // R&D difficulty to reproduce a product (person-years)
    for (const p of Object.values(this.procs)) {
      const g = this.goods[p.good]
      const tol = g.tol
      const kdiff = Math.max(0, ...p.know.map((k) => this.knowledge[k].diff))
      const tolf = 1 + (tol ? Math.log10(1 + 100 / tol) : 0)
      const cleanf = g.clean === "cleanroom_iso3" ? 3 : g.clean ? 2 : 1
      p.design_effort = 20 * (1 + p.inputs.length) * tolf * cleanf * (1 + kdiff / 1000)
      if (p.trad) p.design_effort *= 0.2
    }
    for (const gid of Object.keys(this.goods)) {
      this.usedAsInput[gid] = []
      this.usedAsEquip[gid] = []
    }
    for (const [pid, p] of Object.entries(this.procs)) {
      for (const [alts] of p.inputs) for (const a of alts) this.usedAsInput[a].push(pid)
      for (const a of p.equip ?? []) this.usedAsEquip[a].push(pid)
      for (const [alts] of Object.values(p.aux)) for (const a of alts) this.usedAsEquip[a].push(pid)
    }
  }

  /**
   * World price in W$ for a year: new technologies start expensive and fall along an experience
   * curve towards the 2025 reference price.
   */
  worldPrice(gid: string, year: number): number | null {
    const g = this.goods[gid]
    if (g.year > year) return null
    return g.price * (1 + 3 * Math.exp(-(year - g.year) / 10))
  }

  summary() {
    return {
      goods: Object.keys(this.goods).length,
      processes: Object.keys(this.procs).length,
      knowledge: Object.keys(this.knowledge).length,
      occupations: Object.keys(this.occupations).length,
      consumer_goods: this.consumerGoods.length,
      capital_goods: this.capitalGoods.length,
      errors: this.errors,
    }
  }
}

let CAT: Catalog | null = null
export function getCatalog(): Catalog {
  CAT ??= new Catalog()
  return CAT
}
