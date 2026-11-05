/**
 * Knowledge and invention.
 *
 * National knowledge levels (0..1) per node change through public research (scientists paid by
 * the research budget, by field priority), university professors, firm R&D spillovers, absorbing
 * world literature (needs an educated workforce), learning by doing (process know-how grows
 * while practiced domestically) and forgetting (it decays when nobody practices it).
 *
 * Firms separately hold *designs*. Reproducing a product (design 0 -> 1) is an uncertain R&D
 * project: months can be inconclusive, setbacks happen, prototypes fail if the needed inputs or
 * equipment precision are missing, and disassembling imports helps only as much as the product
 * is transparent and the firm understands the underlying science. After a design works, firms
 * improve it generation by generation; they can overtake the world frontier.
 */
import type { Catalog, Process } from "./catalog"
import * as physical from "./physical"
import {
  advanceCorporateExperience,
  corporateMaturity,
  processTechnology,
  publicKnowledgeBoost,
} from "./technology"
import { gauss, random } from "./rng"
import { type Ctx, pct0, type Sim } from "./sim"
import { addEvent, type Firm, personFte, type World, yearOf } from "./world"

/** re-discovering known science costs ~12% of inventing it */
export const CATCHUP_FACTOR = 0.12
/** genuine invention: wrong turns, failed experiments, no roadmap */
export const FRONTIER_FACTOR = 4.0
/** monthly absorption from world literature at full capacity */
export const LITERATURE_RATE = 0.0006
/** monthly loss of unpracticed process know-how */
export const DECAY = 0.0012

const RESEARCH_OCCS = new Set([
  "scientist",
  "lab_tech",
  "professor",
  "agronomist",
  "doctor",
  "mech_engineer",
  "elec_engineer",
  "chem_engineer",
  "materials_engineer",
  "software_dev",
  "process_engineer",
  "civil_engineer",
])
const RD_OCCS = new Set([
  "mech_engineer",
  "elec_engineer",
  "chem_engineer",
  "materials_engineer",
  "software_dev",
  "process_engineer",
  "scientist",
  "pharmacist",
  "agronomist",
  "designer",
  "technician",
  "lab_tech",
])

/** Person-years of research per month from a firm's staff. */
export function researchEffort(w: World, firm: Firm, occs: Set<string> | null = null): number {
  let e = 0
  for (const [pid, fte] of firm.staff) {
    const p = w.persons.get(pid)
    if (!p || p.occ === null) continue
    if (occs && !occs.has(p.occ)) continue
    e += (fte * w.scale * (0.3 + (p.skill[p.occ] ?? 0.2))) / 12
  }
  return e
}

const prereqMin = (K: Record<string, number>, pre: string[]) => {
  let m = 1
  if (pre.length) {
    m = Infinity
    for (const x of pre) m = Math.min(m, K[x] ?? 0)
  }
  return m
}

