/**
 * Technology-specific organizational learning. Parameters are transparent scenario assumptions,
 * not measured country rankings or forecasts. Public science is deliberately separate from a
 * firm's accumulated test history. No employee carries this state when changing employers.
 */
import type { Catalog, KnowledgeNode, Process } from "./catalog"
import type { Firm, World } from "./world"

export interface TechnologyProfile {
  /** Fraction of know-how tied to routines, tooling, teams and validation rather than documents. */
  tacit_share: number
  /** Calendar time per sequential build/test/feedback loop at adequate staffing and tools. */
  cycle_months: number
  /** Successful-equivalent cycles to reproduce a reliable commercial process from a cold start. */
  mastery_cycles: number
  /** Years per world-frontier design generation; null means the legacy mature-sector schedule. */
  frontier_years: number | null
}

const overrides: Record<string, TechnologyProfile> = {
  internal_combustion: {
    tacit_share: 0.85,
    cycle_months: 9,
    mastery_cycles: 12,
    frontier_years: 8,
  },
  diesel_engine: { tacit_share: 0.88, cycle_months: 12, mastery_cycles: 12, frontier_years: 8 },
  jet_propulsion: { tacit_share: 0.95, cycle_months: 18, mastery_cycles: 12, frontier_years: 6 },
  superalloys: { tacit_share: 0.93, cycle_months: 12, mastery_cycles: 10, frontier_years: 6 },
  gas_turbine_cc: { tacit_share: 0.92, cycle_months: 15, mastery_cycles: 10, frontier_years: 6 },
  li_ion_batteries: { tacit_share: 0.85, cycle_months: 6, mastery_cycles: 12, frontier_years: 3 },
  semiconductor_materials: {
    tacit_share: 0.92,
    cycle_months: 9,
    mastery_cycles: 12,
    frontier_years: 3,
  },
  cmos: { tacit_share: 0.93, cycle_months: 9, mastery_cycles: 12, frontier_years: 2 },
  photolithography: { tacit_share: 0.9, cycle_months: 9, mastery_cycles: 10, frontier_years: 3 },
  duv_lithography: { tacit_share: 0.95, cycle_months: 12, mastery_cycles: 12, frontier_years: 2 },
  finfet: { tacit_share: 0.96, cycle_months: 12, mastery_cycles: 14, frontier_years: 2 },
  euv_lithography: { tacit_share: 0.98, cycle_months: 18, mastery_cycles: 16, frontier_years: 2 },
  microprocessors: { tacit_share: 0.85, cycle_months: 12, mastery_cycles: 8, frontier_years: 2 },
  nuclear_power: { tacit_share: 0.94, cycle_months: 24, mastery_cycles: 10, frontier_years: 10 },
}

export function technologyProfile(node: KnowledgeNode): TechnologyProfile {
  const explicit = overrides[node.id]
  if (explicit) return explicit
  const complexity = Math.max(0, Math.log10(Math.max(1, node.diff) / 40))
  return {
    tacit_share: node.kind === "sci" ? 0.2 : node.kind === "eng" ? 0.65 : 0.75,
    cycle_months: Math.max(1, Math.round(1 + complexity * 2)),
    mastery_cycles: Math.max(2, Math.round(2 + complexity * 2)),
    frontier_years: null,
  }
}

/** The slowest technique is the process's organizational bottleneck, not an average. */
export function processTechnology(cat: Catalog, p: Process): TechnologyProfile {
  let result: TechnologyProfile = {
    tacit_share: 0.25,
    cycle_months: 1,
    mastery_cycles: 2,
    frontier_years: null,
  }
  let longest = 0
  for (const id of p.know) {
    const profile = technologyProfile(cat.knowledge[id])
    const duration = profile.cycle_months * profile.mastery_cycles
    if (duration > longest) {
      result = profile
      longest = duration
    }
  }
  if (p.trad)
    return {
      ...result,
      cycle_months: Math.min(3, result.cycle_months),
      mastery_cycles: Math.min(4, result.mastery_cycles),
      frontier_years: null,
    }
  return result
}

