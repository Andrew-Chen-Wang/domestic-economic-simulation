import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deserialize, serialize } from "node:v8"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getCatalog } from "../src/catalog"
import { createWorldSync, Engine } from "../src/engine"
import * as physical from "../src/physical"
import { applyPatch, defaultPolicy } from "../src/policy"
import { random } from "../src/rng"
import { Sim } from "../src/sim"
import { generate, type World } from "../src/world"

const CAT = getCatalog()

describe("catalog", () => {
  it("has no dangling references", () => {
    expect(CAT.errors).toEqual([])
  })

  it("makes everything eventually possible", () => {
    expect(Object.values(CAT.goods).filter((g) => g.year > 3000)).toEqual([])
  })

  it("derives availability from the supply chain", () => {
    // leading-edge chips need EUV scanners, which need EUV know-how (2019)
    expect(CAT.goods.chip_advanced.year).toBeGreaterThanOrEqual(2019)
    expect(CAT.goods.smartphone.year).toBeGreaterThanOrEqual(2007)
    expect(CAT.goods.bread_bakery.year).toBeLessThan(0)
    // a product can never predate the knowledge it requires
    for (const p of Object.values(CAT.procs))
      for (const k of p.know) expect(p.year, p.id).toBeGreaterThanOrEqual(CAT.kyear[k])
  })

  it("has frontier processes that cover their costs", () => {
    for (const g of Object.values(CAT.goods)) {
      if (g.endowment || !g.processes.length) continue
      const p = CAT.procs[g.processes[0]]
      if (p.trad) continue
      expect(p.unit_cost_ref, g.id).toBeLessThanOrEqual(g.price * 1.001 + 1e-9)
    }
  })
})

describe("physical", () => {
  it("gates yield on precision", () => {
    expect(physical.precisionYield(10, 5, 0.5)).toBe(1)
    expect(physical.precisionYield(10, 100, 0)).toBe(0)
    const mid = physical.precisionYield(10, 25, 0)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })

  it("cannot make semiconductors in 1850", () => {
    const w = generate("agrarian_1850", 1)
    const sim = new Sim(w)
    for (const gid of ["chip_legacy", "smartphone", "jet_engine"]) {
      const ok = CAT.goods[gid].processes.some((p) => sim.processFeasible(CAT.procs[p])[0])
      expect(ok, gid).toBe(false)
      expect(CAT.worldPrice(gid, w.start_year), gid).toBeNull()
    }
  })
})

describe("simulation", () => {
  let base: World
  beforeAll(() => {
    base = createWorldSync("emerging_2025", 3, 6)
  })

  it("replays deterministically from a snapshot", () => {
    const blob = serialize(base)
    const out = [0, 1].map(() => {
      const w = deserialize(blob) as World
      const s = new Sim(w)
      let m = s.step()[1]
      for (let i = 0; i < 3; i++) m = s.step()[1]
      return [m.gdp, m.firms, random(w.rng)]
    })
    expect(out[0]).toEqual(out[1])
  })

  it("keeps a sane ledger and metrics", () => {
    const w = structuredClone(base)
    const [ctx, m] = new Sim(w).step()
    expect(m.gdp).toBeGreaterThan(0)
    expect(m.unemployment).toBeGreaterThanOrEqual(0)
    expect(m.unemployment).toBeLessThan(1)
    const kinds = new Set([...ctx.ledgerEntries()].map(([, , k]) => k))
    for (const k of ["wages", "consumption", "income tax", "VAT", "sales"])
      expect(kinds).toContain(k)
    let wages = 0
    for (const [, , k, v] of ctx.ledgerEntries()) if (k === "wages") wages += v
    expect(Math.abs(wages - ctx.stats.wage_bill)).toBeLessThan(wages * 1e-6 + 1)
  })
})

describe("engine", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "econsim-"))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("shares history between branches", async () => {
    const e = new Engine(join(dir, "t.db"))
    const tid = await e.createNow("emerging_2025", 5, null, 4)
    await e.runNow(tid, 8)
    const r = e.applyPolicy(tid, { vat: 0.25 }, "VAT up", 4)
    expect(r.branched).toBe(true)
    const child = r.timeline
    await e.runNow(child, 4)
    const a = e.store.series(tid, ["gdp"])
    const b = e.store.series(child, ["gdp"])
    expect(a.slice(0, 4).map((x) => x.gdp)).toEqual(b.slice(0, 4).map((x) => x.gdp))
    expect(a[6].gdp).not.toEqual(b[6].gdp)
    expect(e.worldAt(child, 8).policy.vat).toBe(0.25)
    // replaying the parent from its snapshot reproduces the cached head
    e.cache.clear()
    const replayed = e.worldAt(tid, 6)
    expect(replayed.tick).toBe(6)
  })

  it("merges policy patches", () => {
    const p = applyPatch(defaultPolicy(), { subsidies_consumer: { electric_car: 0.3 }, vat: 0.2 })
    expect(p.vat).toBe(0.2)
    expect(p.subsidies_consumer.electric_car).toBe(0.3)
    const p2 = applyPatch(p, { subsidies_consumer: { electric_car: null } })
    expect("electric_car" in p2.subsidies_consumer).toBe(false)
  })
})
