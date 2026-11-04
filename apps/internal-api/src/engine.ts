import { Hono } from "hono"
import { ErrorCode } from "./utils/errors.enum"
import { throwError } from "./utils/http-exception"

/**
 * The economic simulation itself runs in the Python engine (apps/engine), which
 * owns the SQLite store (timelines, snapshots, ledger). This router forwards
 * every /api/* request to it unchanged.
 */
const ENGINE_URL = process.env.ECONSIM_ENGINE_URL ?? "http://127.0.0.1:8000"

const app = new Hono().all("/*", async (c) => {
  const url = new URL(c.req.url)
  const target = `${ENGINE_URL}${url.pathname}${url.search}`
  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD"
  let res: Response
  try {
    res = await fetch(target, {
      method: c.req.method,
      headers: { "Content-Type": c.req.header("Content-Type") ?? "application/json" },
      body: hasBody ? await c.req.text() : undefined,
    })
  } catch {
    return throwError(
      c,
      503,
      ErrorCode.ServiceUnavailable,
      `Simulation engine unreachable at ${ENGINE_URL}. Start it with: mise run engine`,
    )
  }
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  })
})

export default app