export function rankTechnology(node: KnowledgeNode) {
  const profile = technologyProfile(node)
  const years = (profile.cycle_months * profile.mastery_cycles) / 12
  // A display index only: log scale preserves differences without presenting years as certainty.
  const score = Math.round(
    Math.min(
      100,
      30 * Math.log10(1 + years) + 25 * profile.tacit_share + 5 * Math.log10(1 + node.diff / 100),
    ),
  )
  return { ...profile, score, minimum_mastery_years: years, basis: "model assumption" as const }
}

export function corporateMaturity(f: Firm, cat: Catalog, p: Process): number {
  return Math.min(
    1,
    (f.capabilities?.[p.id]?.cycles ?? 0) / processTechnology(cat, p).mastery_cycles,
  )
}

/** A hire can transfer a bounded codified contribution, never the employer's test history. */
export function portableDesignProgress(cat: Catalog, f: Firm, skill: number): number {
  const p = cat.procs[f.proc]
  const profile = processTechnology(cat, p)
  const ceiling = 1 - profile.tacit_share * (1 - corporateMaturity(f, cat, p))
  return Math.max(
    f.design,
    Math.min(
      0.95,
      ceiling,
      f.design + 0.08 * (1 - profile.tacit_share) * Math.max(0, Math.min(1, skill)),
    ),
  )
}

/** Explicit prehistory for seeded incumbent firms, never for entrants or new employees. */
export function seedCorporateExperience(w: World, cat: Catalog, f: Firm) {
  if (w.mechanism_version !== 2) return
  const profile = processTechnology(cat, cat.procs[f.proc])
  const cycles = Math.min(profile.mastery_cycles, (25 * 12) / profile.cycle_months)
  f.capabilities = { [f.proc]: { cycles, progress: 0, last_tick: -1, upgrade_cycle: cycles } }
}

/**
 * At most one month of sequential experiment time per calendar month. Staffing helps up to
 * the reference-team requirement; additional talent cannot buy future test results instantly.
 * No trial credit accrues when materials/science are unavailable or nobody runs the process.
 */
export function advanceCorporateExperience(
  w: World,
  cat: Catalog,
  f: Firm,
  researchPy: number,
  output: number,
  validationPossible: boolean,
) {
  const p = cat.procs[f.proc]
  const profile = processTechnology(cat, p)
  const states = (f.capabilities ??= {})
  const state = (states[p.id] ??= { cycles: 0, progress: 0, last_tick: -1, upgrade_cycle: 0 })
  if (state.last_tick === w.tick) return state
  state.last_tick = w.tick
  const referenceEffort = Math.max(
    0.25,
    p.design_effort / (profile.cycle_months * profile.mastery_cycles),
  )
  const research = Math.min(1, Math.max(0, researchPy) / referenceEffort)
  const production = Math.min(1, Math.max(0, output) / Math.max(f.plan, 1e-9))
  const active = validationPossible ? Math.max(research, production) : 0
  // Loss of routines during inactivity is slow and firm-local. Public science is unaffected.
  if (active <= 0) {
    state.cycles = Math.max(0, state.cycles * 0.999)
    return state
  }
  state.progress += active / profile.cycle_months
  const completed = Math.floor(state.progress + 1e-10)
  state.progress = Math.max(0, state.progress - completed)
  state.cycles += completed
  return state
}

/** Publication and imported examples help most in codified fields. */
export function publicKnowledgeBoost(
  profile: TechnologyProfile,
  transparency: number,
  understanding: number,
) {
  return (
    1 +
    (1 - profile.tacit_share) *
      3 *
      Math.max(0, Math.min(1, transparency)) *
      Math.max(0, Math.min(1, understanding)) ** 2
  )
}
