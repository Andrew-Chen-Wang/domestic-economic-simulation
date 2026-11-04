const P = (x: number, d: number) => String(Number(x.toPrecision(d)))
const bad = (v: number | null | undefined): v is null | undefined =>
  v === null || v === undefined || Number.isNaN(v)

export function fmtMoney(v: number | null | undefined, digits = 3): string {
  if (bad(v)) return "–"
  const a = Math.abs(v)
  const s = v < 0 ? "-" : ""
  if (a >= 1e12) return `${s}$${P(a / 1e12, digits)}T`
  if (a >= 1e9) return `${s}$${P(a / 1e9, digits)}B`
  if (a >= 1e6) return `${s}$${P(a / 1e6, digits)}M`
  if (a >= 1e3) return `${s}$${P(a / 1e3, digits)}k`
  if (a === 0) return "$0"
  return `${s}$${P(a, digits)}`
}

export function fmtNum(v: number | null | undefined, digits = 3): string {
  if (bad(v)) return "–"
  const a = Math.abs(v)
  const s = v < 0 ? "-" : ""
  if (a >= 1e9) return `${s}${P(a / 1e9, digits)}B`
  if (a >= 1e6) return `${s}${P(a / 1e6, digits)}M`
  if (a >= 1e4) return `${s}${P(a / 1e3, digits)}k`
  if (a >= 100) return s + a.toFixed(0)
  if (a >= 1) return s + a.toFixed(2)
  if (a === 0) return "0"
  return s + P(a, 2)
}

export const fmtPct = (v: number | null | undefined, d = 1): string =>
  bad(v) ? "–" : `${(v * 100).toFixed(d)}%`

export const fmtYearBC = (y: number) => (y < 0 ? `${-y} BC` : String(y))

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/** Labels and axis ticks for month indices ("ticks") on a timeline starting at `startYear`. */
export function timeAxis(startYear: number) {
  const yearOf = (t: number) => startYear + t / 12
  const tickLabel = (t: number) => {
    const y = yearOf(t)
    const yi = Math.floor(y + 1e-9)
    return `${MONTHS[Math.round((y - yi) * 12) % 12]} ${yi}`
  }
  const xfmt = (x: number) => String(Math.floor(yearOf(x) + 1e-9))
  /** ticks on January of each year, every k years so labels never crowd */
  const xticks = (x0: number, x1: number, n: number) => {
    const off = Math.round(startYear * 12) % 12
    const first = Math.ceil((x0 + off) / 12) * 12 - off
    const years = Math.max(1, Math.floor((x1 - first) / 12) + 1)
    const k = [1, 2, 5, 10, 20, 50].find((s) => years / s <= n) ?? 100
    const out: number[] = []
    for (let t = first; t <= x1 + 1e-9; t += 12 * k) out.push(t)
    return out.length ? out : [x0]
  }
  return { yearOf, tickLabel, xfmt, xticks }
}
export type TimeAxis = ReturnType<typeof timeAxis>