export function step(sim: Sim, ctx: Ctx) {
  const w = sim.w
  const cat = sim.cat
  const rng = w.rng
  const K = w.knowledge
  const year = yearOf(w)
  // ------------------------------------------------ national research effort by field
  const fieldEffort: Record<string, number> = {}
  let pub = 0
  for (const f of w.firms.values()) {
    if (f.good === "public_research")
      pub += researchEffort(w, f, RESEARCH_OCCS) * Math.min(1, (f.last.util ?? 1) + 0.2)
    else if (f.good === "public_university")
      pub += 0.3 * researchEffort(w, f, new Set(["professor"]))
  }
  const weights = w.policy.research_fields
  let totw = 0
  for (const v of Object.values(weights)) totw += Math.max(0, v)
  totw ||= 1
  for (const [fld, wt] of Object.entries(weights)) fieldEffort[fld] = (pub * Math.max(0, wt)) / totw
  // firm R&D spills over into the national stock (25%)
  for (const [eff, nodes] of ctx.rd_spill.values()) {
    for (const k of nodes) {
      const fld = cat.knowledge[k].field
      fieldEffort[fld] = (fieldEffort[fld] ?? 0) + (0.25 * eff) / Math.max(1, nodes.length)
    }
  }
  ctx.stats.research_py = pub * 12
  // ------------------------------------------------ allocate to nodes
  const byField: Record<string, [string, number][]> = {}
  for (const [k, node] of Object.entries(cat.knowledge)) {
    if ((K[k] ?? 0) >= 0.999) continue
    const pmin = prereqMin(K, node.prereqs)
    if (pmin < 0.55) continue
    ;(byField[node.field] ??= []).push([k, pmin])
  }
  const byYear = (a: [string, number], b: [string, number]) => cat.kyear[a[0]] - cat.kyear[b[0]]
  for (const [fld, eff] of Object.entries(fieldEffort)) {
    const nodes = byField[fld]
    if (!nodes?.length || eff <= 0) continue
    // catch up on known science first; frontier work gets a minority share
    const known = nodes.filter((x) => cat.kyear[x[0]] <= year)
    let front = nodes.filter((x) => cat.kyear[x[0]] > year)
    const alloc: [[string, number], number][] = []
    if (known.length) {
      known.sort(byYear)
      const focus = known.slice(0, 4)
      const share = front.length ? 0.85 : 1
      for (const x of focus) alloc.push([x, (eff * share) / focus.length])
    }
    // frontier work needs the prerequisites mastered, not just understood
    front = front.filter((x) => x[1] >= 0.85)
    if (front.length) {
      front.sort(byYear)
      const focus = front.slice(0, 2)
      const share = known.length ? 0.15 : 1
      for (const x of focus) alloc.push([x, (eff * share) / focus.length])
    }
    for (const [[k, pmin], e] of alloc) {
      const node = cat.knowledge[k]
      const worldKnows = cat.kyear[k] <= year
      // inventing something nobody has done is far harder than re-learning it
      const diff = node.diff * (worldKnows ? CATCHUP_FACTOR : FRONTIER_FACTOR)
      const pf = Math.min(1, pmin / 0.8) ** 2
      const noise = Math.exp(gauss(rng, -0.1, 0.5))
      const d = (e / diff) * pf * noise
      const before = K[k] ?? 0
      if (!worldKnows && random(rng) < 0.02) {
        // frontier research is genuinely uncertain
        K[k] = Math.max(0, before - 0.15 * before)
        if (before > 0.1)
          addEvent(
            w,
            "research",
            `Research on ${node.name} hit a dead end; a promising approach failed ` +
              `(understanding ${pct0(before)} -> ${pct0(K[k])}).`,
            { node: k },
          )
        continue
      }
      K[k] = Math.min(1, before + d)
      announce(w, cat, k, before, K[k], worldKnows)
    }
  }
  // ------------------------------------------------ literature absorption
  const absorb = w.stats.absorptive ?? 0.3
  for (const [k, node] of Object.entries(cat.knowledge)) {
    const lv = K[k] ?? 0
    if (lv >= 1 || cat.kyear[k] > year) continue
    if (prereqMin(K, node.prereqs) < 0.7) continue
    const rate = LITERATURE_RATE * absorb * (node.kind === "proc" ? 0.3 : 1)
    const nv = Math.min(1, lv + rate * (1.05 - lv) * 2)
    K[k] = nv
    announce(w, cat, k, lv, nv, true)
  }
  // ------------------------------------------------ learning by doing / forgetting
  for (const [k, node] of Object.entries(cat.knowledge)) {
    if (node.kind === "sci") continue
    const lv = K[k] ?? 0
    const pr = ctx.practiced.get(k)
    if (pr !== undefined) {
      const intensity = Math.min(1, pr / 5e5)
      const nv = Math.min(1, lv + 0.01 * intensity * (1 - lv) + 0.002 * intensity)
      K[k] = nv
      announce(w, cat, k, lv, nv, cat.kyear[k] <= year)
    } else if (lv > 0 && node.kind === "proc") {
      K[k] = Math.max(0, lv - DECAY * (0.5 + lv))
      if (lv >= 0.5 && K[k] < 0.5)
        addEvent(
          w,
          "knowledge",
          `Process know-how for ${node.name} is fading: nobody has practiced it domestically for years.`,
          { node: k },
        )
    }
  }
}

function announce(
  w: World,
  cat: Catalog,
  k: string,
  before: number,
  after: number,
  worldKnows: boolean,
) {
  const node = cat.knowledge[k]
  if (before < 0.5 && after >= 0.5) {
    if (worldKnows)
      addEvent(
        w,
        "knowledge",
        `Domestic researchers now understand ${node.name} (known abroad since ${cat.kyear[k]}).`,
        { node: k },
      )
    else
      addEvent(
        w,
        "invention",
        `BREAKTHROUGH: ${node.name} achieved domestically before the rest of the world!`,
        {
          node: k,
        },
      )
  }
}

