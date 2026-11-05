/**
 * Births, deaths, schooling, university, career entry, migration, immigration.
 *
 * Fertility falls with income, urbanization and education (the demographic transition);
 * mortality falls with health spending; school enrollment is capped by teachers actually
 * employed in public schools; field-of-study choice responds to wages; graduates can emigrate
 * when domestic pay for their skills is far below world pay (brain drain).
 */
import { pick, random, uniform } from "./rng"
import type { Ctx, Sim } from "./sim"
import { monthOf, newPerson, type Person, personFte, type World } from "./world"

const SCHOOL_MONTH = 8 // September
const RURAL_OCCS = new Set(["farmer", "forester", "fisher", "miner"])
const SCHOOL_YEARS_BY_EDU = [0, 6, 12, 14, 16, 18]

/** Gompertz adult mortality + infant/child mortality, scaled by health access. */
export function annualMortality(ageY: number, health: number): number {
  let base = 0.00004 * Math.exp(0.088 * ageY)
  if (ageY < 1) base += 0.03
  else if (ageY < 5) base += 0.003
  // health: 0 (none) .. 1 (rich-country access)
  const mult = 0.45 + 1.6 * Math.exp(-2.5 * health)
  return Math.min(0.6, base * mult)
}

/** Schooling among women in the modeled childbearing cohort; general education for legacy worlds. */
export function fertilityEducation(w: World): number {
  if (w.mechanism_version !== 2) return w.stats.avg_school_years ?? 9
  let total = 0
  let count = 0
  for (const person of w.persons.values()) {
    if (person.sex === "female" && person.age >= 240 && person.age < 540) {
      total += person.school_years
      count++
    }
  }
  return count ? total / count : (w.stats.avg_school_years ?? 9)
}

export function fertility(w: World): number {
  const st = w.stats
  const inc = st.cons_pc_real ?? 600
  const urban = st.urbanization ?? 0.5
  const edu = fertilityEducation(w)
  let tfr = 1.35 + 5 * Math.exp(-inc / 700) * (1 - 0.35 * urban) * Math.max(0.3, 1 - 0.045 * edu)
  tfr += (0.25 * (w.policy.child_benefit ?? 0)) / 0.05
  return Math.max(0.9, Math.min(7.5, tfr))
}

export function step(sim: Sim, ctx: Ctx) {
  const w = sim.w
  const rng = w.rng
  const retAge = w.policy.retirement_age * 12
  const health = w.stats.health_access ?? 0.5
  const tfr = fertility(w)
  w.stats.tfr = tfr
  const birthP = tfr / (25 * 12) / (w.mechanism_version === 2 ? 1 : 2) // per woman, or legacy half-weighted adult
  let births = 0
  let deaths = 0
  const dead: Person[] = []
  const newborn: Person[] = []
  for (const p of w.persons.values()) {
    p.age += 1
    if (random(rng) < annualMortality(p.age / 12, health) / 12) {
      dead.push(p)
      continue
    }
    if (
      p.age >= 240 &&
      p.age < 540 &&
      (w.mechanism_version !== 2 || p.sex === "female") &&
      random(rng) < birthP
    )
      newborn.push(p)
    if (p.age === retAge && p.jobs.size) sim.quitAllJobs(p)
  }
  for (const p of dead) {
    die(sim, p)
    deaths += 1
  }
  for (const parent of newborn) {
    const c = newPerson(w, 0, parent.region)
    c.guardian = parent.id
    c.h = 0.15
    c.urban = parent.urban
    births += 1
  }
  ctx.stats.births = births * w.scale
  ctx.stats.deaths = deaths * w.scale
  if (monthOf(w) === SCHOOL_MONTH) schoolYear(sim)
  youthEntry(sim)
  if (monthOf(w) % 3 === 0) migration(sim, ctx)
  immigration(sim, ctx)
}

