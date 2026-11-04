/**
 * SQLite persistence (node:sqlite): branching timelines, snapshots, ledger, metrics, goods flows,
 * events and periodic detail exports.
 *
 * A timeline is a sequence of months. A child timeline branches from its parent at `fork_tick`:
 * for earlier months it shares the parent's history. Rewinding loads the nearest snapshot at or
 * before the fork tick from the lineage and replays deterministically (the RNG state is part of
 * the snapshot).
 */
import { mkdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { deserialize, serialize } from "node:v8"
import { deflateSync, inflateSync } from "node:zlib"
import type { PolicyPatch } from "./policy"
import type { SimEvent, World } from "./world"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS timelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER, fork_tick INTEGER NOT NULL DEFAULT 0,
  name TEXT, scenario TEXT, seed INTEGER, created_at REAL,
  head_tick INTEGER NOT NULL DEFAULT 0, start_year REAL, scale REAL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  timeline_id INTEGER, tick INTEGER, blob BLOB,
  PRIMARY KEY (timeline_id, tick)
);
CREATE TABLE IF NOT EXISTS policy_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timeline_id INTEGER, tick INTEGER, patch TEXT, note TEXT, created_at REAL
);
CREATE INDEX IF NOT EXISTS ix_pol ON policy_events(timeline_id, tick);
CREATE TABLE IF NOT EXISTS metrics (
  timeline_id INTEGER, tick INTEGER, data TEXT,
  PRIMARY KEY (timeline_id, tick)
);
CREATE TABLE IF NOT EXISTS goods (
  timeline_id INTEGER, tick INTEGER, good TEXT,
  price REAL, output REAL, dom_sold REAL, imports REAL, exports REAL,
  hh_qty REAL, hh_value REAL, gov_value REAL, inv_value REAL, firm_value REAL,
  import_value REAL, export_value REAL, shortage REAL, producers INTEGER,
  PRIMARY KEY (timeline_id, tick, good)
);
CREATE TABLE IF NOT EXISTS ledger (
  timeline_id INTEGER, tick INTEGER, src TEXT, dst TEXT, kind TEXT, amount REAL
);
CREATE INDEX IF NOT EXISTS ix_ledger ON ledger(timeline_id, tick);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timeline_id INTEGER, tick INTEGER, kind TEXT, text TEXT, data TEXT
);
CREATE INDEX IF NOT EXISTS ix_events ON events(timeline_id, tick);
CREATE TABLE IF NOT EXISTS accounts (
  timeline_id INTEGER, account TEXT, label TEXT, sector TEXT,
  PRIMARY KEY (timeline_id, account)
);
CREATE TABLE IF NOT EXISTS details (
  timeline_id INTEGER, tick INTEGER, kind TEXT, data TEXT,
  PRIMARY KEY (timeline_id, tick, kind)
);
`

const FAR = 10 ** 9
const TABLES = [
  "snapshots",
  "policy_events",
  "metrics",
  "goods",
  "ledger",
  "events",
  "details",
  "accounts",
]

export interface TimelineRow {
  id: number
  parent_id: number | null
  fork_tick: number
  name: string
  scenario: string
  seed: number
  created_at: number
  head_tick: number
  start_year: number
  scale: number
  note: string | null
}

export interface PolicyEventRow {
  id: number
  timeline_id: number
  tick: number
  patch: PolicyPatch
  note: string
  created_at: number
}

export const GOODS_COLS = [
  "good",
  "price",
  "output",
  "dom_sold",
  "imports",
  "exports",
  "hh_qty",
  "hh_value",
  "gov_value",
  "inv_value",
  "firm_value",
  "import_value",
  "export_value",
  "shortage",
  "producers",
] as const
export type GoodsRow = { good: string } & Record<
  Exclude<(typeof GOODS_COLS)[number], "good">,
  number
>

export interface LedgerRow {
  tick: number
  src: string
  dst: string
  kind: string
  amount: number
}

export interface EventRow {
  tick: number
  kind: string
  text: string
  data: Record<string, unknown>
}

type Segment = [timeline: number, from: number, toExclusive: number]

const now = () => Date.now() / 1000

export class Store {
  path: string
  db: DatabaseSync

  constructor(path: string) {
    this.path = resolve(path)
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseSync(this.path, { timeout: 30000 })
    this.db.exec("PRAGMA journal_mode=WAL")
    this.db.exec("PRAGMA synchronous=NORMAL")
    this.db.exec(SCHEMA)
  }

  private all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[]
  }

  private get<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined
  }

  private run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args)
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN")
    try {
      const out = fn()
      this.db.exec("COMMIT")
      return out
    } catch (e) {
      this.db.exec("ROLLBACK")
      throw e
    }
  }

  // ----------------------------------------------------------- timelines
  createTimeline(o: {
    name: string
    scenario: string
    seed: number
    parentId?: number | null
    forkTick?: number
    startYear?: number | null
    scale?: number | null
    note?: string | null
  }): number {
    const r = this.run(
      "INSERT INTO timelines(parent_id, fork_tick, name, scenario, seed, created_at, head_tick," +
        " start_year, scale, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
      o.parentId ?? null,
      o.forkTick ?? 0,
      o.name,
      o.scenario,
      o.seed,
      now(),
      o.forkTick ?? 0,
      o.startYear ?? null,
      o.scale ?? null,
      o.note ?? null,
    )
    return Number(r.lastInsertRowid)
  }

  timeline(tid: number): TimelineRow | null {
    return this.get<TimelineRow>("SELECT * FROM timelines WHERE id=?", tid) ?? null
  }

  timelines(): TimelineRow[] {
    return this.all<TimelineRow>("SELECT * FROM timelines ORDER BY id")
  }

  setHead(tid: number, tick: number) {
    this.run("UPDATE timelines SET head_tick=? WHERE id=?", tick, tid)
  }

  rename(tid: number, name: string) {
    this.run("UPDATE timelines SET name=? WHERE id=?", name, tid)
  }

  /** Delete a timeline and all its descendants. */
  deleteTimeline(tid: number) {
    for (const k of this.all<{ id: number }>("SELECT id FROM timelines WHERE parent_id=?", tid))
      this.deleteTimeline(k.id)
    this.tx(() => {
      for (const t of TABLES) this.run(`DELETE FROM ${t} WHERE timeline_id=?`, tid)
      this.run("DELETE FROM timelines WHERE id=?", tid)
    })
  }

  /** [timeline, from_tick, to_tick_exclusive] from root to tid. */
  lineage(tid: number): Segment[] {
    const chain: Segment[] = []
    let t = this.timeline(tid)
    let upper = FAR
    while (t) {
      const lo = t.parent_id ? t.fork_tick : 0
      chain.push([t.id, lo, upper])
      upper = lo
      t = t.parent_id ? this.timeline(t.parent_id) : null
    }
    return chain.toReversed()
  }

  ownerOf(tid: number, tick: number): number {
    for (const [t, lo, hi] of this.lineage(tid)) if (lo <= tick && tick < hi) return t
    return tid
  }

  // ----------------------------------------------------------- snapshots
  saveSnapshot(tid: number, tick: number, world: World) {
    const blob = deflateSync(serialize(world), { level: 3 })
    this.run(
      "INSERT OR REPLACE INTO snapshots(timeline_id, tick, blob) VALUES (?,?,?)",
      tid,
      tick,
      blob,
    )
  }

  /** Latest snapshot at or before `tick` along the lineage. */
  nearestSnapshot(tid: number, tick: number): [number, number] | null {
    let best: [number, number] | null = null
    for (const [t, lo, hi] of this.lineage(tid)) {
      const r = this.get<{ tick: number }>(
        "SELECT tick FROM snapshots WHERE timeline_id=? AND tick>=? AND tick<? AND tick<=? " +
          "ORDER BY tick DESC LIMIT 1",
        t,
        lo,
        hi,
        tick,
      )
      if (r && (best === null || r.tick >= best[1])) best = [t, r.tick]
    }
    return best
  }

  loadSnapshot(tid: number, tick: number): World | null {
    const r = this.get<{ blob: Uint8Array }>(
      "SELECT blob FROM snapshots WHERE timeline_id=? AND tick=?",
      tid,
      tick,
    )
    return r ? (deserialize(inflateSync(r.blob)) as World) : null
  }

  // -------------------------------------------------------------- policy
  addPolicy(tid: number, tick: number, patch: PolicyPatch, note = "") {
    this.run(
      "INSERT INTO policy_events(timeline_id, tick, patch, note, created_at) VALUES (?,?,?,?,?)",
      tid,
      tick,
      JSON.stringify(patch),
      note,
      now(),
    )
  }

  policyEvents(tid: number, lo = 0, hi = FAR, ownOnly = false): PolicyEventRow[] {
    const out: PolicyEventRow[] = []
    const segs: Segment[] = ownOnly ? [[tid, 0, FAR]] : this.lineage(tid)
    for (const [t, a, b] of segs) {
      for (const r of this.all<Omit<PolicyEventRow, "patch"> & { patch: string }>(
        "SELECT * FROM policy_events WHERE timeline_id=? AND tick>=? AND tick<? ORDER BY tick, id",
        t,
        Math.max(a, lo),
        Math.min(b, hi),
      ))
        out.push({ ...r, patch: JSON.parse(r.patch) as PolicyPatch })
    }
    return out.toSorted((x, y) => x.tick - y.tick || x.id - y.id)
  }

  // ------------------------------------------------------------- writes
  writeMonth(
    tid: number,
    tick: number,
    metrics: unknown,
    goodsRows: (string | number)[][],
    ledgerRows: [string, string, string, number][],
    events: SimEvent[],
  ) {
    this.tx(() => {
      this.run(
        "INSERT OR REPLACE INTO metrics(timeline_id, tick, data) VALUES (?,?,?)",
        tid,
        tick,
        JSON.stringify(metrics),
      )
      this.run("DELETE FROM goods WHERE timeline_id=? AND tick=?", tid, tick)
      const g = this.db.prepare("INSERT INTO goods VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      for (const r of goodsRows) g.run(tid, tick, ...r)
      this.run("DELETE FROM ledger WHERE timeline_id=? AND tick=?", tid, tick)
      const l = this.db.prepare("INSERT INTO ledger VALUES (?,?,?,?,?,?)")
      for (const r of ledgerRows) l.run(tid, tick, ...r)
      this.insertEvents(tid, events)
    })
  }

  private insertEvents(tid: number, events: SimEvent[]) {
    const e = this.db.prepare(
      "INSERT INTO events(timeline_id, tick, kind, text, data) VALUES (?,?,?,?,?)",
    )
    for (const ev of events) e.run(tid, ev.tick, ev.kind, ev.text, JSON.stringify(ev.data ?? {}))
  }

  writeAccounts(tid: number, rows: [string, string, string][]) {
    this.tx(() => {
      const s = this.db.prepare(
        "INSERT OR IGNORE INTO accounts(timeline_id, account, label, sector) VALUES (?,?,?,?)",
      )
      for (const r of rows) s.run(tid, ...r)
    })
  }

  accounts(tid: number): Record<string, { label: string; sector: string }> {
    const out: Record<string, { label: string; sector: string }> = {}
    for (const [t] of this.lineage(tid))
      for (const r of this.all<{ account: string; label: string; sector: string }>(
        "SELECT account, label, sector FROM accounts WHERE timeline_id=?",
        t,
      ))
        out[r.account] = { label: r.label, sector: r.sector }
    return out
  }

  writeEvents(tid: number, events: SimEvent[]) {
    this.tx(() => {
      this.insertEvents(tid, events)
    })
  }

  writeDetail(tid: number, tick: number, kind: string, data: unknown) {
    this.run(
      "INSERT OR REPLACE INTO details(timeline_id, tick, kind, data) VALUES (?,?,?,?)",
      tid,
      tick,
      kind,
      JSON.stringify(data),
    )
  }

  /** Remove a timeline's own data at or after `tick` (used when re-running). */
  truncateAfter(tid: number, tick: number) {
    this.tx(() => {
      for (const t of ["metrics", "goods", "ledger", "events", "details"])
        this.run(`DELETE FROM ${t} WHERE timeline_id=? AND tick>=?`, tid, tick)
      this.run("DELETE FROM snapshots WHERE timeline_id=? AND tick>?", tid, tick)
    })
  }

  // -------------------------------------------------------------- reads
  series(
    tid: number,
    keys: string[] | null = null,
    upto: number | null = null,
  ): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (const [t, lo, hi0] of this.lineage(tid)) {
      const hi = upto !== null ? Math.min(hi0, upto + 1) : hi0
      for (const r of this.all<{ tick: number; data: string }>(
        "SELECT tick, data FROM metrics WHERE timeline_id=? AND tick>=? AND tick<? ORDER BY tick",
        t,
        lo,
        hi,
      )) {
        let d = JSON.parse(r.data) as Record<string, unknown>
        if (keys?.length) d = Object.fromEntries(keys.map((k) => [k, d[k] ?? null]))
        d.tick = r.tick
        out.push(d)
      }
    }
    return out
  }

  metricsAt(tid: number, tick: number): Record<string, unknown> | null {
    const t = this.ownerOf(tid, tick)
    const r = this.get<{ data: string }>(
      "SELECT data FROM metrics WHERE timeline_id=? AND tick=?",
      t,
      tick,
    )
    return r ? (JSON.parse(r.data) as Record<string, unknown>) : null
  }

  goodsAt(tid: number, tick: number): GoodsRow[] {
    const t = this.ownerOf(tid, tick)
    return this.all<GoodsRow>(
      `SELECT ${GOODS_COLS.join(",")} FROM goods WHERE timeline_id=? AND tick=?`,
      t,
      tick,
    )
  }

  goodSeries(tid: number, good: string): (GoodsRow & { tick: number })[] {
    const out: (GoodsRow & { tick: number })[] = []
    for (const [t, lo, hi] of this.lineage(tid))
      for (const r of this.all<GoodsRow & { tick: number; timeline_id?: number }>(
        "SELECT * FROM goods WHERE timeline_id=? AND good=? AND tick>=? AND tick<? ORDER BY tick",
        t,
        good,
        lo,
        hi,
      )) {
        delete r.timeline_id
        out.push(r)
      }
    return out
  }

  ledgerRows(
    tid: number,
    tickFrom: number,
    tickTo: number,
    account: string | null = null,
    kind: string | null = null,
    limit = 500,
    offset = 0,
  ): [LedgerRow[], number] {
    let out: LedgerRow[] = []
    for (const [t, lo, hi] of this.lineage(tid)) {
      const a = Math.max(lo, tickFrom)
      const b = Math.min(hi, tickTo + 1)
      if (a >= b) continue
      let q =
        "SELECT tick, src, dst, kind, amount FROM ledger WHERE timeline_id=? AND tick>=? AND tick<?"
      const args: SQLInputValue[] = [t, a, b]
      if (account) {
        q += " AND (src=? OR dst=? OR src LIKE ? OR dst LIKE ?)"
        args.push(account, account, `${account}:%`, `${account}:%`)
      }
      if (kind) {
        q += " AND kind=?"
        args.push(kind)
      }
      out = out.concat(this.all<LedgerRow>(`${q} ORDER BY tick DESC, amount DESC`, ...args))
    }
    out.sort((x, y) => y.tick - x.tick || y.amount - x.amount)
    return [out.slice(offset, offset + limit), out.length]
  }

  /** Aggregate (src, dst, kind) -> amount over a range. */
  ledgerFlows(
    tid: number,
    tickFrom: number,
    tickTo: number,
  ): Map<string, [string, string, string, number]> {
    const agg = new Map<string, [string, string, string, number]>()
    for (const [t, lo, hi] of this.lineage(tid)) {
      const a = Math.max(lo, tickFrom)
      const b = Math.min(hi, tickTo + 1)
      if (a >= b) continue
      for (const r of this.all<{ src: string; dst: string; kind: string; s: number }>(
        "SELECT src, dst, kind, SUM(amount) s FROM ledger WHERE timeline_id=? AND tick>=? AND tick<? " +
          "GROUP BY src, dst, kind",
        t,
        a,
        b,
      )) {
        const k = `${r.src}\u0001${r.dst}\u0001${r.kind}`
        const cur = agg.get(k)
        if (cur) cur[3] += r.s
        else agg.set(k, [r.src, r.dst, r.kind, r.s])
      }
    }
    return agg
  }

  ledgerKinds(tid: number): string[] {
    const kinds = new Set<string>()
    for (const [t] of this.lineage(tid))
      for (const r of this.all<{ kind: string }>(
        "SELECT DISTINCT kind FROM ledger WHERE timeline_id=?",
        t,
      ))
        kinds.add(r.kind)
    return [...kinds].toSorted()
  }

  events(
    tid: number,
    tickFrom = 0,
    tickTo = FAR,
    kinds: string[] | null = null,
    limit = 300,
    search: string | null = null,
  ): EventRow[] {
    let out: (Omit<EventRow, "data"> & { data: string | null })[] = []
    for (const [t, lo, hi] of this.lineage(tid)) {
      const a = Math.max(lo, tickFrom)
      const b = Math.min(hi, tickTo + 1)
      if (a >= b) continue
      let q = "SELECT tick, kind, text, data FROM events WHERE timeline_id=? AND tick>=? AND tick<?"
      const args: SQLInputValue[] = [t, a, b]
      if (kinds?.length) {
        q += ` AND kind IN (${kinds.map(() => "?").join(",")})`
        args.push(...kinds)
      }
      if (search) {
        q += " AND text LIKE ?"
        args.push(`%${search}%`)
      }
      out = out.concat(this.all(`${q} ORDER BY tick DESC, id DESC`, ...args))
    }
    out.sort((x, y) => y.tick - x.tick)
    return out.slice(0, limit).map((r) => ({
      ...r,
      data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : {},
    }))
  }

  /** Latest detail export of a kind at or before tick along the lineage. */
  detail(tid: number, tick: number, kind: string): { tick: number; data: unknown } | null {
    let best: [number, string] | null = null
    for (const [t, lo, hi] of this.lineage(tid)) {
      const r = this.get<{ tick: number; data: string }>(
        "SELECT tick, data FROM details WHERE timeline_id=? AND kind=? AND tick>=? AND tick<? AND tick<=? " +
          "ORDER BY tick DESC LIMIT 1",
        t,
        kind,
        lo,
        hi,
        tick,
      )
      if (r && (best === null || r.tick >= best[0])) best = [r.tick, r.data]
    }
    return best ? { tick: best[0], data: JSON.parse(best[1]) as unknown } : null
  }

  dbSize(): number {
    try {
      return statSync(this.path).size
    } catch {
      return 0
    }
  }
}
