"use client"

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import {
  api,
  type CatalogResponse,
  type JobStatus,
  type MetaResponse,
  type Policy,
  type PolicyResponse,
  post,
  type SeriesRow,
  type TimelineInfo,
  type TimelinesResponse,
} from "./api"
import { fmtMoney, fmtPct, type TimeAxis, timeAxis } from "./format"

export type View =
  | "overview"
  | "policy"
  | "timelines"
  | "money"
  | "products"
  | "product"
  | "industry"
  | "labor"
  | "knowledge"
  | "regions"
  | "ledger"
  | "events"
  | "catalog"
  | "about"

export interface Lookups {
  goods: Record<string, CatalogResponse["goods"][number]>
  knowledge: Record<string, CatalogResponse["knowledge"][number]>
  occupations: Record<string, CatalogResponse["occupations"][number]>
}

export interface Dash {
  meta: MetaResponse
  catalog: CatalogResponse
  by: Lookups
  timelines: TimelineInfo[]
  tid: number | null
  timeline: TimelineInfo | null
  head: number
  cursor: number
  follow: boolean
  series: SeriesRow[]
  compare: TimelineInfo | null
  compareSeries: SeriesRow[]
  policy: Policy | null
  policyEvents: PolicyResponse["events"]
  regions: PolicyResponse["regions"]
  view: View
  productId: string | null
  rewindTick: number | null
  job: JobStatus
  message: string
  axis: TimeAxis
  /** metrics at the cursor */
  current: SeriesRow | null
  /** bumps whenever the timeline data changes, so views refetch */
  version: number
  go: (view: View, productId?: string) => void
  selectTimeline: (id: number) => Promise<void>
  refresh: (resetCursor?: boolean) => Promise<void>
  loadTimelines: () => Promise<TimelineInfo[]>
  setCursor: (t: number, commit?: boolean) => void
  followLatest: () => void
  setCompare: (id: number | null) => Promise<void>
  setRewindTick: (t: number | null) => void
  run: (months: number) => Promise<void>
  cancel: () => Promise<void>
  pollJob: () => void
  setMessage: (m: string) => void
  newDialogOpen: boolean
  setNewDialogOpen: (o: boolean) => void
  /** "per person" and "share of GDP" tooltip rows for an amount */
  perCapita: (v: number, monthly?: boolean) => ReactNode
}

const Ctx = createContext<Dash | null>(null)

export function useDash(): Dash {
  const d = useContext(Ctx)
  if (!d) throw new Error("useDash outside DashProvider")
  return d
}