function die(sim: Sim, p: Person) {
  const w = sim.w
  sim.quitAllJobs(p)
  // bequest to children, else the guardian (inheritance keeps wealth in families)
  if (p.savings > 0) {
    let heirs = [...w.persons.values()].filter((q) => q.guardian === p.id)
    if (!heirs.length) {
      const heir = p.guardian !== null ? w.persons.get(p.guardian) : undefined
      heirs = heir ? [heir] : []
    }
    if (heirs.length) {
      const share = p.savings / heirs.length
      for (const h of heirs) h.savings += share
    } else {
      w.gov.cash += p.savings * w.scale // estate escheats to the state
      sim.ledger(`hh:${p.region}`, "gov", "estates", p.savings * w.scale)
    }
  }
  for (const q of w.persons.values()) if (q.guardian === p.id) q.guardian = null
  w.persons.delete(p.id)
}

/**
 * Advance a school year. Enrollment is limited by seats (teachers employed via public education
 * spending); quality by spending per student and teacher skill.
 */
function schoolYear(sim: Sim) {
  const w = sim.w
  const rng = w.rng
  const seats = w.stats.school_seats ?? {}
  const useats = w.stats.uni_seats ?? {}
  const quality = w.stats.school_quality ?? {}
  const students = new Map<number, number>()
  const tert = new Map<number, number>()
  for (const p of w.persons.values()) {
    if (p.school === "school") students.set(p.region, (students.get(p.region) ?? 0) + 1)
    else if (p.school === "voc" || p.school === "bach" || p.school === "grad")
      tert.set(p.region, (tert.get(p.region) ?? 0) + 1)
  }
  const ratio: Record<number, number> = {}
  const uratio: Record<number, number> = {}
  for (let r = 0; r < w.regions.length; r++) {
    ratio[r] = Math.min(1.2, (seats[r] ?? 0) / Math.max(1, (students.get(r) ?? 0) * w.scale))
    uratio[r] = Math.min(1.2, (useats[r] ?? 0) / Math.max(1, (tert.get(r) ?? 0) * w.scale))
  }
  w.stats.enroll_ratio = ratio
  w.stats.uni_ratio = uratio
  const med = w.stats.median_wage ?? 1000
  for (const p of Array.from(w.persons.values())) {
    const ay = p.age / 12
    if (p.school === null && ay >= 6 && ay < 7 && p.school_years === 0) p.school = "school"
    const r = p.region
    if (p.school === "school") {
      if (random(rng) < Math.min(1, (ratio[r] ?? 1) * 1.05)) {
        p.school_years += 1
        p.h = Math.min(1, p.h + 0.035 * (quality[r] ?? 0.6) + uniform(rng, -0.01, 0.015))
      }
      if (p.school_years >= 6 && p.edu < 1) p.edu = 1
      if (p.school_years >= 12) {
        p.edu = 2
        afterSecondary(sim, p)
        continue
      }
      // dropout: poverty and the pull of unskilled wages
      if (ay >= 14 && p.school_years >= 6) {
        const g = p.guardian !== null ? w.persons.get(p.guardian) : undefined
        const inc = g ? g.income_last : 0
        const poverty = Math.max(0, 1 - inc / Math.max(med, 1))
        const drop = 0.01 + 0.12 * poverty * (1.2 - (ratio[r] ?? 1))
        if (random(rng) < drop) {
          p.school = null
          w.stats.dropouts = (w.stats.dropouts ?? 0) + 1
        }
      }
    } else if (p.school === "voc" || p.school === "bach" || p.school === "grad") {
      if (random(rng) < Math.min(1, (uratio[r] ?? 1) * 1.1)) {
        p.school_years += 1
        p.h = Math.min(1, p.h + 0.03 * (quality[r] ?? 0.6) + uniform(rng, -0.01, 0.015))
        const target = { voc: 14, bach: 16, grad: 18 }[p.school]
        if (p.school_years >= target) {
          p.edu = { voc: 3, bach: 4, grad: 5 }[p.school]
          if (p.school === "bach" && random(rng) < 0.18 * p.h * (uratio[r] ?? 1)) p.school = "grad"
          else p.school = null
        }
      } else if (random(rng) < 0.15) p.school = null // gave up waiting for a seat
    }
  }
}

