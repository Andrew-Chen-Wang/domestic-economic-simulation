"""SQLite persistence: branching timelines, snapshots, ledger, metrics,
goods flows, events and periodic detail exports.

A timeline is a sequence of months. A child timeline branches from its parent
at `fork_tick`: for earlier months it shares the parent's history. Rewinding
loads the nearest snapshot at or before the fork tick from the lineage and
replays deterministically (the RNG state is part of the snapshot).
"""
import json
import os
import pickle
import sqlite3
import threading
import time
import zlib

SCHEMA = """
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
"""


class Store:
    def __init__(self, path):
        self.path = path
        d = os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)
        self._local = threading.local()
        self.lock = threading.RLock()
        c = self.conn()
        c.executescript(SCHEMA)
        c.commit()

    def conn(self):
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            c.row_factory = sqlite3.Row
            self._local.conn = c
        return c

    # ----------------------------------------------------------- timelines
    def create_timeline(self, name, scenario, seed, parent_id=None, fork_tick=0,
                        start_year=None, scale=None, note=None):
        with self.lock:
            c = self.conn()
            cur = c.execute(
                "INSERT INTO timelines(parent_id, fork_tick, name, scenario, seed, created_at, head_tick,"
                " start_year, scale, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (parent_id, fork_tick, name, scenario, seed, time.time(), fork_tick, start_year, scale, note))
            c.commit()
            return cur.lastrowid

    def timeline(self, tid):
        r = self.conn().execute("SELECT * FROM timelines WHERE id=?", (tid,)).fetchone()
        return dict(r) if r else None

    def timelines(self):
        return [dict(r) for r in self.conn().execute("SELECT * FROM timelines ORDER BY id")]

    def set_head(self, tid, tick):
        with self.lock:
            c = self.conn()
            c.execute("UPDATE timelines SET head_tick=? WHERE id=?", (tick, tid))
            c.commit()

    def rename(self, tid, name):
        with self.lock:
            c = self.conn()
            c.execute("UPDATE timelines SET name=? WHERE id=?", (name, tid))
            c.commit()

    def delete_timeline(self, tid):
        """Delete a timeline and all its descendants."""
        with self.lock:
            c = self.conn()
            kids = [r["id"] for r in c.execute("SELECT id FROM timelines WHERE parent_id=?", (tid,))]
            for k in kids:
                self.delete_timeline(k)
            for t in ("snapshots", "policy_events", "metrics", "goods", "ledger", "events", "details", "accounts"):
                c.execute(f"DELETE FROM {t} WHERE timeline_id=?", (tid,))
            c.execute("DELETE FROM timelines WHERE id=?", (tid,))
            c.commit()

    def lineage(self, tid):
        """[(timeline_id, from_tick, to_tick_exclusive)] from root to tid."""
        chain = []
        t = self.timeline(tid)
        upper = 10 ** 9
        while t:
            lo = t["fork_tick"] if t["parent_id"] else 0
            chain.append((t["id"], lo, upper))
            upper = lo
            t = self.timeline(t["parent_id"]) if t["parent_id"] else None
        chain.reverse()
        return chain

    def owner_of(self, tid, tick):
        for t, lo, hi in self.lineage(tid):
            if lo <= tick < hi:
                return t
        return tid

    # ----------------------------------------------------------- snapshots
    def save_snapshot(self, tid, tick, world):
        blob = zlib.compress(pickle.dumps(world, protocol=pickle.HIGHEST_PROTOCOL), 3)
        with self.lock:
            c = self.conn()
            c.execute("INSERT OR REPLACE INTO snapshots(timeline_id, tick, blob) VALUES (?,?,?)",
                      (tid, tick, blob))
            c.commit()

    def nearest_snapshot(self, tid, tick):
        """Latest snapshot at or before `tick` along the lineage."""
        best = None
        for t, lo, hi in self.lineage(tid):
            r = self.conn().execute(
                "SELECT tick FROM snapshots WHERE timeline_id=? AND tick>=? AND tick<? AND tick<=? "
                "ORDER BY tick DESC LIMIT 1", (t, lo, hi, tick)).fetchone()
            if r and (best is None or r["tick"] >= best[1]):
                best = (t, r["tick"])
        return best

    def load_snapshot(self, tid, tick):
        r = self.conn().execute("SELECT blob FROM snapshots WHERE timeline_id=? AND tick=?",
                                (tid, tick)).fetchone()
        return pickle.loads(zlib.decompress(r["blob"])) if r else None

    # -------------------------------------------------------------- policy
    def add_policy(self, tid, tick, patch, note=""):
        with self.lock:
            c = self.conn()
            c.execute("INSERT INTO policy_events(timeline_id, tick, patch, note, created_at) VALUES (?,?,?,?,?)",
                      (tid, tick, json.dumps(patch), note, time.time()))
            c.commit()

    def policy_events(self, tid, lo=0, hi=10 ** 9, own_only=False):
        out = []
        segs = [(tid, 0, 10 ** 9)] if own_only else self.lineage(tid)
        for t, a, b in segs:
            for r in self.conn().execute(
                    "SELECT * FROM policy_events WHERE timeline_id=? AND tick>=? AND tick<? ORDER BY tick, id",
                    (t, max(a, lo), min(b, hi))):
                d = dict(r)
                d["patch"] = json.loads(d["patch"])
                out.append(d)
        out.sort(key=lambda x: (x["tick"], x["id"]))
        return out

    # ------------------------------------------------------------- writes
    def write_month(self, tid, tick, metrics, goods_rows, ledger_rows, events):
        with self.lock:
            c = self.conn()
            c.execute("INSERT OR REPLACE INTO metrics(timeline_id, tick, data) VALUES (?,?,?)",
                      (tid, tick, json.dumps(metrics, separators=(",", ":"))))
            c.execute("DELETE FROM goods WHERE timeline_id=? AND tick=?", (tid, tick))
            c.executemany(
                "INSERT INTO goods VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [(tid, tick) + r for r in goods_rows])
            c.execute("DELETE FROM ledger WHERE timeline_id=? AND tick=?", (tid, tick))
            c.executemany("INSERT INTO ledger VALUES (?,?,?,?,?,?)",
                          [(tid, tick) + r for r in ledger_rows])
            c.executemany("INSERT INTO events(timeline_id, tick, kind, text, data) VALUES (?,?,?,?,?)",
                          [(tid, e["tick"], e["kind"], e["text"], json.dumps(e.get("data", {})))
                           for e in events])
            c.commit()

    def write_accounts(self, tid, rows):
        with self.lock:
            c = self.conn()
            c.executemany("INSERT OR IGNORE INTO accounts(timeline_id, account, label, sector) VALUES (?,?,?,?)",
                          [(tid,) + r for r in rows])
            c.commit()

    def accounts(self, tid):
        out = {}
        for t, lo, hi in self.lineage(tid):
            for r in self.conn().execute("SELECT account, label, sector FROM accounts WHERE timeline_id=?", (t,)):
                out[r["account"]] = {"label": r["label"], "sector": r["sector"]}
        return out

    def write_events(self, tid, events):
        with self.lock:
            c = self.conn()
            c.executemany("INSERT INTO events(timeline_id, tick, kind, text, data) VALUES (?,?,?,?,?)",
                          [(tid, e["tick"], e["kind"], e["text"], json.dumps(e.get("data", {}))) for e in events])
            c.commit()

    def write_detail(self, tid, tick, kind, data):
        with self.lock:
            c = self.conn()
            c.execute("INSERT OR REPLACE INTO details(timeline_id, tick, kind, data) VALUES (?,?,?,?)",
                      (tid, tick, kind, json.dumps(data, separators=(",", ":"))))
            c.commit()

    def truncate_after(self, tid, tick):
        """Remove a timeline's own data at or after `tick` (used when re-running)."""
        with self.lock:
            c = self.conn()
            for t in ("metrics", "goods", "ledger", "events", "details"):
                c.execute(f"DELETE FROM {t} WHERE timeline_id=? AND tick>=?", (tid, tick))
            c.execute("DELETE FROM snapshots WHERE timeline_id=? AND tick>?", (tid, tick))
            c.commit()

    # -------------------------------------------------------------- reads
    def series(self, tid, keys=None, upto=None):
        out = []
        for t, lo, hi in self.lineage(tid):
            if upto is not None:
                hi = min(hi, upto + 1)
            for r in self.conn().execute(
                    "SELECT tick, data FROM metrics WHERE timeline_id=? AND tick>=? AND tick<? ORDER BY tick",
                    (t, lo, hi)):
                d = json.loads(r["data"])
                if keys:
                    d = {k: d.get(k) for k in keys}
                d["tick"] = r["tick"]
                out.append(d)
        return out

    def metrics_at(self, tid, tick):
        t = self.owner_of(tid, tick)
        r = self.conn().execute("SELECT data FROM metrics WHERE timeline_id=? AND tick=?", (t, tick)).fetchone()
        return json.loads(r["data"]) if r else None

    def goods_at(self, tid, tick):
        t = self.owner_of(tid, tick)
        cols = ["good", "price", "output", "dom_sold", "imports", "exports", "hh_qty", "hh_value",
                "gov_value", "inv_value", "firm_value", "import_value", "export_value", "shortage", "producers"]
        rows = self.conn().execute(f"SELECT {','.join(cols)} FROM goods WHERE timeline_id=? AND tick=?",
                                   (t, tick)).fetchall()
        return [dict(r) for r in rows]

    def good_series(self, tid, good):
        out = []
        for t, lo, hi in self.lineage(tid):
            for r in self.conn().execute(
                    "SELECT * FROM goods WHERE timeline_id=? AND good=? AND tick>=? AND tick<? ORDER BY tick",
                    (t, good, lo, hi)):
                d = dict(r)
                d.pop("timeline_id", None)
                out.append(d)
        return out

    def ledger_rows(self, tid, tick_from, tick_to, account=None, kind=None, limit=500, offset=0):
        out = []
        for t, lo, hi in self.lineage(tid):
            a, b = max(lo, tick_from), min(hi, tick_to + 1)
            if a >= b:
                continue
            q = "SELECT tick, src, dst, kind, amount FROM ledger WHERE timeline_id=? AND tick>=? AND tick<?"
            args = [t, a, b]
            if account:
                q += " AND (src=? OR dst=? OR src LIKE ? OR dst LIKE ?)"
                args += [account, account, account + ":%", account + ":%"]
            if kind:
                q += " AND kind=?"
                args.append(kind)
            q += " ORDER BY tick DESC, amount DESC"
            out += [dict(r) for r in self.conn().execute(q, args)]
        out.sort(key=lambda r: (-r["tick"], -r["amount"]))
        return out[offset: offset + limit], len(out)

    def ledger_flows(self, tid, tick_from, tick_to):
        """Aggregate (src, dst, kind) -> amount over a range."""
        agg = {}
        for t, lo, hi in self.lineage(tid):
            a, b = max(lo, tick_from), min(hi, tick_to + 1)
            if a >= b:
                continue
            for r in self.conn().execute(
                    "SELECT src, dst, kind, SUM(amount) s FROM ledger WHERE timeline_id=? AND tick>=? AND tick<? "
                    "GROUP BY src, dst, kind", (t, a, b)):
                k = (r["src"], r["dst"], r["kind"])
                agg[k] = agg.get(k, 0.0) + r["s"]
        return agg

    def ledger_kinds(self, tid):
        kinds = set()
        for t, lo, hi in self.lineage(tid):
            for r in self.conn().execute("SELECT DISTINCT kind FROM ledger WHERE timeline_id=?", (t,)):
                kinds.add(r["kind"])
        return sorted(kinds)

    def events(self, tid, tick_from=0, tick_to=10 ** 9, kinds=None, limit=300, search=None):
        out = []
        for t, lo, hi in self.lineage(tid):
            a, b = max(lo, tick_from), min(hi, tick_to + 1)
            if a >= b:
                continue
            q = "SELECT tick, kind, text, data FROM events WHERE timeline_id=? AND tick>=? AND tick<?"
            args = [t, a, b]
            if kinds:
                q += " AND kind IN (%s)" % ",".join("?" * len(kinds))
                args += list(kinds)
            if search:
                q += " AND text LIKE ?"
                args.append("%" + search + "%")
            out += [dict(r) for r in self.conn().execute(q + " ORDER BY tick DESC, id DESC", args)]
        out.sort(key=lambda r: -r["tick"])
        for r in out:
            r["data"] = json.loads(r["data"]) if r["data"] else {}
        return out[:limit]

    def detail(self, tid, tick, kind):
        """Latest detail export of a kind at or before tick along the lineage."""
        best = None
        for t, lo, hi in self.lineage(tid):
            r = self.conn().execute(
                "SELECT tick, data FROM details WHERE timeline_id=? AND kind=? AND tick>=? AND tick<? AND tick<=? "
                "ORDER BY tick DESC LIMIT 1", (t, kind, lo, hi, tick)).fetchone()
            if r and (best is None or r["tick"] >= best[0]):
                best = (r["tick"], r["data"])
        if not best:
            return None
        return {"tick": best[0], "data": json.loads(best[1])}

    def db_size(self):
        try:
            return os.path.getsize(self.path)
        except OSError:
            return 0