export function DashProvider({
  meta,
  catalog,
  children,
}: {
  meta: MetaResponse
  catalog: CatalogResponse
  children: ReactNode
}) {
  const [by] = useState<Lookups>(() => ({
    goods: Object.fromEntries(catalog.goods.map((g) => [g.id, g])),
    knowledge: Object.fromEntries(catalog.knowledge.map((k) => [k.id, k])),
    occupations: Object.fromEntries(catalog.occupations.map((o) => [o.id, o])),
  }))
  const [timelines, setTimelines] = useState<TimelineInfo[]>([])
  const [tid, setTid] = useState<number | null>(null)
  const [cursor, setCursorState] = useState(0)
  const [follow, setFollow] = useState(true)
  const [series, setSeries] = useState<SeriesRow[]>([])
  const [compare, setCompareTl] = useState<TimelineInfo | null>(null)
  const [compareSeries, setCompareSeries] = useState<SeriesRow[]>([])
  const [pol, setPol] = useState<PolicyResponse | null>(null)
  const [view, setView] = useState<View>("overview")
  const [productId, setProductId] = useState<string | null>(null)
  const [rewindTick, setRewindTick] = useState<number | null>(null)
  const [job, setJob] = useState<JobStatus>(meta.status)
  const [message, setMessage] = useState("")
  const [version, setVersion] = useState(0)
  const [newDialogOpen, setNewDialogOpen] = useState(false)
  const polling = useRef(false)
  const followRef = useRef(true)
  const tidRef = useRef<number | null>(null)

  const timeline = timelines.find((t) => t.id === tid) ?? null
  const head = timeline?.head_tick ?? 0
  const axis = timeAxis(timeline?.start_year ?? 2025)

  const loadTimelines = useCallback(async () => {
    const r = await api<TimelinesResponse>("/api/timelines")
    setTimelines(r.timelines)
    return r.timelines
  }, [])

  const loadTimeline = useCallback(
    async (id: number, resetCursor: boolean) => {
      const tls = await loadTimelines()
      const t = tls.find((x) => x.id === id)
      if (!t) return
      const [s, p] = await Promise.all([
        api<{ series: SeriesRow[] }>(`/api/timelines/${id}/series`),
        api<PolicyResponse>(`/api/timelines/${id}/policy`),
      ])
      setSeries(s.series)
      setPol(p)
      if (resetCursor || followRef.current) {
        setCursorState(Math.max(0, t.head_tick - 1))
        followRef.current = true
        setFollow(true)
      }
      setVersion((v) => v + 1)
    },
    [loadTimelines],
  )

  const selectTimeline = useCallback(
    async (id: number) => {
      tidRef.current = id
      setTid(id)
      setCompareTl(null)
      setCompareSeries([])
      await loadTimeline(id, true)
    },
    [loadTimeline],
  )

  const refresh = useCallback(
    async (resetCursor = false) => {
      if (tid !== null) await loadTimeline(tid, resetCursor)
    },
    [tid, loadTimeline],
  )

  const pollJob = useCallback(() => {
    if (polling.current) return
    polling.current = true
    void (async () => {
      let st: JobStatus = { state: "idle" }
      for (;;) {
        st = await api<JobStatus>("/api/status")
        setJob(st)
        if (st.state !== "running") break
        await new Promise((r) => setTimeout(r, 600))
      }
      polling.current = false
      if (st.state === "error") setMessage(`Error: ${st.message.split("\n")[0]}`)
      else if (st.state === "cancelled") setMessage("Stopped.")
      if (st.state !== "idle" && st.kind === "create" && st.timeline !== null)
        await selectTimeline(st.timeline)
      else {
        followRef.current = true
        if (tidRef.current !== null) await loadTimeline(tidRef.current, false)
      }
    })()
  }, [loadTimeline, selectTimeline])

  // boot: newest timeline, or the new-simulation dialog
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void (async () => {
      const tls = await loadTimelines()
      if (tls.length) await selectTimeline(tls[tls.length - 1].id)
      else if (meta.status.state !== "running") setNewDialogOpen(true)
      if (meta.status.state === "running") pollJob()
    })()
  }, [loadTimelines, selectTimeline, pollJob, meta.status.state])

  const current = series.find((m) => m.tick === cursor) ?? series[series.length - 1] ?? null

  const dash: Dash = {
    meta,
    catalog,
    by,
    timelines,
    tid,
    timeline,
    head,
    cursor,
    follow,
    series,
    compare,
    compareSeries,
    policy: pol?.policy ?? null,
    policyEvents: pol?.events ?? [],
    regions: pol?.regions ?? [],
    view,
    productId,
    rewindTick,
    job,
    message,
    axis,
    current,
    version,
    go: (v, pid) => {
      setView(v)
      if (pid !== undefined) setProductId(pid)
      window.scrollTo(0, 0)
    },
    selectTimeline,
    refresh,
    loadTimelines,
    setCursor: (t) => {
      const c = Math.max(0, Math.min(head - 1, Math.round(t)))
      setCursorState(c)
      const f = c >= head - 1
      followRef.current = f
      setFollow(f)
    },
    followLatest: () => {
      followRef.current = true
      setFollow(true)
      setCursorState(Math.max(0, head - 1))
    },
    setCompare: async (id) => {
      if (id === null) {
        setCompareTl(null)
        setCompareSeries([])
        return
      }
      setCompareTl(timelines.find((x) => x.id === id) ?? null)
      setCompareSeries((await api<{ series: SeriesRow[] }>(`/api/timelines/${id}/series`)).series)
    },
    setRewindTick,
    run: async (months) => {
      if (tid === null) {
        setNewDialogOpen(true)
        return
      }
      try {
        setMessage("")
        await post(`/api/timelines/${tid}/run`, { months })
        pollJob()
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e))
      }
    },
    cancel: async () => {
      setJob(await post<JobStatus>("/api/cancel"))
    },
    pollJob,
    setMessage,
    newDialogOpen,
    setNewDialogOpen,
    perCapita: (v, monthly = false) => {
      if (!current) return null
      const people = current.population || 1
      const gdp = monthly ? current.gdp : (current.gdp || 0) * 12
      return (
        <>
          <div className="tip-row">
            Per person<b>{fmtMoney(v / people)}</b>
          </div>
          <div className="tip-row">
            Share of {monthly ? "monthly" : "annual"} GDP<b>{fmtPct(v / gdp)}</b>
          </div>
        </>
      )
    },
  }
  return <Ctx.Provider value={dash}>{children}</Ctx.Provider>
}

/** Points for a metric key over a series, for LineChart. */
export function pts(
  src: SeriesRow[],
  key: keyof SeriesRow,
  f: (v: number) => number = (x) => x,
): [number, number | null][] {
  return src.map((m) => {
    const v = m[key]
    return [m.tick, typeof v === "number" ? f(v) : null]
  })
}
