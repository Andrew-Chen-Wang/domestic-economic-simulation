import { deserialize, serialize } from "node:v8"
import { describe, expect, it } from "vitest"
import { getCatalog } from "../src/catalog"
import { fertility, fertilityEducation, step as demographyStep } from "../src/demography"
import { firmRd } from "../src/knowledge-engine"
import { worldGeneration } from "../src/physical"
import { Ctx, Sim } from "../src/sim"
import {
  advanceCorporateExperience,
  corporateMaturity,
  processTechnology,
  portableDesignProgress,
  publicKnowledgeBoost,
  rankTechnology,
  seedCorporateExperience,
} from "../src/technology"
import { generate, newFirm, newPerson, newWorld } from "../src/world"

const cat = getCatalog()
const processFor = (good: string) => cat.procs[cat.goods[good].processes[0]]

describe("firm-specific organizational learning", () => {
  it("requires repeated calendar cycles even with unlimited research effort", () => {
    const w = newWorld()
    const p = processFor("chip_advanced")
    const f = newFirm(w, "Challenger", 0, p.good, p.id)
    f.design = 0
    const profile = processTechnology(cat, p)
    for (let month = 0; month < profile.cycle_months * profile.mastery_cycles - 1; month++) {
      w.tick = month
      advanceCorporateExperience(w, cat, f, 1e20, 0, true)
      // Even a second call in the same month cannot buy a second experiment.
      advanceCorporateExperience(w, cat, f, 1e20, 0, true)
    }
    expect(corporateMaturity(f, cat, p)).toBeLessThan(1)
    w.tick++
    advanceCorporateExperience(w, cat, f, 1e20, 0, true)
    expect(corporateMaturity(f, cat, p)).toBe(1)
  })

  it("retains firm memory when an expert moves and makes the rival validate its own process", () => {
    const w = newWorld()
    const p = processFor("cpu_gpu")
    const incumbent = newFirm(w, "Incumbent", 0, p.good, p.id)
    const entrant = newFirm(w, "Entrant", 0, p.good, p.id)
    seedCorporateExperience(w, cat, incumbent)
    const expert = newPerson(w, 360, 0)
    expert.occ = "process_engineer"
    expert.skill.process_engineer = 1
    incumbent.staff.set(expert.id, 1)
    incumbent.staff.delete(expert.id)
    entrant.staff.set(expert.id, 1)
    expect(expert.skill.process_engineer).toBe(1)
    expect(corporateMaturity(incumbent, cat, p)).toBe(1)
    expect(corporateMaturity(entrant, cat, p)).toBe(0)
    advanceCorporateExperience(w, cat, entrant, 1e20, 0, true)
    expect(corporateMaturity(entrant, cat, p)).toBeLessThan(0.1)
    expect(corporateMaturity(incumbent, cat, p)).toBe(1)
  })

  it("bounds the hiring shortcut even when many experienced employees join", () => {
    const w = newWorld()
    const p = processFor("chip_advanced")
    const entrant = newFirm(w, "Spinout", 0, p.good, p.id)
    entrant.design = 0
    for (let i = 0; i < 1000; i++) entrant.design = portableDesignProgress(cat, entrant, 1)
    expect(entrant.design).toBeGreaterThan(0)
    expect(entrant.design).toBeLessThanOrEqual(1 - processTechnology(cat, p).tacit_share)
    expect(corporateMaturity(entrant, cat, p)).toBe(0)
  })

  it("does not acquire experience by waiting or with missing validation inputs", () => {
    const w = newWorld()
    const p = processFor("battery_pack")
    const f = newFirm(w, "Idle lab", 0, p.good, p.id)
    for (let month = 0; month < 120; month++) {
      w.tick = month
      advanceCorporateExperience(w, cat, f, 0, 0, true)
    }
    expect(corporateMaturity(f, cat, p)).toBe(0)
    w.tick++
    advanceCorporateExperience(w, cat, f, 1e20, 1e20, false)
    expect(corporateMaturity(f, cat, p)).toBe(0)
  })

  it("limits imported know-how more strongly in tacit technologies and keeps histories per process", () => {
    const chip = processTechnology(cat, processFor("chip_advanced"))
    const theory = processTechnology(cat, { ...processFor("chip_advanced"), know: ["calculus"] })
    expect(publicKnowledgeBoost(chip, 1, 1)).toBeLessThan(publicKnowledgeBoost(theory, 1, 1))
    const w = newWorld()
    const p = processFor("chip_legacy")
    const f = newFirm(w, "Factory", 0, p.good, p.id)
    seedCorporateExperience(w, cat, f)
    f.proc = processFor("chip_advanced").id
    expect(corporateMaturity(f, cat, cat.procs[f.proc])).toBe(0)
    expect(corporateMaturity(f, cat, p)).toBe(1)
  })

  it("caps actual firm R&D despite experts, understood science and a domestic incumbent", () => {
    const w = generate("advanced_2025", 23, { agents: 200, regions: 2 })
    const p = processFor("cpu_gpu")
    const f = newFirm(w, "New competitor", 0, p.good, p.id)
    f.design = 0
    f.rd_share = 1
    f.plan = 1
    const expert = newPerson(w, 400, 0)
    expert.occ = "process_engineer"
    expert.skill.process_engineer = 1
    f.staff.set(expert.id, 1e10)
    for (const k of Object.keys(cat.knowledge)) w.knowledge[k] = 1
    for (const g of Object.keys(cat.goods)) w.produced_ever.add(g)
    const sim = new Sim(w)
    for (let month = 0; month < 12; month++) {
      w.tick = month
      firmRd(sim, new Ctx(), f)
    }
    expect(f.design).toBeLessThan(1)
    expect(corporateMaturity(f, cat, p)).toBeLessThan(1)
  })

  it("snapshots organizational learning and keeps advancing the advanced frontier", () => {
    const w = newWorld()
    const p = processFor("chip_advanced")
    const f = newFirm(w, "Lab", 0, p.good, p.id)
    advanceCorporateExperience(w, cat, f, 1e10, 0, true)
    const copy = deserialize(serialize(w)) as typeof w
    w.tick++
    copy.tick++
    advanceCorporateExperience(w, cat, f, 1e10, 0, true)
    advanceCorporateExperience(copy, cat, copy.firms.get(f.id)!, 1e10, 0, true)
    expect(copy.firms.get(f.id)!.capabilities).toEqual(f.capabilities)
    w.start_year = 2100
    expect(worldGeneration(w, cat, "chip_advanced")).toBeGreaterThan(8)
    delete w.mechanism_version
    expect(worldGeneration(w, cat, "chip_advanced")).toBe(8)
  })

  it("ranks every modeled node with finite, explicit assumptions", () => {
    for (const node of Object.values(cat.knowledge)) {
      const profile = rankTechnology(node)
      expect(profile.score).toBeGreaterThanOrEqual(0)
      expect(profile.score).toBeLessThanOrEqual(100)
      expect(profile.cycle_months).toBeGreaterThan(0)
      expect(profile.minimum_mastery_years).toBeGreaterThan(0)
      expect(profile.basis).toBe("model assumption")
    }
    expect(rankTechnology(cat.knowledge.euv_lithography).score).toBeGreaterThan(
      rankTechnology(cat.knowledge.li_ion_batteries).score,
    )
    expect(rankTechnology(cat.knowledge.jet_propulsion).minimum_mastery_years).toBeGreaterThan(
      rankTechnology(cat.knowledge.li_ion_batteries).minimum_mastery_years,
    )
  })
})

