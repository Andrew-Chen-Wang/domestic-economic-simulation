"use client"

import type { SchemaItem } from "@econsim/engine/policy"
import { useState } from "react"
import { type Policy, type PolicyPatch, post, useApi } from "../api"
import { Card, Loading } from "../common"
import { useDash } from "../state"

type Draft = Record<string, unknown>
type Preset = { label: string; note: string; patch: (p: Policy) => Draft }

const PRESETS: Preset[] = [
  {
    label: "Double education spending",
    note: "Double public education spending",
    patch: (p) => ({ spend_education: Number((p.spend_education * 2).toFixed(4)) }),
  },
  {
    label: "STEM push at universities",
    note: "Shift university seats toward engineering & science",
    patch: () => ({
      university_fields: {
        mech: 3,
        elec: 3,
        chem: 2.5,
        cs: 3,
        science: 2.5,
        business: 0.8,
        law: 0.3,
        arts: 0.3,
      },
      education_tertiary_share: 0.35,
    }),
  },
  {
    label: "Semiconductor industrial policy",
    note: "State-backed chip industry + R&D push",
    patch: () => ({
      industrial_policy: ["chip_legacy", "silicon_wafers", "pcb", "electronic_module"],
      subsidies_producer: { semis: 0.2, electronics: 0.1 },
      research_fields: { elec: 4, phys: 2, chem: 2 },
      spend_research: 0.015,
    }),
  },
  {
    label: "EV purchase subsidy 30%",
    note: "30% consumer subsidy on electric cars",
    patch: () => ({ subsidies_consumer: { electric_car: 0.3, e_bike_scooter: 0.2 } }),
  },
  {
    label: "Carbon tax $80/t",
    note: "Carbon tax of $80 per tonne",
    patch: () => ({ carbon_tax: 80 }),
  },
  {
    label: "Upzone cities ×2.5 + transit",
    note: "Allow 2.5x denser housing, invest in transit",
    patch: () => ({
      zoning_density: 2.5,
      urban_expansion: 1.5,
      infrastructure_split: { transit: 0.3 },
    }),
  },
  {
    label: "Infrastructure push (6% of GDP)",
    note: "Raise infrastructure spending to 6% of GDP",
    patch: () => ({ spend_infrastructure: 0.06 }),
  },
  {
    label: "Protectionism (30% tariffs)",
    note: "30% general tariff",
    patch: () => ({ tariff_general: 0.3 }),
  },
  {
    label: "Free trade",
    note: "Remove all tariffs",
    patch: () => ({ tariff_general: 0, tariff_by_category: {} }),
  },
  {
    label: "Austerity",
    note: "Cut admin & health, lower benefits",
    patch: () => ({
      spend_admin: 0.035,
      spend_health: 0.035,
      unemployment_benefit: 0.2,
      pension_rate: 0.22,
    }),
  },
  {
    label: "Open to skilled immigrants",
    note: "20,000 skilled immigrants per year",
    patch: () => ({ skilled_immigration: 20000 }),
  },
  {
    label: "Raise minimum wage",
    note: "Minimum wage to 60% of median",
    patch: () => ({ minimum_wage: 0.6 }),
  },
  {
    label: "Tight money",
    note: "Fix policy rate at 10%",
    patch: () => ({ policy_rate_mode: "fixed", policy_rate: 0.1 }),
  },
]

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function diffPatch(a: Draft, b: Draft): PolicyPatch {
  const p: PolicyPatch = {}
  for (const k of Object.keys(b)) {
    if (same(a[k], b[k])) continue
    const ak = a[k]
    const bk = b[k]
    if (isObj(bk) && isObj(ak)) {
      const d: Record<string, unknown> = {}
      for (const kk of new Set([...Object.keys(ak), ...Object.keys(bk)])) {
        if (!(kk in bk)) d[kk] = null
        else if (!same(ak[kk], bk[kk])) d[kk] = bk[kk]
      }
      p[k] = d
    } else p[k] = bk
  }
  return p
}

