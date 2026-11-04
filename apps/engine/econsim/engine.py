"""Engine: creates worlds, runs timelines, applies policy decisions, and
rewinds/branches by deterministic replay from snapshots.

Snapshot convention: a snapshot at tick t is the state at the *start* of
month t, before that month's policy decisions are applied. Running a month:
apply decisions recorded for (timeline, t) -> simulate month t -> write.
"""
import threading
import time
import traceback
from collections import defaultdict

from . import catalog as _catalog
from . import policy as _policy
from . import world as _world
from .sim import Sim, SECTOR_OF_CAT
from .store import Store

SNAPSHOT_EVERY = 12


def create_world(scenario="emerging_2025", seed=1, burn_in=None, overrides=None, progress=None):
    w = _world.generate(scenario, seed, overrides)
    if burn_in is None:
        burn_in = _world.SCENARIOS[scenario].get("burn_in", 36)
    s = Sim(w)
    for i in range(burn_in):
        s.step()
        if progress:
            progress(i + 1, burn_in)
    # the burn-in is pre-history: reset the clock, keep the settled state
    w.tick = 0
    w.price_index = 1.0
    st = w.stats
    st["cpi_hist"] = [1.0]
    st["inflation"] = 0.02
    st["rgdp_hist"] = []
    w.events = [e for e in w.events if e["kind"] == "info"][:1]
    for e in w.events:
        e["tick"] = 0
    w.event("info", f"Economy settled after a {burn_in}-month warm-up: {len(w.firms)} firms operating, "
                    f"unemployment {st.get('unemployment', 0):.1%}. The clock starts now.")
    return w


