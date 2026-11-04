import { ApiError, api, getEngine } from "@econsim/engine"
import { type Context, Hono } from "hono"

/**
 * The simulation runs in-process (packages/engine): this router exposes it over HTTP. Long jobs
 * (creating a world, running years) are started in the background and polled via /status.
 */

type JsonBody = Record<string, unknown>

const int = (c: Context, k: string): number | null => {
  const v = c.req.query(k)
  if (v === undefined || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new ApiError(`${k} must be a number`)
  return Math.trunc(n)
}
const str = (c: Context, k: string): string | null => c.req.query(k) || null
const list = (c: Context, k: string): string[] | null => {
  const v = (c.req.query(k) ?? "").split(",").filter(Boolean)
  return v.length ? v : null
}
const tidOf = (c: Context): number => {
  const n = Number(c.req.param("tid"))
  if (!Number.isInteger(n)) throw new ApiError("bad timeline id")
  return n
}
async function body(c: Context): Promise<JsonBody> {
  const text = await c.req.text()
  if (!text) return {}
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === "object" ? (v as JsonBody) : {}
  } catch {
    throw new ApiError("bad json")
  }
}
const optNum = (v: unknown): number | null => (typeof v === "number" ? v : null)
const optStr = (v: unknown): string | null => (typeof v === "string" ? v : null)

const app = new Hono()
  .onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status as 400)
    if (err.message.includes("job is running")) return c.json({ error: err.message }, 409)
    console.error(err)
    return c.json({ error: err.message }, 500)
  })
  .use(async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })
  // ---------------------------------------------------------------- catalog
  .get("/meta", (c) => c.json(api.meta(getEngine())))
  .get("/catalog", (c) => c.json(api.catalog()))
  .get("/catalog/good/:gid", (c) => c.json(api.catalogGood(c.req.param("gid"))))
  // -------------------------------------------------------------- timelines
  .get("/timelines", (c) => c.json(api.timelines(getEngine())))
  .post("/timelines", async (c) => {
    const b = await body(c)
    return c.json(
      api.createTimeline(getEngine(), {
        scenario: optStr(b.scenario) ?? undefined,
        seed: optNum(b.seed) ?? 1,
        name: optStr(b.name),
        burn_in: optNum(b.burn_in),
      }),
    )
  })
  .post("/timelines/:tid/run", async (c) => {
    const b = await body(c)
    return c.json(api.runTimeline(getEngine(), tidOf(c), optNum(b.months) ?? 12))
  })
  .get("/timelines/:tid/policy", (c) => c.json(api.getPolicy(getEngine(), tidOf(c))))
  .post("/timelines/:tid/policy", async (c) => {
    const b = await body(c)
    const patch = b.patch && typeof b.patch === "object" ? (b.patch as Record<string, unknown>) : {}
    return c.json(
      api.setPolicy(getEngine(), tidOf(c), {
        patch,
        note: optStr(b.note) ?? "",
        tick: optNum(b.tick),
        branch_name: optStr(b.branch_name),
      }),
    )
  })
  .post("/timelines/:tid/fork", async (c) => {
    const b = await body(c)
    const tick = optNum(b.tick)
    if (tick === null) throw new ApiError("tick is required")
    return c.json(api.fork(getEngine(), tidOf(c), tick, optStr(b.name)))
  })
  .post("/timelines/:tid/rename", async (c) => {
    const b = await body(c)
    return c.json(api.rename(getEngine(), tidOf(c), optStr(b.name) ?? ""))
  })
  .delete("/timelines/:tid", (c) => c.json(api.remove(getEngine(), tidOf(c))))
  .get("/status", (c) => c.json(api.status(getEngine())))
  .post("/cancel", (c) => {
    const e = getEngine()
    e.cancel()
    return c.json(api.status(e))
  })
  // ------------------------------------------------------------------ reads
  .get("/timelines/:tid/series", (c) => c.json(api.series(getEngine(), tidOf(c), list(c, "keys"))))
  .get("/timelines/:tid/metrics", (c) =>
    c.json(api.metricsAt(getEngine(), tidOf(c), int(c, "tick"))),
  )
  .get("/timelines/:tid/goods", (c) => c.json(api.goods(getEngine(), tidOf(c), int(c, "tick"))))
  .get("/timelines/:tid/good/:gid", (c) =>
    c.json(api.good(getEngine(), tidOf(c), c.req.param("gid"), int(c, "tick"))),
  )
  .get("/timelines/:tid/flows", (c) =>
    c.json(api.flows(getEngine(), tidOf(c), int(c, "from"), int(c, "to"))),
  )
  .get("/timelines/:tid/ledger", (c) =>
    c.json(
      api.ledger(getEngine(), tidOf(c), {
        from: int(c, "from"),
        to: int(c, "to"),
        account: str(c, "account"),
        kind: str(c, "kind"),
        limit: int(c, "limit"),
        offset: int(c, "offset"),
      }),
    ),
  )
  .get("/timelines/:tid/events", (c) =>
    c.json(
      api.events(getEngine(), tidOf(c), {
        from: int(c, "from"),
        to: int(c, "to"),
        kinds: list(c, "kinds"),
        limit: int(c, "limit"),
        search: str(c, "search"),
      }),
    ),
  )
  .get("/timelines/:tid/detail/:kind", (c) =>
    c.json(api.detail(getEngine(), tidOf(c), c.req.param("kind"), int(c, "tick"))),
  )

export default app
