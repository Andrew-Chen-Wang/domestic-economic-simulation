/** Rebuild the checked-in reference catalog. Run with mise exec -- pnpm exec tsx packages/engine/scripts/import-reference.ts [cache directory]. */
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cache = process.argv[2] ?? join(tmpdir(), "econsim-catalog-sources")
const output = new URL("../src/catalog/reference/", import.meta.url)
mkdirSync(cache, { recursive: true })
mkdirSync(output, { recursive: true })
const sources: { file: string; url: string; sha256: string }[] = []
async function download(file: string, url: string) {
  const path = join(cache, file)
  if (!existsSync(path)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
    writeFileSync(path, Buffer.from(await response.arrayBuffer()))
  }
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  sources.push({ file, url, sha256: hash.digest("hex") })
  return path
}
function text(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) =>
      String.fromCodePoint(n.startsWith("x") ? Number.parseInt(n.slice(1), 16) : Number(n)),
    )
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp|ndash|mdash);/g,
      (_, key: string) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" })[
          key
        ]!,
    )
    .replace(/\s+/g, " ")
    .trim()
}
type Row = {
  id: string
  code: string
  name: string
  description: string
  group: string
  parents: string[]
  unit?: string
  trees?: string[]
}
function save(name: string, rows: Row[]) {
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error(`${name}: duplicate IDs`)
  if (rows.some((r) => !r.name || !r.code)) throw new Error(`${name}: missing identity`)
  writeFileSync(new URL(`${name}.json`, output), `${JSON.stringify(rows, null, 2)}\n`)
  console.log(`${name}: ${rows.length}`)
}

// Only 10-digit statistical commodity lines in chapters 01–97. Do not count headings,
// intermediate subtotals, tariff-treatment provisions (98/99), or aliases as products.
const hts = await download(
  "hts.json",
  "https://www.usitc.gov/sites/default/files/tata/hts/hts_2026_basic_edition_json.json",
)
const goods: Row[] = []
const stack: string[] = []
for (const row of JSON.parse(readFileSync(hts, "utf8")) as {
  htsno: string
  indent: string
  description: string
  units: string[]
}[]) {
  const depth = Number(row.indent)
  stack.length = depth
  stack[depth] = text(row.description).replace(/:$/, "")
  const code = row.htsno.replace(/\D/g, "")
  if (code.length !== 10 || Number(code.slice(0, 2)) >= 98) continue
  goods.push({
    id: `hts:${code}`,
    code: row.htsno,
    name: stack.filter(Boolean).join(" / "),
    description: "",
    group: `HTS ${code.slice(0, 2)}`,
    parents: [],
    unit: row.units.join(", "),
  })
}
if (goods.length < 10_000) throw new Error("Incomplete HTS import")
save("goods", goods)

// DOT codes identify detailed occupational definitions. Alternate titles remain in the
// definition; they are not separate jobs. Keep its 1991 vintage explicit in the manifest.
const dotIndex = await download(
  "dot-index.html",
  "https://www.dol.gov/agencies/oalj/topics/libraries/LIBDOT",
)
const pages = [
  ...new Set(
    [
      ...readFileSync(dotIndex, "utf8").matchAll(
        /href="(\/agencies\/oalj\/PUBLIC\/DOT\/REFERENCES\/DOT\d\d[A-Z])"/g,
      ),
    ].map((m) => m[1]),
  ),
].toSorted()
const occupations: Row[] = []
for (const page of pages) {
  // Fetch historical pages sequentially to keep request pressure on the DOL archive low.
  // eslint-disable-next-line no-await-in-loop
  const path = await download(`${page.split("/").at(-1)}.html`, `https://www.dol.gov${page}`)
  const html = readFileSync(path, "utf8")
  for (const match of html.matchAll(
    /<p[^>]*>\s*<strong[^>]*>\s*(\d{3}\.\d{3}-\d{3})\s+([\s\S]*?)<\/strong>\s*<\/p>\s*<dl[^>]*>([\s\S]*?)<\/dl>/gi,
  )) {
    const heading = text(match[2])
    const name = heading.split(/\s+alternate titles:/i)[0]
    occupations.push({
      id: `dot:${match[1]}`,
      code: match[1],
      name,
      description: text(match[3]),
      group: `DOT ${match[1].slice(0, 3)}`,
      parents: [],
    })
  }
}
if (occupations.length < 10_000) throw new Error(`Incomplete DOT import: ${occupations.length}`)
save("occupations", occupations)

// MeSH is a subject taxonomy, not an invention dependency graph. E-tree subjects are
// medical techniques/procedures; the remaining descriptors are knowledge subjects.
const mesh = await download(
  "mesh.xml",
  "https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/desc2026.xml",
)
const descriptors: Row[] = []
let pending = ""
for await (const chunk of createReadStream(mesh, { encoding: "utf8" })) {
  if (typeof chunk !== "string") throw new Error("Expected UTF-8 source text")
  pending += chunk
  let end: number
  while ((end = pending.indexOf("</DescriptorRecord>")) >= 0) {
    const record = pending.slice(0, end)
    pending = pending.slice(end + "</DescriptorRecord>".length)
    const code = /<DescriptorUI>(.*?)<\/DescriptorUI>/.exec(record)?.[1]
    const name = /<DescriptorName>\s*<String>([\s\S]*?)<\/String>/.exec(record)?.[1]
    if (!code || !name) throw new Error("Malformed MeSH descriptor")
    const trees = [...record.matchAll(/<TreeNumber>(.*?)<\/TreeNumber>/g)].map((m) => m[1])
    descriptors.push({
      id: `mesh:${code}`,
      code,
      name: text(name),
      description: text(/<ScopeNote>([\s\S]*?)<\/ScopeNote>/.exec(record)?.[1] ?? ""),
      group: trees.some((t) => t.startsWith("E"))
        ? "Medical techniques and procedures"
        : "Biomedical knowledge",
      parents: [],
      trees,
    })
  }
}
const byTree = new Map(descriptors.flatMap((r) => r.trees!.map((t) => [t, r.id] as const)))
for (const row of descriptors) {
  row.parents = [
    ...new Set(
      row.trees!.flatMap((t) => {
        const parent = byTree.get(t.slice(0, t.lastIndexOf(".")))
        return parent && parent !== row.id ? [parent] : []
      }),
    ),
  ].toSorted()
}
const procedures = descriptors.filter((r) => r.trees!.some((t) => t.startsWith("E")))
const knowledge = descriptors.filter((r) => !r.trees!.some((t) => t.startsWith("E")))
if (descriptors.length < 30_000) throw new Error("Incomplete MeSH import")
save("knowledge", knowledge)
save("processes", procedures)
writeFileSync(
  new URL("manifest.json", output),
  `${JSON.stringify({ schema: 1, editions: { goods: "USITC HTS 2026 Basic Edition", occupations: "US DOL DOT, fourth edition revised 1991 (historical)", knowledge: "NLM MeSH 2026 descriptors", processes: "NLM MeSH 2026 E-tree descriptors (medical techniques and procedures)" }, counts: { goods: goods.length, occupations: occupations.length, knowledge: knowledge.length, processes: procedures.length }, sources }, null, 2)}\n`,
)