export function PolicyView() {
  const d = useDash()
  const rewind = d.rewindTick !== null && d.rewindTick < d.head
  const state = useApi<{ data: { policy: Policy } | null }>(
    rewind ? `/api/timelines/${d.tid}/detail/state?tick=${d.rewindTick}` : null,
  )
  const base: Policy | null = rewind
    ? (state.data?.data?.policy ?? (state.loading ? null : d.policy))
    : d.policy
  if (!base) return <Loading />
  return <PolicyEditor key={`${d.tid}-${d.rewindTick}-${d.version}`} base={base} rewind={rewind} />
}

function PolicyEditor({ base, rewind }: { base: Policy; rewind: boolean }) {
  const d = useDash()
  const ax = d.axis
  const baseD = base as unknown as Draft
  const [draft, setDraft] = useState<Draft>(() => structuredClone(baseD))
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const patch = diffPatch(baseD, draft)
  const nChanges = Object.keys(patch).length
  const set = (k: string, v: unknown) => {
    setDraft((x) => ({ ...x, [k]: v }))
  }

  const applyPreset = (pr: Preset) => {
    const next = { ...draft }
    for (const [k, v] of Object.entries(pr.patch(draft as unknown as Policy))) {
      const cur = next[k]
      next[k] = isObj(v) && isObj(cur) ? { ...cur, ...v } : v
    }
    setDraft(next)
    setNote(pr.note)
  }

  const apply = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = { patch, note }
      if (rewind && d.rewindTick !== null) {
        body.tick = d.rewindTick
        if (note) body.branch_name = `${note} (from ${ax.tickLabel(d.rewindTick)})`
      }
      const r = await post<{ timeline: number; branched: boolean }>(
        `/api/timelines/${d.tid}/policy`,
        body,
      )
      d.setRewindTick(null)
      if (r.branched) {
        await d.selectTimeline(r.timeline)
        d.setMessage(`Created branch #${r.timeline}. Run it forward to see how it plays out.`)
      } else {
        await d.refresh(false)
        d.setMessage("Decision recorded; it takes effect when you run the next month.")
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Policy decisions</h1>
      <p className="lead">
        {rewind && d.rewindTick !== null ? (
          <>
            <b>Rewind mode:</b> deciding at <b>{ax.tickLabel(d.rewindTick)}</b> (month{" "}
            {d.rewindTick}). Applying creates a new branch from that moment; the original timeline
            is kept so you can compare outcomes.{" "}
            <button
              type="button"
              className="small"
              onClick={() => {
                d.setRewindTick(null)
              }}
            >
              Decide at the latest month instead
            </button>
          </>
        ) : (
          <>
            Decisions apply from <b>{ax.tickLabel(d.head)}</b> onward on this timeline. To change
            your mind about the past, move the time cursor and press “Rewind &amp; decide
            differently here”.
          </>
        )}
      </p>
      <Card title="Quick experiments">
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.label}
              className="small"
              onClick={() => {
                applyPreset(p)
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="muted">
          Presets only fill in the form below; nothing happens until you apply.
        </div>
      </Card>
      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Policy levers</h2>
          {d.meta.policy_schema.map((grp) => (
            <div className="policy-group" key={grp.group}>
              <h3>{grp.group}</h3>
              {grp.items.map((it) => (
                <PolicyItem
                  key={it.key}
                  it={it}
                  value={draft[it.key]}
                  changed={!same(draft[it.key], baseD[it.key])}
                  onChange={(v) => {
                    set(it.key, v)
                  }}
                />
              ))}
            </div>
          ))}
          <div className="sticky-actions">
            <input
              type="text"
              placeholder="Describe this decision (optional)"
              aria-label="Decision note"
              style={{ flex: 1, minWidth: 200 }}
              value={note}
              onChange={(e) => {
                setNote(e.target.value)
              }}
            />
            <span className="muted">{nChanges} change(s)</span>
            <button
              type="button"
              onClick={() => {
                setDraft(structuredClone(baseD))
                setNote("")
              }}
            >
              Reset
            </button>
            <button
              type="button"
              className="primary"
              disabled={!nChanges || busy}
              onClick={() => void apply()}
            >
              {rewind && d.rewindTick !== null
                ? `Branch from ${ax.tickLabel(d.rewindTick)}`
                : "Apply decision"}
            </button>
          </div>
        </div>
        <Card title="Decision history" sub="this branch & its ancestors">
          {d.policyEvents.length ? (
            d.policyEvents
              .slice()
              .toReversed()
              .map((e) => (
                <div className="event" key={e.id}>
                  <span className="when">{ax.tickLabel(e.tick)}</span>
                  <span>
                    {e.note}
                    <br />
                    <span className="muted">{JSON.stringify(e.patch).slice(0, 300)}</span>
                  </span>
                </div>
              ))
          ) : (
            <div className="muted">No decisions yet: the economy runs on default policy.</div>
          )}
        </Card>
      </div>
    </>
  )
}

function useDomainOptions(domain: string | undefined): [string, string][] {
  const d = useDash()
  if (domain === "categories") return d.meta.categories.map((c) => [c, c])
  if (domain === "fields") return Object.entries(d.meta.fields)
  if (domain === "research_fields") return d.meta.research_fields.map((k) => [k, k])
  if (domain === "infra")
    return ["road", "rail", "port", "grid", "broadband", "transit", "irrigation"].map((k) => [k, k])
  if (domain === "regions") return d.regions.map((r) => [String(r.id), r.name])
  return [
    ...d.meta.categories.map((c): [string, string] => [c, `All ${c}`]),
    ...d.catalog.goods.map((g): [string, string] => [g.id, g.name]),
  ]
}

function PolicyItem({
  it,
  value,
  changed,
  onChange,
}: {
  it: SchemaItem
  value: unknown
  changed: boolean
  onChange: (v: unknown) => void
}) {
  const opts = useDomainOptions(it.domain)
  const nameOf = (k: string) => opts.find((o) => o[0] === k)?.[1] ?? k
  const id = `pol-${it.key}`
  let control: React.ReactNode = null
  if (it.type === "pct" || it.type === "num") {
    const scale = it.type === "pct" ? 100 : 1
    const step = (it.step ?? (it.type === "pct" ? 0.005 : 1)) * scale
    const v = typeof value === "number" ? value : 0
    control = (
      <>
        <NumRange
          id={id}
          label={it.label}
          min={(it.min ?? 0) * scale}
          max={(it.max ?? 1) * scale}
          step={step}
          value={v * scale}
          onCommit={(x) => {
            onChange(x / scale)
          }}
        />
        <span style={{ whiteSpace: "nowrap" }}>
          <input
            type="number"
            aria-label={it.label}
            step={step}
            defaultValue={Number((v * scale).toFixed(3))}
            key={v}
            style={{ width: 84 }}
            onBlur={(e) => {
              onChange(Number(e.target.value) / scale)
            }}
          />
          {it.type === "pct" ? "%" : ""}
        </span>
      </>
    )
  } else if (it.type === "choice") {
    control = (
      <>
        <select
          id={id}
          value={String(value)}
          onChange={(e) => {
            onChange(e.target.value)
          }}
        >
          {(it.choices ?? []).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <span />
      </>
    )
  } else if (it.type === "brackets") {
    const arr = Array.isArray(value) ? (value as number[]) : []
    control = (
      <>
        <span>
          {arr.map((x, i) => (
            <span key={i}>
              <input
                type="number"
                aria-label={`${it.label} ${i + 1}`}
                step={1}
                min={0}
                max={90}
                defaultValue={(x * 100).toFixed(1)}
                key={x}
                style={{ width: 62 }}
                onBlur={(e) => {
                  const next = arr.slice()
                  next[i] = Number(e.target.value) / 100
                  onChange(next)
                }}
              />
              %{" "}
            </span>
          ))}
        </span>
        <span />
      </>
    )
  } else if (it.type === "map_num" || it.type === "map_pct") {
    const v = isObj(value) ? (value as Record<string, number>) : {}
    const pct = it.type === "map_pct"
    const removable = pct || it.domain === "regions"
    const keys = removable ? Object.keys(v) : opts.map((o) => o[0])
    control = (
      <>
        <span />
        <span />
        <div className="map-editor">
          {keys.map((k) => {
            const val = v[k] ?? (it.domain === "regions" ? 1 : 0)
            return (
              <div className="map-row" key={k}>
                <span title={nameOf(k)}>{nameOf(k)}</span>
                <input
                  type="number"
                  aria-label={`${it.label}: ${nameOf(k)}`}
                  step={pct ? 1 : (it.step ?? 0.1)}
                  defaultValue={pct ? Number((val * 100).toFixed(2)) : val}
                  key={val}
                  onBlur={(e) => {
                    onChange({
                      ...v,
                      [k]: pct ? Number(e.target.value) / 100 : Number(e.target.value),
                    })
                  }}
                />
                {removable ? (
                  <button
                    type="button"
                    className="small rm"
                    title="remove"
                    onClick={() => {
                      const next = { ...v }
                      delete next[k]
                      onChange(next)
                    }}
                  >
                    ×
                  </button>
                ) : (
                  <span />
                )}
              </div>
            )
          })}
          {removable && (
            <AddSelect
              label={it.label}
              options={opts.filter((o) => !(o[0] in v))}
              onAdd={(k) => {
                onChange({ ...v, [k]: pct ? 0.1 : 1 })
              }}
            />
          )}
        </div>
      </>
    )
  } else if (it.type === "list") {
    const v = Array.isArray(value) ? (value as string[]) : []
    control = (
      <>
        <span />
        <span />
        <div className="map-editor">
          {v.map((k) => (
            <div className="map-row" key={k}>
              <span>{nameOf(k)}</span>
              <span />
              <button
                type="button"
                className="small rm"
                onClick={() => {
                  onChange(v.filter((x) => x !== k))
                }}
              >
                ×
              </button>
            </div>
          ))}
          <AddSelect
            label={it.label}
            options={opts.filter((o) => !v.includes(o[0]))}
            onAdd={(k) => {
              onChange([...v, k])
            }}
          />
        </div>
      </>
    )
  }
  return (
    <div className={`policy-item ${changed ? "changed" : ""}`}>
      <label htmlFor={id}>{it.label}</label>
      {control}
      {it.help && <div className="help">{it.help}</div>}
    </div>
  )
}

/** Range slider that shows its value while dragging and commits on release. */
function NumRange(props: {
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
  onCommit: (v: number) => void
}) {
  const [v, setV] = useState<number | null>(null)
  return (
    <input
      aria-label={props.label}
      id={props.id}
      type="range"
      min={props.min}
      max={props.max}
      step={props.step}
      value={v ?? props.value}
      onChange={(e) => {
        setV(Number(e.target.value))
      }}
      onPointerUp={() => {
        if (v !== null) props.onCommit(v)
        setV(null)
      }}
      onKeyUp={() => {
        if (v !== null) props.onCommit(v)
        setV(null)
      }}
    />
  )
}

function AddSelect({
  label,
  options,
  onAdd,
}: {
  label: string
  options: [string, string][]
  onAdd: (k: string) => void
}) {
  return (
    <div className="map-row">
      <select
        className="addSel"
        aria-label={`Add to ${label}`}
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value)
        }}
      >
        <option value="">+ add…</option>
        {options.map(([k, n], i) => (
          <option key={`${i}:${k}`} value={k}>
            {n}
          </option>
        ))}
      </select>
    </div>
  )
}
