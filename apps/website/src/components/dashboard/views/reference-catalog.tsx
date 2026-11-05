"use client"

import { useState } from "react"
import { Button } from "@website/components/ui/button"
import type { CatalogReferenceResponse } from "@econsim/engine/api"
import { useApi } from "../api"
import { ErrorCard, Loading } from "../common"
import { useDash } from "../state"

const categories = [
  ["goods", "Goods"],
  ["occupations", "Occupations"],
  ["knowledge", "Knowledge subjects"],
  ["processes", "Medical procedures"],
] as const
const sourceUrls = {
  goods: "https://www.usitc.gov/2026_hts_basic_edition",
  occupations: "https://www.dol.gov/agencies/oalj/topics/libraries/LIBDOT",
  knowledge: "https://www.nlm.nih.gov/databases/download/mesh.html",
  processes: "https://www.nlm.nih.gov/databases/download/mesh.html",
}
const PAGE_SIZE = 50

export function ReferenceCatalogView() {
  const { catalog } = useDash()
  const [kind, setKind] = useState<CatalogReferenceResponse["kind"]>("goods")
  const [query, setQuery] = useState("")
  const [offset, setOffset] = useState(0)
  const params = new URLSearchParams({
    kind,
    q: query,
    offset: String(offset),
    limit: String(PAGE_SIZE),
  })
  const result = useApi<CatalogReferenceResponse>(`/api/catalog/reference?${params}`)
  return (
    <>
      <p className="lead">
        Real-world reference entries, with source codes and definitions. These entries are awaiting
        economic modeling: they do not yet have production recipes, wages or research prerequisites
        and do not participate in simulation runs. The simulation-ready tab shows current model
        coverage.
      </p>
      <div className="card">
        <nav className="toolbar" aria-label="Reference category">
          {categories.map(([key, label]) => (
            <Button
              key={key}
              variant={kind === key ? "secondary" : "ghost"}
              aria-pressed={kind === key}
              onClick={() => {
                setKind(key)
                setOffset(0)
              }}
            >
              {label} ({catalog.reference.counts[key].toLocaleString("en-US")})
            </Button>
          ))}
        </nav>
        <p>
          Source: <a href={sourceUrls[kind]}>{catalog.reference.editions[kind]}</a>.
          {kind === "goods" &&
            " These are detailed trade commodity classifications; headings and special tariff provisions are excluded. This source covers goods, not services."}
          {kind === "occupations" &&
            " This is a historical 1991 classification, not a current employment survey. Alternate job titles are not counted as separate occupations."}
          {kind === "knowledge" &&
            " This source covers biomedical subjects. Its broader-subject links classify topics; they are not invention prerequisites."}
          {kind === "processes" &&
            " This source covers medical techniques and procedures, not industrial production recipes."}
        </p>
        <div className="toolbar">
          <input
            aria-label="Search reference catalog"
            placeholder="Search names, codes and definitions…"
            type="search"
            maxLength={200}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOffset(0)
            }}
          />
        </div>
        {result.error ? (
          <ErrorCard error={result.error} />
        ) : !result.data ? (
          <Loading />
        ) : (
          <>
            <output>
              {result.data.total.toLocaleString("en-US")} results
              {result.data.total > 0 &&
                ` · Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, result.data.total)}`}
            </output>
            <div className="scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Source code</th>
                    <th>Classification</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.name}</strong>
                        {row.description && (
                          <details>
                            <summary>Definition</summary>
                            <p>{row.description}</p>
                          </details>
                        )}
                        {row.parents.length > 0 && (
                          <small>Broader subjects: {row.parents.join(", ")}</small>
                        )}
                      </td>
                      <td>{row.code}</td>
                      <td>
                        {row.group}
                        {row.unit && <small> · Source units: {row.unit}</small>}
                      </td>
                    </tr>
                  ))}
                  {result.data.rows.length === 0 && (
                    <tr>
                      <td colSpan={3}>No matching entries.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <nav className="toolbar" aria-label="Reference catalog pages">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - PAGE_SIZE))
                }}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={offset + PAGE_SIZE >= result.data.total}
                onClick={() => {
                  setOffset(offset + PAGE_SIZE)
                }}
              >
                Next
              </Button>
            </nav>
          </>
        )}
      </div>
    </>
  )
}