/** Run a firm's R&D for one month: reproduce its product, or improve it. */
export function firmRd(sim: Sim, ctx: Ctx, f: Firm) {
  const w = sim.w
  const cat = sim.cat
  const rng = w.rng
  const p = cat.procs[f.proc]
  const g = cat.goods[f.good]
  const profile = processTechnology(cat, p)
  const version2 = w.mechanism_version === 2
  let eff = researchEffort(w, f, RD_OCCS) * Math.max(0, f.rd_share)
  if (f.design >= 1) {
    // only the engineers actually assigned to R&D count
    let tech = 0
    for (const [pid, fte] of f.staff) {
      const occ = w.persons.get(pid)?.occ
      if (occ && RD_OCCS.has(occ)) tech += fte
    }
    const rdFte = ctx.fs.get(f.id)?.rd_fte ?? 0
    eff *= tech > 0 ? Math.min(1, rdFte / tech) : 0
  }
  const corporate = version2
    ? advanceCorporateExperience(
        w,
        cat,
        f,
        eff,
        ctx.fs.get(f.id)?.net ?? 0,
        p.know.every((k) => (w.knowledge[k] ?? 0) >= 0.5) &&
          prototypeBlocker(w, cat, f, p) === null,
      )
    : null
  const validatedUpgrade = !corporate || corporate.cycles - corporate.upgrade_cycle >= 1 - 1e-9
  // Buying a machine is useful, but a difficult process still needs this firm's validation.
  if (
    f.design >= 1 &&
    f.gen < physical.worldGeneration(w, cat, f.good) - 1 &&
    validatedUpgrade &&
    random(rng) < 1 / 30
  ) {
    f.gen += 1
    if (corporate) corporate.upgrade_cycle = corporate.cycles
  }
  if (f.rd_share <= 0) return
  if (eff <= 0) {
    if (f.design < 1) f.blocked = "no engineers available for R&D"
    return
  }
  ctx.rd_spill.set(f.id, [eff, p.know])
  ctx.addStat("rd_py", eff * 12)
  const D = p.design_effort
  if (f.design < 1) {
    // ---- scientific feasibility gate
    const missing = p.know.filter((k) => (w.knowledge[k] ?? 0) < 0.5)
    if (missing.length) {
      f.blocked = `science not understood: ${missing
        .slice(0, 3)
        .map((k) => cat.knowledge[k].name)
        .join(", ")}`
      if (random(rng) < 0.02)
        addEvent(
          w,
          "rd",
          `${f.name} cannot progress on ${g.name}: the country does not yet understand ` +
            `${cat.knowledge[missing[0]].name}.`,
          { firm: f.id, good: f.good },
        )
      return
    }
    let mult = 1
    // reverse engineering imports
    if ((w.imports_12m[f.good] ?? 0) > 0) {
      const under = prereqMin(w.knowledge, p.know)
      mult = version2
        ? publicKnowledgeBoost(profile, 1 - g.opq, under)
        : mult + 3 * (1 - g.opq) * under ** 2
    }
    // other domestic producers' engineers carry tacit knowledge
    for (const o of w.firms.values()) {
      if (o.good === f.good && o.design >= 1 && o.id !== f.id) {
        mult += version2 ? 0.5 * (1 - profile.tacit_share) : 2
        break
      }
    }
    if (f.owner === "foreign") mult += 4
    const roll = random(rng)
    let outcome: string
    let d: number
    if (roll < 0.28) {
      outcome = "inconclusive"
      d = 0
    } else if (roll < 0.33) {
      outcome = "setback"
      d = -0.08 * f.design
    } else if (roll < 0.36) {
      outcome = "breakthrough"
      d = (3 * eff * mult) / D
    } else {
      outcome = "progress"
      d = ((eff * mult) / D) * Math.exp(gauss(rng, 0, 0.4))
    }
    let nw = Math.max(0, f.design + d)
    // engineering prototype gate at 85%: needs real inputs and precise enough tools
    if (nw >= 0.85) {
      const reason = prototypeBlocker(w, cat, f, p)
      if (reason) {
        nw = Math.min(nw, 0.85)
        if (f.blocked !== reason)
          addEvent(w, "rd", `${f.name}'s ${g.name} prototype failed: ${reason}.`, {
            firm: f.id,
            good: f.good,
          })
        f.blocked = reason
      } else f.blocked = null
    }
    if (outcome === "setback" && f.design > 0.2 && random(rng) < 0.3)
      addEvent(
        w,
        "rd",
        `${f.name} hit unexpected problems developing ${g.name} (test results contradicted the ` +
          `design; progress ${pct0(f.design)} -> ${pct0(nw)}).`,
        { firm: f.id, good: f.good },
      )
    if (version2) {
      const cap = 1 - profile.tacit_share * (1 - corporateMaturity(f, cat, p))
      if (nw > cap && cap < 1) {
        nw = Math.max(f.design, cap)
        f.blocked = `organizational validation: ${corporate?.cycles.toFixed(1) ?? 0}/${profile.mastery_cycles} cycles (${profile.cycle_months} months per cycle at full capacity)`
      }
    }
    if (nw >= 1) {
      if (corporate) corporate.upgrade_cycle = corporate.cycles
      f.design = 1
      f.blocked = null
      f.gen = Math.max(0, physical.worldGeneration(w, cat, f.good) - 2)
      const first = !w.produced_ever.has(f.good)
      addEvent(
        w,
        first ? "invention" : "rd",
        `${f.name} can now reproduce ${g.name}${first ? " - a first for the country." : "."}`,
        { firm: f.id, good: f.good },
      )
    } else f.design = nw
  } else {
    // ---- improvement R&D: needs a working product line
    if (
      g.cat === "public" ||
      f.cum_output <= f.plan * 12 ||
      (corporate && corporate.cycles - corporate.upgrade_cycle < 1 - 1e-9)
    )
      return
    let ahead = f.gen - physical.worldGeneration(w, cat, f.good)
    // catching up to the frontier is far cheaper than pushing beyond it
    const need = ahead < 0 ? Math.max(D, 500) * 2 : Math.max(D, 2000) * 6 * 3 ** ahead
    if (random(rng) < Math.min(0.03, eff / need)) {
      f.gen += 1
      if (corporate) corporate.upgrade_cycle = corporate.cycles
      ahead = f.gen - physical.worldGeneration(w, cat, f.good)
      if (ahead >= 1)
        addEvent(
          w,
          "invention",
          `${f.name} improved ${g.name} beyond the world frontier (generation +${ahead}).`,
          { firm: f.id, good: f.good },
        )
      else if (random(rng) < 0.2)
        addEvent(w, "rd", `${f.name} released an improved ${g.name} design.`, {
          firm: f.id,
          good: f.good,
        })
    }
  }
}

