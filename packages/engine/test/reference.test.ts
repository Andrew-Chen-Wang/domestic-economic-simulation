import { describe, expect, it } from "vitest"
import { ApiError, catalog, catalogReference } from "../src/api"
import { getCatalog } from "../src/catalog"
import {
  referenceManifest,
  searchReference,
  type ReferenceEntry,
  type ReferenceKind,
} from "../src/catalog/reference"

async function all(kind: ReferenceKind) {
  // Read the packaged data directly for integrity checks; public responses stay bounded.
  const loaded = (await import(`../src/catalog/reference/${kind}.json`, {
    with: { type: "json" },
  })) as { default: ReferenceEntry[] }
  return loaded.default
}

describe("sourced detail catalog", () => {
  it("has distinct source identities and disjoint biomedical subject/procedure sets", async () => {
    const kinds = ["goods", "occupations", "knowledge", "processes"] as const
    const rows = (await Promise.all(kinds.map(all))).flat()
    expect(rows.length).toBe(63_500)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
    const ids = new Set(rows.map((r) => r.id))
    for (const row of rows) {
      expect(row.name.trim().length).toBeGreaterThan(0)
      for (const parent of row.parents) expect(ids.has(parent), `${row.id} -> ${parent}`).toBe(true)
    }
    expect(referenceManifest.counts.goods).toBeGreaterThanOrEqual(10_000)
    expect(referenceManifest.counts.occupations).toBeGreaterThanOrEqual(10_000)
  })

  it("excludes tariff provisions and preserves context for commodity leaves", async () => {
    const rows = await all("goods")
    expect(rows.every((r) => /^hts:\d{10}$/.test(r.id) && Number(r.code.slice(0, 2)) < 98)).toBe(
      true,
    )
    const horse = rows.find((r) => r.code === "0101.21.00.10")!
    expect(horse.name).toContain("horses")
    expect(horse.name).toContain("Males")
  })

  it("finds detailed occupations by code and does not promote aliases into occupations", async () => {
    const page = await searchReference({ kind: "occupations", q: "001.061-010" })
    expect(page.rows.some((r) => r.code === "001.061-010" && r.name.startsWith("ARCHITECT"))).toBe(
      true,
    )
    expect(page.rows.find((r) => r.code === "001.061-010")!.description).toContain(
      "building projects",
    )
    expect((await all("occupations")).every((r) => /^dot:\d{3}\.\d{3}-\d{3}$/.test(r.id))).toBe(
      true,
    )
  })

  it("searches case-insensitively with stable pagination and honest coverage", async () => {
    const first = await catalogReference({ kind: "knowledge", q: " DNA ", limit: 2 })
    const next = await catalogReference({ kind: "knowledge", q: "dna", offset: 2, limit: 2 })
    expect(first.status).toBe("reference")
    expect(first.total).toBeGreaterThan(4)
    expect(first.total).toBe(next.total)
    expect(first.rows).toHaveLength(2)
    expect(new Set([...first.rows, ...next.rows].map((r) => r.id)).size).toBe(4)
    expect((await searchReference({ q: "no-such-entry-xyz" })).rows).toEqual([])
    expect((await searchReference({ offset: 1_000_000 })).rows).toEqual([])
  })

  it("rejects invalid and unbounded queries", async () => {
    await Promise.all(
      [
        { kind: "__proto__" },
        { limit: 101 },
        { limit: 0 },
        { offset: -1 },
        { offset: 0.5 },
        { limit: NaN },
        { q: "x".repeat(201) },
      ].map((options) => expect(catalogReference(options)).rejects.toBeInstanceOf(ApiError)),
    )
  })

  it("does not replace model objects or send the reference corpus in startup data", async () => {
    const cat = getCatalog()
    const before = [Object.keys(cat.goods).length, Object.keys(cat.occupations).length]
    await Promise.all([
      searchReference({ kind: "occupations" }),
      searchReference({ kind: "goods" }),
    ])
    expect([Object.keys(cat.goods).length, Object.keys(cat.occupations).length]).toEqual(before)
    expect(before).toEqual([563, 43])
    const startup = catalog()
    expect(startup.reference.counts.goods).toBe(19_650)
    expect(startup.goods.every((r) => !r.id.startsWith("hts:"))).toBe(true)
    expect(JSON.stringify(startup).length).toBeLessThan(500_000)
  })
})
