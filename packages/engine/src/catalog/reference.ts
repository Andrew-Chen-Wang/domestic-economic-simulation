/** Sourced detail awaiting economic modeling; never insert these records into World. */
import manifest from "./reference/manifest.json" with { type: "json" }

export type ReferenceKind = "goods" | "processes" | "knowledge" | "occupations"
export interface ReferenceEntry {
  id: string
  code: string
  name: string
  description: string
  group: string
  /** Subject classification links, NOT production inputs or research prerequisites. */
  parents: string[]
  unit?: string
  trees?: string[]
}
export const referenceManifest = manifest
const loaders: Record<ReferenceKind, () => Promise<{ default: ReferenceEntry[] }>> = {
  goods: () => import("./reference/goods.json", { with: { type: "json" } }),
  processes: () => import("./reference/processes.json", { with: { type: "json" } }),
  knowledge: () => import("./reference/knowledge.json", { with: { type: "json" } }),
  occupations: () => import("./reference/occupations.json", { with: { type: "json" } }),
}
const cache = new Map<ReferenceKind, Promise<{ row: ReferenceEntry; search: string }[]>>()
function entries(kind: ReferenceKind) {
  let pending = cache.get(kind)
  if (!pending) {
    pending = loaders[kind]().then(({ default: rows }) =>
      rows.map((row) => ({
        row,
        search: `${row.code} ${row.name} ${row.description}`.toLowerCase(),
      })),
    )
    cache.set(kind, pending)
    // Permit retry after a transient module-load failure.
    void pending.catch(() => cache.delete(kind))
  }
  return pending
}

/** Bounded pages; no world creation, SQLite writes or full-catalog response. */
export async function searchReference(
  options: {
    kind?: string | null
    q?: string | null
    offset?: number
    limit?: number
  } = {},
) {
  const kind = options.kind ?? "goods"
  if (!(kind === "goods" || kind === "processes" || kind === "knowledge" || kind === "occupations"))
    throw new Error("unknown reference category")
  const offset = options.offset ?? 0
  const limit = options.limit ?? 50
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("offset must be nonnegative and limit must be between 1 and 100")
  const query = (options.q ?? "").trim()
  if (query.length > 200) throw new Error("reference search is limited to 200 characters")
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const indexed = await entries(kind)
  const matches = terms.length
    ? indexed.filter((entry) => terms.every((term) => entry.search.includes(term)))
    : indexed
  return {
    kind: kind as ReferenceKind,
    edition: manifest.editions[kind],
    status: "reference" as const,
    counts: manifest.counts,
    total: matches.length,
    offset,
    limit,
    rows: matches.slice(offset, offset + limit).map(({ row }) => row),
  }
}
export type ReferenceResponse = Awaited<ReturnType<typeof searchReference>>