describe("population cohorts and demographic transition", () => {
  it("uses women's schooling for new worlds and can fall below replacement", () => {
    const w = newWorld()
    w.stats.cons_pc_real = 200
    w.stats.urbanization = 0.7
    const woman = newPerson(w, 360, 0)
    woman.sex = "female"
    woman.school_years = 0
    const before = fertility(w)
    woman.school_years = 18
    expect(fertilityEducation(w)).toBe(18)
    expect(fertility(w)).toBeLessThan(before)
    const man = newPerson(w, 360, 0)
    man.sex = "male"
    man.school_years = 0
    expect(fertilityEducation(w)).toBe(18)
    w.stats.cons_pc_real = 2500
    expect(fertility(w)).toBeLessThan(2.1)
    delete w.mechanism_version
    w.stats.avg_school_years = 8
    expect(fertilityEducation(w)).toBe(8)
  })

  it("allows population momentum before decline under sustained below-replacement fertility", () => {
    const w = newWorld()
    w.policy.skilled_immigration = 0
    w.stats.wage_level_vs_world = 1
    w.stats.cons_pc_real = 2500
    w.stats.urbanization = 1
    w.stats.health_access = 0.8
    for (let i = 0; i < 2000; i++) {
      const person = newPerson(w, 300 + (i % 240), 0)
      person.sex = i % 2 ? "female" : "male"
      person.school_years = 16
    }
    const sim = new Sim(w)
    let peak = w.persons.size
    for (let month = 1; month <= 160 * 12; month++) {
      w.tick = month
      demographyStep(sim, new Ctx())
      peak = Math.max(peak, w.persons.size)
      expect(w.stats.tfr).toBeLessThan(2.1)
    }
    expect(peak).toBeGreaterThan(2000)
    expect(w.persons.size).toBeLessThan(2000)
  })

  it("adds real birth cohorts without a 5000-agent cap and preserves population accounting", () => {
    const w = newWorld()
    w.regions = [{ id: 0 }] as typeof w.regions
    w.tick = 1 // skip quarterly migration and annual schooling in this isolated demographic step
    w.policy.skilled_immigration = 0
    w.stats.wage_level_vs_world = 1
    w.stats.cons_pc_real = 100
    w.stats.urbanization = 0.2
    for (let i = 0; i < 6000; i++) {
      const woman = newPerson(w, 360, 0)
      woman.sex = "female"
    }
    const before = w.persons.size
    const sim = new Sim(w)
    const ctx = new Ctx()
    demographyStep(sim, ctx)
    expect(ctx.stats.births).toBeGreaterThan(0)
    expect(w.persons.size).toBe(
      before + ((ctx.stats.births ?? 0) - (ctx.stats.deaths ?? 0)) / w.scale,
    )
    expect(w.persons.size).toBeGreaterThan(6000)
    expect(
      [...w.persons.values()]
        .filter((person) => person.age === 0)
        .every((person) => person.guardian !== null && person.sex !== undefined),
    ).toBe(true)
  })
})