/** Choose vocational school, university (and field), or work. */
function afterSecondary(sim: Sim, p: Person) {
  const w = sim.w
  const cat = sim.cat
  const rng = w.rng
  const ur = w.stats.uni_ratio?.[p.region] ?? 0.8
  const g = p.guardian !== null ? w.persons.get(p.guardian) : undefined
  const afford = Math.min(
    1,
    0.3 + (g ? g.savings : 0) / Math.max((w.stats.median_wage ?? 1000) * 6, 1),
  )
  const pBach = Math.max(0, Math.min(0.85, (p.h - 0.35) * 1.4)) * Math.min(1, ur) * afford
  const pVoc = 0.35 * Math.min(1, ur + 0.2)
  const x = random(rng)
  const fw = w.policy.university_fields
  const fieldWeight = (f: string) => {
    let best = 0
    for (const [o, oc] of Object.entries(cat.occupations))
      if (oc.fields.includes(f)) best = Math.max(best, w.wage_index[o] ?? 0)
    return Math.max(0.01, fw[f] ?? 0.5) * (best / Math.max(w.stats.avg_wage ?? 1, 1)) ** 2
  }
  const fieldsAt = (lvl: number) =>
    Object.entries(cat.fields)
      .filter(([, [l]]) => l === lvl)
      .map(([f]) => f)
  if (x < pBach) {
    const fields = fieldsAt(4)
    p.field = pick(rng, fields, fields.map(fieldWeight))
    p.school = "bach"
  } else if (x < pBach + pVoc) {
    const fields = fieldsAt(3)
    p.field = pick(rng, fields, fields.map(fieldWeight))
    p.school = "voc"
  } else p.school = null
}

/**
 * Young people not in school join the labor force and pick an occupation. Adults move in and out
 * of the labor force: tight labor markets and low household income pull people in; long
 * unemployment discourages them.
 */
function youthEntry(sim: Sim) {
  const w = sim.w
  const rng = w.rng
  const u = w.stats.unemployment ?? 0.1
  let vac = 0
  for (const v of Object.values(w.stats.vacancies_by_occ ?? {})) vac += v
  const pull = 0.004 + 0.02 * Math.min(1, vac / 20) + (0.01 * Math.max(0, 0.08 - u)) / 0.08
  const med = w.stats.median_wage ?? 1000
  const ret = w.policy.retirement_age * 12
  for (const p of w.persons.values()) {
    if (p.school === null && p.occ === null && p.age >= 15 * 12 && p.age < ret) {
      chooseOccupation(sim, p)
      if (random(rng) < 0.15) p.inactive = true
    } else if (p.inactive && p.age < ret) {
      const poor = p.income_last < 0.4 * med ? 1 : 0
      if (random(rng) < pull + 0.01 * poor) p.inactive = false
    } else if (p.occ && !p.inactive && personFte(p) < 0.05 && p.unemp > 12 && p.age > 25 * 12) {
      if (random(rng) < 0.01 + 0.02 * Math.max(0, u - 0.1)) p.inactive = true
    }
  }
}

export function chooseOccupation(sim: Sim, p: Person) {
  const w = sim.w
  const cat = sim.cat
  const rng = w.rng
  let opts = sim.eligibleOccs(p.edu, p.field)
  if (!opts.length) opts = ["laborer"]
  const vac = w.stats.vacancies_by_occ ?? {}
  let best: [number, string] | null = null
  for (const o of opts) {
    const oc = cat.occupations[o]
    let score = (w.wage_index[o] ?? 500) * (1 + 2 * Math.min(1, (vac[o] ?? 0) / 5))
    score *= 1 + 0.4 * (oc.edu >= p.edu - 1 ? 1 : 0) // use your education
    score *= uniform(rng, 0.7, 1.3)
    if (best === null || score > best[0]) best = [score, o]
  }
  const occ = (best as [number, string])[1]
  p.occ = occ
  const o = cat.occupations[occ]
  p.skill[occ] = Math.max(
    p.skill[occ] ?? 0,
    Math.min(0.6, 0.08 + 0.35 * p.h + 0.08 * Math.max(0, p.edu - o.edu)),
  )
  p.urban = !RURAL_OCCS.has(occ)
}