export function prototypeBlocker(w: World, cat: Catalog, f: Firm, p: Process): string | null {
  const g = cat.goods[f.good]
  const year = yearOf(w)
  for (const [alts] of p.inputs) {
    if (p.optional.has(alts[0])) continue
    const ok = alts.some((a) => {
      const ga = cat.goods[a]
      return w.produced_ever.has(a) || (ga.year <= year && !ga.restricted && !ga.nt)
    })
    if (!ok) return `${cat.goods[alts[0]].name} is unobtainable (not made at home, not sold abroad)`
  }
  if (p.equip) {
    const ok = p.equip.some((a) => {
      const ga = cat.goods[a]
      return a in cat.endowments || w.produced_ever.has(a) || (ga.year <= year && !ga.restricted)
    })
    if (!ok) return `no access to ${cat.goods[p.equip[0]].name}`
    if (g.tol) {
      const best = Math.min(...p.equip.map((a) => cat.goods[a].prec || 1e9))
      if (best > g.tol * 4)
        return `available machines hold ${best}um but the design needs ${g.tol}um tolerances`
    }
  }
  if (g.clean && cat.goods[g.clean].year > year && !w.produced_ever.has(g.clean))
    return `needs a ${cat.goods[g.clean].name}`
  return null
}

/** On-the-job learning and unemployment skill loss. */
export function updateSkills(sim: Sim) {
  const w = sim.w
  const cat = sim.cat
  for (const p of w.persons.values()) {
    if (p.occ === null || p.school) continue
    const o = cat.occupations[p.occ]
    const cap = Math.min(1, 0.55 + 0.3 * p.h + 0.08 * Math.max(0, p.edu - o.edu))
    let s = p.skill[p.occ] ?? 0.1
    const fte = personFte(p)
    if (fte > 0) s += 0.012 * fte * Math.max(0, cap - s)
    else s -= 0.003 * s
    p.skill[p.occ] = s
  }
}
