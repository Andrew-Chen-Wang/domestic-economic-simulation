"use client"

import type { Metrics } from "@econsim/engine"
import { useCallback, useEffect, useState } from "react"

export type {
  CatalogGoodResponse,
  CatalogResponse,
  EventsResponse,
  FlowsResponse,
  GoodBrief,
  GoodResponse,
  GoodsResponse,
  LedgerResponse,
  MetaResponse,
  PolicyResponse,
  TimelineInfo,
  TimelinesResponse,
} from "@econsim/engine/api"
export type { Job, Metrics, Policy, PolicyPatch } from "@econsim/engine"

/** One row of /series: the month's metrics plus its tick. */
export type SeriesRow = Metrics & { tick: number }
export type JobStatus = { state: "idle" } | import("@econsim/engine").Job

export class HttpError extends Error {}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const r = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const j = (await r.json()) as unknown
  if (!r.ok) {
    const e = j && typeof j === "object" && "error" in j ? (j as { error: unknown }).error : null
    const msg =
      typeof e === "string"
        ? e
        : e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : r.statusText
    throw new HttpError(msg)
  }
  return j as T
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body })

/** Fetch `path` whenever it changes (null = skip). */
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null }>(
    {
      path: null,
      data: null,
      error: null,
    },
  )
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (path === null) return
    let live = true
    api<T>(path)
      .then((data) => {
        if (live) setState({ path, data, error: null })
      })
      .catch((e: unknown) => {
        if (live) setState({ path, data: null, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      live = false
    }
  }, [path, nonce])
  const reload = useCallback(() => {
    setNonce((n) => n + 1)
  }, [])
  const fresh = state.path === path
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: !fresh,
    reload,
  }
}
