"use client"

import { useState } from "react"
import { type CatalogGoodResponse, type GoodResponse, type GoodsResponse, useApi } from "../api"
import { LineChart } from "../charts"
import { Card, ErrorCard, Level, Loading, markers, OkBadge, Th } from "../common"
import { fmtMoney, fmtNum, fmtPct, fmtYearBC } from "../format"
import { useDash } from "../state"

type Row = GoodsResponse["goods"][number] & {
  dom_value: number
  out_value: number
  imp_share: number
}
type SortKey =
  | "name"
  | "sector"
  | "price"
  | "out_value"
  | "dom_value"
  | "import_value"
  | "export_value"
  | "imp_share"
  | "producers"

export function ProductsView() {
  const d = useDash()
  const r = useApi<GoodsResponse>(`/api/timelines/${d.tid}/goods?tick=${d.cursor}&v=${d.version}`)
  const [q, setQ] = useState("")
  const [sector, setSector] = useState("")
  const [made, setMade] = useState("")
  const [sort, setSort] = useState<SortKey>("dom_value")
  if (r.error) return <ErrorCard error={r.error} />
  if (!r.data) return <Loading />
  const rows: Row[] = r.data.goods.map((g) => ({
    ...g,
    dom_value: g.dom_sold * g.price,
    out_value: g.output * g.price,
    imp_share: g.import_value / Math.max(1e-9, g.import_value + g.dom_sold * g.price),
  }))
  const sectors = [...new Set(rows.map((x) => x.sector))].filter(Boolean).toSorted()
  let list = rows.filter(
    (x) =>
      (!q || x.name.toLowerCase().includes(q.toLowerCase())) && (!sector || x.sector === sector),
  )
  if (made === "dom") list = list.filter((x) => x.producers > 0)
  else if (made === "imp") list = list.filter((x) => !x.producers && x.imports > 0)
  list = list.toSorted((a, b) => {
    const av = a[sort]
    const bv = b[sort]
    return typeof av === "number" && typeof bv === "number"
      ? bv - av
      : String(av).localeCompare(String(bv))
  })
  const cols: [SortKey, string, boolean?][] = [
    ["name", "Product"],
    ["sector", "Sector"],
    ["price", "Price", true],
    ["out_value", "Domestic output", true],
    ["dom_value", "Domestic sales", true],
    ["import_value", "Imports", true],
    ["export_value", "Exports", true],
    ["imp_share", "Import share", true],
    ["producers", "Firms", true],
  ]
  return (
    <>
      <h1>Products &amp; capabilities</h1>
      <p className="lead">
        Everything traded in {d.axis.tickLabel(d.cursor)}. Click a product to see <b>why</b> the
        country can or cannot make it - the scientific, engineering, manufacturing and economic
        layers, all the way down the supply chain.
      </p>
      <div className="card">
        <div className="toolbar">
          <input
            type="text"
            aria-label="Search products"
            placeholder="Search products…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
            }}
          />
          <select
            aria-label="Sector"
            value={sector}
            onChange={(e) => {
              setSector(e.target.value)
            }}
          >
            <option value="">All sectors</option>
            {sectors.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select
            aria-label="Made where"
            value={made}
            onChange={(e) => {
              setMade(e.target.value)
            }}
          >
            <option value="">Made here or imported</option>
            <option value="dom">Made domestically</option>
            <option value="imp">Only imported</option>
          </select>
          <span className="muted">{list.length} products</span>
        </div>
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                {cols.map(([k, l, num]) => (
                  <Th key={k} k={k} label={l} num={num} sort={sort} setSort={setSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 400).map((x) => (
                <tr
                  key={x.good}
                  className="clickable"
                  onClick={() => {
                    d.go("product", x.good)
                  }}
                >
                  <td>
                    {x.name} <span className="muted">/{x.unit}</span>
                  </td>
                  <td>{x.sector}</td>
                  <td className="num">{fmtMoney(x.price)}</td>
                  <td className="num">{fmtMoney(x.out_value)}</td>
                  <td className="num">{fmtMoney(x.dom_value)}</td>
                  <td className="num">{fmtMoney(x.import_value)}</td>
                  <td className="num">{fmtMoney(x.export_value)}</td>
                  <td className="num">{fmtPct(x.imp_share, 0)}</td>
                  <td className="num">{x.producers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

const LAYER = {
  scientific: "Scientific feasibility - is the science understood?",
  engineering: "Engineering feasibility - can anyone here design it?",
  manufacturing: "Manufacturing feasibility - machines, precision, inputs, sites, skilled people",
  economic: "Economic viability - can it be made cheaper than importing?",
}

type Supply =
  GoodResponse["explain"]["processes"][number]["layers"]["manufacturing"]["supplies"][number]

function SupplyChip({ s }: { s: Supply }) {
  const d = useDash()
  const where = s.domestic
    ? `${s.domestic} domestic maker(s)`
    : s.endowment
      ? "natural endowment"
      : s.importable
        ? "import only"
        : s.restricted
          ? "export-controlled abroad"
          : `not available (world: ${s.world_year > 3000 ? "never" : fmtYearBC(s.world_year)})`
  return (
    <button
      type="button"
      className={`chip ${s.ok ? "ok" : s.optional ? "opt" : "no"}`}
      title={(s.alternatives ?? []).join(" / ")}
      onClick={() => {
        d.go("product", s.id)
      }}
    >
      {s.role === "input" ? "" : "⚙ "}
      {s.name}
      {s.qty ? ` ×${fmtNum(s.qty)}` : ""} · {where}
      {s.precision_um && !s.precision_ok ? " · precision too coarse" : ""}
      {s.optional ? " · optional upgrade" : ""}
    </button>
  )
}

export function ProductView() {
  const d = useDash()
  const gid = d.productId ?? ""
  const g = d.by.goods[gid]
  const r = useApi<GoodResponse>(
    `/api/timelines/${d.tid}/good/${gid}?tick=${d.cursor + 1}&v=${d.version}`,
  )
  const rec = useApi<CatalogGoodResponse>(`/api/catalog/good/${gid}`)
  if (r.error ?? rec.error) return <ErrorCard error={(r.error ?? rec.error)!} />
  if (!r.data || !rec.data || !g)
    return (
      <Loading
        what={`Analyzing ${g?.name ?? gid}… (reconstructing the economy at ${d.axis.tickLabel(d.cursor + 1)})`}
      />
    )
  const ex = r.data.explain
  const ser = r.data.series
  const ax = d.axis
  const chip = (x: { id: string; name: string }) => (
    <button
      type="button"
      key={x.id}
      className="chip"
      onClick={() => {
        d.go("product", x.id)
      }}
    >
      {x.name}
    </button>
  )
  return (
    <>
      <div className="toolbar">
        <button
          type="button"
          className="small"
          onClick={() => {
            d.go("products")
          }}
        >
          ← Products
        </button>
      </div>
      <h1>{ex.name}</h1>
      <p className="lead">
        {g.sector} · unit: {g.unit} · first possible anywhere:{" "}
        {ex.world_year > 3000 ? "never" : fmtYearBC(ex.world_year)}
        {ex.restricted ? (
          <>
            {" "}
            · <b>export-controlled</b>: foreign makers will not sell it
          </>
        ) : null}
        .{" "}
        {ex.producers.length
          ? `Made here by ${ex.producers.length} firm(s).`
          : "Not currently made in this country."}
      </p>
      <div className="grid g2">
        <Card title="Price">
          {ser.length ? (
            <LineChart
              series={[{ name: "Price", points: ser.map((x) => [x.tick, x.price]) }]}
              xfmt={ax.xfmt}
              xticks={ax.xticks}
              yfmt={fmtMoney}
              markers={markers(d.policyEvents)}
              height={200}
            />
          ) : (
            <div className="muted">Never traded in this economy so far.</div>
          )}
        </Card>
        <Card title="Domestic output vs imports vs exports" sub="units / month">
          {ser.length > 0 && (
            <LineChart
              series={[
                { name: "Domestic output", points: ser.map((x) => [x.tick, x.output]) },
                { name: "Imports", points: ser.map((x) => [x.tick, x.imports]) },
                { name: "Exports", points: ser.map((x) => [x.tick, x.exports]) },
              ]}
              xfmt={ax.xfmt}
              xticks={ax.xticks}
              yfmt={fmtNum}
              markers={markers(d.policyEvents)}
              height={200}
            />
          )}
        </Card>
      </div>
      {ex.producers.length > 0 && (
        <Card title="Domestic producers" style={{ marginTop: 12 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Firm</th>
                <th>Region</th>
                <th className="num">Output</th>
                <th className="num">Design</th>
                <th className="num">Generation</th>
                <th className="num">Quality</th>
                <th>Constraint</th>
              </tr>
            </thead>
            <tbody>
              {ex.producers.map((f) => (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td>{f.region}</td>
                  <td className="num">{fmtNum(f.output)}</td>
                  <td className="num">{fmtPct(f.design, 0)}</td>
                  <td className="num">{f.gen}</td>
                  <td className="num">{f.quality.toFixed(2)}</td>
                  <td>{f.blocked ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {ex.processes.map((p, i) => {
        const rp = rec.data?.processes.find((x) => x.id === p.id)
        const Lr = p.layers
        const eng = Lr.engineering
        const man = Lr.manufacturing
        const eco = Lr.economic
        return (
          <Card
            key={p.id}
            style={{ marginTop: 12 }}
            title={
              p.trad
                ? "Traditional (pre-industrial) method"
                : i === 0
                  ? "Main process"
                  : `Alternative process: ${p.id}`
            }
            sub={`possible in the world since ${p.year > 3000 ? "never" : fmtYearBC(p.year)}`}
          >
            <div className={`layer ${Lr.scientific.ok ? "ok" : "no"}`}>
              <b>{LAYER.scientific}</b> <OkBadge ok={Lr.scientific.ok} />
              <div className="chips" style={{ marginTop: 6 }}>
                {Lr.scientific.items.length ? (
                  Lr.scientific.items.map((k) => (
                    <span
                      key={k.id}
                      className={`chip ${k.ok ? "ok" : "no"}`}
                      title={`${k.kind} · world since ${d.by.knowledge[k.id]?.year_eff}`}
                    >
                      {k.name} <Level v={k.level} /> {fmtPct(k.level, 0)}
                    </span>
                  ))
                ) : (
                  <span className="muted">No special knowledge needed.</span>
                )}
              </div>
            </div>
            <div className={`layer ${eng.ok ? "ok" : "no"}`}>
              <b>{LAYER.engineering}</b> <OkBadge ok={eng.ok} />
              <div className="muted">
                Best domestic design: {fmtPct(eng.best_design, 0)} · reproducing it from scratch
                takes ~{fmtNum(eng.design_effort_py)} engineer-years · disassembling an import
                reveals ~{fmtPct(eng.reverse_engineering, 0)} of how it is made.
              </div>
              {eng.in_rd.map((x) => (
                <div key={x.firm}>
                  R&amp;D: {x.firm} at {fmtPct(x.progress, 0)}
                  {x.blocked && (
                    <>
                      {" "}
                      - <span className="status no">{x.blocked}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className={`layer ${man.ok ? "ok" : "no"}`}>
              <b>{LAYER.manufacturing}</b> <OkBadge ok={man.ok} />
              <div className="muted">
                {man.tolerance_um
                  ? `Tightest tolerance ${man.tolerance_um} µm (the maker's machines must hold within ~4× of this). `
                  : ""}
                {man.cleanroom
                  ? `Needs a ${d.by.goods[man.cleanroom]?.name ?? man.cleanroom}. `
                  : ""}
                Sites:{" "}
                {man.site.regions.length ? (
                  man.site.regions.join(", ")
                ) : (
                  <span className="status no">no suitable region</span>
                )}
                {man.site.deposit ? ` (needs a ${man.site.deposit} deposit)` : ""}.
              </div>
              <h3>
                Equipment &amp; inputs <span className="muted">(click to drill down)</span>
              </h3>
              <div className="chips">
                {man.supplies.map((s) => (
                  <SupplyChip key={`${s.role}-${s.id}`} s={s} />
                ))}
              </div>
              <h3>People</h3>
              <table className="data">
                <thead>
                  <tr>
                    <th>Occupation</th>
                    <th className="num">Hours / unit</th>
                    <th className="num">Workers in country</th>
                    <th className="num">Avg skill</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {man.labor.map((l) => (
                    <tr key={l.occ}>
                      <td>{l.name}</td>
                      <td className="num">{fmtNum(l.hours)}</td>
                      <td className="num">{fmtNum(l.workers)}</td>
                      <td className="num">{l.avg_skill.toFixed(2)}</td>
                      <td>
                        <OkBadge ok={l.ok} yes="available" no="none in country" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={`layer ${eco.ok ? "ok" : "no"}`}>
              <b>{LAYER.economic}</b> <OkBadge ok={eco.ok} />
              <div>
                Estimated domestic unit cost <b>{fmtMoney(eco.est_domestic_cost)}</b> · landed
                import price{" "}
                <b>{eco.import_price ? fmtMoney(eco.import_price) : "not importable"}</b> · current
                market price <b>{fmtMoney(eco.domestic_price)}</b>
              </div>
            </div>
            {rp?.co2 ? <div className="muted">Emits {rp.co2} t CO₂ per unit.</div> : null}
          </Card>
        )
      })}
      <div className="grid g2" style={{ marginTop: 12 }}>
        <Card title="Used as an input by">
          <div className="chips">
            {rec.data.used_in.length ? (
              rec.data.used_in.map(chip)
            ) : (
              <span className="muted">Final product</span>
            )}
          </div>
        </Card>
        <Card title="Used as equipment by">
          <div className="chips">
            {rec.data.used_as_equipment_by.length ? (
              rec.data.used_as_equipment_by.map(chip)
            ) : (
              <span className="muted">—</span>
            )}
          </div>
        </Card>
      </div>
    </>
  )
}
