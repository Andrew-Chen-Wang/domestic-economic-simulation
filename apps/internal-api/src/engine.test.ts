import { describe, expect, it } from "vitest"
import app from "./engine"

describe("reference catalog HTTP API", () => {
  it("returns bounded source-backed results without requiring a timeline", async () => {
    const response = await app.request("/catalog/reference?kind=goods&q=horses&limit=2")
    expect(response.status).toBe(200)
    const data = (await response.json()) as { status: string; rows: unknown[]; total: number }
    expect(data.status).toBe("reference")
    expect(data.rows).toHaveLength(2)
    expect(data.total).toBeGreaterThan(2)
  })
  it("returns 400 for unknown categories and invalid pagination", async () => {
    const responses = await Promise.all(
      ["kind=bad", "offset=-1", "offset=0.5", "limit=1000", "limit=oops"].map((query) =>
        Promise.resolve(app.request(`/catalog/reference?${query}`)),
      ),
    )
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400])
  })
})