function migration(sim: Sim, ctx: Ctx) {
  const w = sim.w
  const rng = w.rng
  const n = w.regions.length
  const regStats = w.stats.region
  if (!regStats || !Object.keys(regStats).length) return
  const attract: number[] = []
  for (let r = 0; r < n; r++) {
    const rs = regStats[r]
    const inc = (rs?.avg_wage ?? 1) * (1 - (rs?.unemployment ?? 0.1))
    const rent = Math.max(rs?.rent ?? 1, 1)
    const crowd = rs?.crowding ?? 2.6
    attract.push(inc / rent ** 0.35 / Math.max(1, crowd / 3) ** 0.5)
  }
  const movers: [Person, number][] = []
  for (const p of w.persons.values()) {
    if (p.age < 18 * 12 || p.age > 55 * 12 || p.school) continue
    const fte = personFte(p)
    if (fte > 0.6 && random(rng) > 0.15) continue
    const cur = attract[p.region]
    let best = 0
    let bestV = -Infinity
    for (let r = 0; r < n; r++) {
      const v = attract[r] / (1 + w.dist[p.region][r] / 2000)
      if (v > bestV) {
        bestV = v
        best = r
      }
    }
    if (best === p.region) continue
    const gain = Math.log(Math.max(attract[best], 1e-9) / Math.max(cur, 1e-9)) - 0.15
    if (gain > 0 && random(rng) < 0.06 * gain * (1.6 - fte)) movers.push([p, best])
  }
  for (const [p, r] of movers) {
    sim.quitAllJobs(p)
    p.region = r
    for (const q of w.persons.values()) if (q.guardian === p.id) q.region = r
    if (p.occ !== null && RURAL_OCCS.has(p.occ)) p.urban = true
  }
  ctx.stats.migrants = movers.length * w.scale
}

function immigration(sim: Sim, ctx: Ctx) {
  const w = sim.w
  const cat = sim.cat
  const rng = w.rng
  const S = w.scale
  w.stats.immig_acc = (w.stats.immig_acc ?? 0) + w.policy.skilled_immigration / 12 / S
  let nIn = 0
  const vac = w.stats.vacancies_by_occ ?? {}
  const skilled = Object.entries(cat.occupations)
    .filter(([, oc]) => oc.edu >= 3)
    .map(([o]) => o)
  while (w.stats.immig_acc >= 1) {
    w.stats.immig_acc -= 1
    const o = pick(
      rng,
      skilled,
      skilled.map((x) => (vac[x] ?? 0) + 0.3),
    )
    const oc = cat.occupations[o]
    let reg = 0
    let bestV = -Infinity
    for (let r = 0; r < w.regions.length; r++) {
      const v = (w.stats.region?.[r]?.avg_wage ?? 0) + random(rng)
      if (v > bestV) {
        bestV = v
        reg = r
      }
    }
    const p = newPerson(w, Math.trunc(uniform(rng, 25, 40) * 12), reg)
    p.edu = Math.max(oc.edu, 4)
    p.field = oc.fields.find((f) => f !== "*") ?? "business"
    p.school_years = SCHOOL_YEARS_BY_EDU[p.edu]
    p.h = uniform(rng, 0.6, 0.95)
    p.occ = o
    p.skill[o] = uniform(rng, 0.55, 0.85)
    p.immigrant = true
    p.savings = (w.stats.median_wage ?? 1000) * 2
    nIn += 1
  }
  // emigration of the highly skilled when world pay is far higher
  let out = 0
  const wl = w.stats.wage_level_vs_world ?? 1
  if (wl < 0.6) {
    for (const p of Array.from(w.persons.values())) {
      if (p.edu >= 4 && p.age > 22 * 12 && p.age < 45 * 12 && p.school === null) {
        if (random(rng) < ((0.0015 * (0.6 - wl)) / 0.6) * (2 - personFte(p))) {
          sim.quitAllJobs(p)
          for (const q of w.persons.values()) if (q.guardian === p.id) q.guardian = null
          w.persons.delete(p.id)
          out += 1
        }
      }
    }
  }
  ctx.stats.immigrants = nIn * S
  ctx.stats.emigrants = out * S
}