class Engine:
    def __init__(self, db_path):
        self.store = Store(db_path)
        self.cat = _catalog.get()
        self.cache = {}          # timeline id -> World at its head tick
        self.job = None
        self.lock = threading.RLock()
        self._cancel = False
        self._known_accounts = {}

    # ----------------------------------------------------------------- jobs
    def busy(self):
        return self.job is not None and self.job.get("state") == "running"

    def status(self):
        return dict(self.job) if self.job else {"state": "idle"}

    def cancel(self):
        self._cancel = True

    def _start(self, kind, fn, total, tid=None):
        if self.busy():
            raise RuntimeError("Another simulation job is running")
        self._cancel = False
        self.job = {"kind": kind, "state": "running", "done": 0, "total": total, "timeline": tid,
                    "started": time.time(), "message": ""}

        def wrap():
            try:
                fn()
                if self.job["state"] == "running":
                    self.job["state"] = "done"
            except Exception as e:  # pragma: no cover - surfaced to the UI
                self.job["state"] = "error"
                self.job["message"] = f"{e}\n{traceback.format_exc()}"
            self.job["finished"] = time.time()

        th = threading.Thread(target=wrap, daemon=True)
        th.start()
        return self.job

    # ----------------------------------------------------------- creation
    def create(self, scenario, seed=1, name=None, burn_in=None, background=True):
        sc = _world.SCENARIOS[scenario]
        if burn_in is None:
            burn_in = sc.get("burn_in", 36)
        result = {}

        def work():
            def prog(i, n):
                if self.job:
                    self.job["done"] = i
            w = create_world(scenario, seed, burn_in, progress=prog)
            tid = self.store.create_timeline(name or sc["label"], scenario, seed,
                                             start_year=w.start_year, scale=w.scale)
            self.store.save_snapshot(tid, 0, w)
            self._write_details(tid, w)
            self.store.write_events(tid, w.events)
            w.events = []
            self.cache[tid] = w
            result["tid"] = tid
            if self.job:
                self.job["timeline"] = tid

        if background:
            self._start("create", work, burn_in)
            return None
        work()
        return result["tid"]

    # ---------------------------------------------------------- world access
    def _events_at(self, tid, tick):
        owner = self.store.owner_of(tid, tick)
        return [e for e in self.store.policy_events(owner, tick, tick + 1, own_only=True)]

    def world_at(self, tid, tick, include_events=False):
        """Reconstruct the state at the start of `tick` on this timeline."""
        head = self.store.timeline(tid)["head_tick"]
        if tick == head and tid in self.cache and not include_events:
            return self.cache[tid]
        snap = self.store.nearest_snapshot(tid, tick)
        if snap is None:
            raise ValueError("no snapshot available")
        w = self.store.load_snapshot(*snap)
        sim = Sim(w)
        while w.tick < tick:
            for e in self._events_at(tid, w.tick):
                w.policy = _policy.apply_patch(w.policy, e["patch"])
            sim.step()
            w.events = []
        if include_events:
            for e in self._events_at(tid, w.tick):
                w.policy = _policy.apply_patch(w.policy, e["patch"])
        return w

    def head_world(self, tid):
        if tid in self.cache:
            return self.cache[tid]
        head = self.store.timeline(tid)["head_tick"]
        w = self.world_at(tid, head)
        self.cache[tid] = w
        return w

    def effective_policy(self, tid):
        w = self.head_world(tid)
        pol = w.policy
        for e in self._events_at(tid, w.tick):
            pol = _policy.apply_patch(pol, e["patch"])
        return pol

    # --------------------------------------------------------------- running
    def run(self, tid, months, background=True):
        def work():
            w = self.head_world(tid)
            sim = Sim(w)
            for i in range(months):
                if self._cancel:
                    self.job["state"] = "cancelled"
                    break
                t = w.tick
                for e in self._events_at(tid, t):
                    w.policy = _policy.apply_patch(w.policy, e["patch"])
                    w.event("policy", "Policy decision: " + (e.get("note") or _describe_patch(e["patch"])),
                            patch=e["patch"])
                ctx, m = sim.step()
                self._write(tid, t, w, ctx, m)
                if w.tick % SNAPSHOT_EVERY == 0:
                    self.store.save_snapshot(tid, w.tick, w)
                if w.tick % 12 == 0:
                    self._write_details(tid, w, ctx)
                self.store.set_head(tid, w.tick)
                if self.job:
                    self.job["done"] = i + 1
            # always leave a snapshot and details at the head
            self.store.save_snapshot(tid, w.tick, w)
            self._write_details(tid, w)
            self.store.set_head(tid, w.tick)

        tl = self.store.timeline(tid)
        if tl is None:
            raise ValueError("unknown timeline")
        if background:
            return self._start("run", work, months, tid)
        work()

    def _write(self, tid, tick, w, ctx, m):
        cat = self.cat
        out = defaultdict(float)
        prod = defaultdict(int)
        for f in w.firms.values():
            fs = ctx.fs.get(f.id)
            if fs and fs.get("net", 0) > 0:
                out[f.good] += fs["net"]
                prod[f.good] += 1
        rows = []
        for gid in set(ctx.flows) | set(out):
            fl = ctx.flows.get(gid, {})
            row = (gid, w.prices.get(gid, 0.0), out.get(gid, 0.0), fl.get("dom_sold", 0.0),
                   fl.get("imports", 0.0), fl.get("exports", 0.0), fl.get("hh_qty", 0.0),
                   fl.get("hh_value", 0.0), fl.get("gov_value", 0.0), fl.get("inv_value", 0.0),
                   fl.get("firm_value", 0.0), fl.get("import_value", 0.0), fl.get("export_value", 0.0),
                   fl.get("shortage", 0.0), prod.get(gid, 0))
            if any(abs(x) > 1e-12 for x in row[2:14]):
                rows.append(row)
        self.store.write_month(tid, tick, m, rows, self._compact_ledger(tid, w, ctx, m), w.events)
        w.events = []

    def _compact_ledger(self, tid, w, ctx, m):
        """Keep large flows at firm level; roll small ones up into sector
        accounts. Market pseudo-accounts are per sector."""
        cat = self.cat
        thr = 0.0002 * max(m.get("gdp", 0.0), 1.0)
        known = self._known_accounts.setdefault(tid, set())
        new_acc = []

        def acc(a, amount):
            if a.startswith("market:"):
                gid = a[7:]
                g = cat.goods.get(gid)
                return "market:" + (SECTOR_OF_CAT.get(g["cat"], "Other") if g else gid)
            if a.startswith("firm:"):
                fid = int(a[5:])
                f = w.firms.get(fid)
                sector = SECTOR_OF_CAT.get(cat.goods[f.good]["cat"], "Other") if f else "Other"
                if amount < thr:
                    return "sector:" + sector
                if a not in known and f:
                    known.add(a)
                    new_acc.append((a, f"{f.name} ({cat.goods[f.good]['name']})", sector))
            return a

        agg = defaultdict(float)
        for (s_, d_, k), amount in ctx.ledger.items():
            if abs(amount) <= 1e-6:
                continue
            agg[(acc(s_, amount), acc(d_, amount), k)] += amount
        if new_acc:
            self.store.write_accounts(tid, new_acc)
        return [(s_, d_, k, a) for (s_, d_, k), a in agg.items()]

    def _write_details(self, tid, w, ctx=None):
        cat = self.cat
        S = w.scale
        firms = []
        for f in w.firms.values():
            g = cat.goods[f.good]
            firms.append({
                "id": f.id, "name": f.name, "good": f.good, "good_name": g["name"], "cat": g["cat"],
                "sector": SECTOR_OF_CAT.get(g["cat"], "Other"), "region": f.region,
                "owner": f.owner, "founded": f.founded, "proc": f.proc,
                "trad": cat.procs[f.proc]["trad"], "output": f.last.get("output", 0),
                "revenue": f.last.get("revenue", 0), "exports": f.last.get("exports", 0),
                "profit": f.profit_ema, "staff": sum(f.staff.values()) * S, "cash": f.cash,
                "debt": f.debt, "price": f.price, "design": f.design, "gen": f.gen,
                "quality": f.quality, "util": f.util_ema, "blocked": f.blocked,
                "equipment": {e: round(n, 4) for e, n in f.equip.items() if n > 1e-6},
            })
        self.store.write_detail(tid, w.tick, "firms", firms)
        self.store.write_detail(tid, w.tick, "knowledge", {k: round(v, 4) for k, v in w.knowledge.items()})
        occ = {}
        ret = w.policy["retirement_age"] * 12
        for p in w.persons.values():
            if p.occ is None or p.school or p.age < 15 * 12 or p.age >= ret:
                continue
            o = occ.setdefault(p.occ, {"lf": 0, "emp": 0.0, "skill": 0.0, "inactive": 0, "wage": 0.0,
                                       "edu": [0] * 6})
            if p.inactive:
                o["inactive"] += S
                continue
            o["lf"] += S
            o["emp"] += p.fte * S
            o["skill"] += p.skill.get(p.occ, 0) * S
            o["edu"][p.edu] += S
        for o, d in occ.items():
            d["skill"] = d["skill"] / d["lf"] if d["lf"] else 0
            d["wage"] = w.wage_index.get(o, 0)
            d["vacancies"] = w.stats.get("vacancies_by_occ", {}).get(o, 0) * S
        self.store.write_detail(tid, w.tick, "labor", occ)
        regions = []
        for r in w.regions:
            regions.append({"id": r.id, "name": r.name, "arch": r.arch, "area": r.area, "urban_km2": r.urban_km2,
                            "temp": r.temp, "rain": r.rain, "sun": r.sun, "wind": r.wind, "port": r.port,
                            "pos": r.pos, "pop": r.pop * S, "urban_pop": r.urban_pop * S, "infra": r.infra,
                            "dwellings": r.dwellings, "rent": r.rent, "productivity": r.productivity,
                            "land": r.land, "land_used": r.land_used,
                            "deposits": {k: {"qty": d["qty"], "qty0": d["qty0"], "grade": d["grade"],
                                             "kind": d["kind"]} for k, d in r.deposits.items()},
                            "suit": {k: round(v, 3) for k, v in r.suit.items()}})
        self.store.write_detail(tid, w.tick, "regions", {"regions": regions, "dist": w.dist})
        self.store.write_detail(tid, w.tick, "state", {
            "produced_ever": sorted(w.produced_ever), "fx": w.fx, "price_index": w.price_index,
            "gov": {k: v for k, v in w.gov.items() if isinstance(v, (int, float))},
            "bank": w.bank, "policy": w.policy, "year": w.year,
            "prices": {k: v for k, v in w.prices.items()},
        })

    # ---------------------------------------------------------- decisions
    def apply_policy(self, tid, patch, note="", tick=None, branch_name=None):
        """Record a decision. At the head it applies to this timeline; at an
        earlier tick it creates a branch (rewind)."""
        tl = self.store.timeline(tid)
        head = tl["head_tick"]
        if tick is None or tick >= head:
            self.store.add_policy(tid, head, patch, note)
            return {"timeline": tid, "tick": head, "branched": False}
        new = self.fork(tid, tick, branch_name or f"{tl['name']} / alt @ {tick}", patch, note)
        return {"timeline": new, "tick": tick, "branched": True}

    def fork(self, tid, tick, name, patch=None, note=""):
        if self.busy():
            raise RuntimeError("A simulation job is running")
        tl = self.store.timeline(tid)
        tick = max(0, min(int(tick), tl["head_tick"]))
        w = self.world_at(tid, tick, include_events=False)
        import copy
        w = copy.deepcopy(w)
        new = self.store.create_timeline(name, tl["scenario"], tl["seed"], parent_id=tid, fork_tick=tick,
                                         start_year=tl["start_year"], scale=tl["scale"],
                                         note=note or None)
        if patch:
            self.store.add_policy(new, tick, patch, note)
        self.store.save_snapshot(new, tick, w)
        self._write_details(new, w)
        self.cache[new] = w
        return new

    def delete(self, tid):
        if self.busy():
            raise RuntimeError("A simulation job is running")
        for t in [x["id"] for x in self.store.timelines()]:
            if t == tid or t in self._descendants(tid):
                self.cache.pop(t, None)
        self.store.delete_timeline(tid)

    def _descendants(self, tid):
        out = set()
        for t in self.store.timelines():
            if t["parent_id"] == tid:
                out.add(t["id"])
                out |= self._descendants(t["id"])
        return out


def _describe_patch(patch):
    parts = []
    for k, v in patch.items():
        if isinstance(v, dict):
            parts.append(f"{k}: " + ", ".join(f"{a}={b}" for a, b in v.items()))
        else:
            parts.append(f"{k}={v}")
    return "; ".join(parts)
