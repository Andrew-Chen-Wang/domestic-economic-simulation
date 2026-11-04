#!/usr/bin/env python3
"""Simulation engine API (stdlib only). The UI is the Next.js app in
frontend/, which proxies /api/* here.

    python3 server.py [--port 8000] [--db data/econsim.db]
"""
import argparse
import json
import os
import re
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from econsim import catalog as _catalog  # noqa: E402
from econsim import physical, policy as _policy, world as _world  # noqa: E402
from econsim.engine import Engine  # noqa: E402
from econsim.sim import SECTOR_OF_CAT  # noqa: E402

ENGINE = None
CAT = None
ROUTES = []


def route(method, pattern):
    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn))
        return fn
    return deco


def num(q, k, d=None, cast=int):
    v = q.get(k, [None])[0]
    if v in (None, ""):
        return d
    return cast(v)


# ------------------------------------------------------------------ catalog
@route("GET", "/api/meta")
def meta(q, body):
    return {
        "scenarios": {k: {"label": v["label"], "desc": v["desc"], "year": v["year"],
                          "population": v["population"]} for k, v in _world.SCENARIOS.items()},
        "policy_schema": _policy.SCHEMA, "policy_default": _policy.default(),
        "needs": {k: v[0] for k, v in CAT.needs.items()},
        "sectors": sorted(set(SECTOR_OF_CAT.values())),
        "categories": sorted({g["cat"] for g in CAT.goods.values()}),
        "fields": {k: v[1] for k, v in CAT.fields.items()},
        "research_fields": sorted({k["field"] for k in CAT.knowledge.values()}),
        "summary": CAT.summary(),
        "status": ENGINE.status(),
    }


def good_brief(g):
    return {"id": g["id"], "name": g["name"], "cat": g["cat"], "unit": g["unit"],
            "price": g["price"], "year": g["year"], "need": g["need"][0] if g["need"] else None,
            "tol": g["tol"], "clean": g["clean"], "capital": g["capital"], "svc": g["svc"],
            "nt": g["nt"], "local": g["local"], "restricted": g["restricted"],
            "sector": SECTOR_OF_CAT.get(g["cat"], "Other"), "kg": g["kg"], "opq": g["opq"],
            "prec": g["prec"]}


@route("GET", "/api/catalog")
def catalog(q, body):
    return {
        "goods": [good_brief(g) for g in CAT.goods.values() if not g.get("endowment")],
        "knowledge": [dict(v, year_eff=CAT.kyear[k]) for k, v in CAT.knowledge.items()],
        "occupations": list(CAT.occupations.values()),
    }


@route("GET", r"/api/catalog/good/([\w]+)")
def catalog_good(q, body, gid):
    g = CAT.goods[gid]
    procs = []
    for pid in g["processes"]:
        p = CAT.procs[pid]
        procs.append({
            "id": pid, "trad": p["trad"], "year": p["year"], "rate": p["rate"],
            "inputs": [{"alts": [{"id": a, "name": CAT.goods[a]["name"]} for a in alts], "qty": qty,
                        "optional": alts[0] in p.get("optional", ())} for alts, qty in p["inputs"]],
            "equip": [{"id": a, "name": CAT.goods[a]["name"], "prec": CAT.goods[a]["prec"]} for a in (p["equip"] or [])],
            "aux": [{"alts": [{"id": a, "name": CAT.goods[a]["name"]} for a in alts], "ratio": r,
                     "optional": name in p.get("optional", ())} for name, (alts, r) in p["aux"].items()],
            "labor": [{"occ": o, "name": CAT.occupations[o]["name"], "hours": h} for o, h in p["labor"].items()],
            "know": [{"id": k, "name": CAT.knowledge[k]["name"], "year": CAT.kyear[k]} for k in p["know"]],
            "dep": p["dep"], "co2": p["co2"], "design_effort": p["design_effort"],
        })
    used_in = sorted({CAT.procs[x]["good"] for x in CAT.used_as_input[gid]})
    used_eq = sorted({CAT.procs[x]["good"] for x in CAT.used_as_equip[gid]})
    return {"good": good_brief(g), "processes": procs,
            "used_in": [{"id": x, "name": CAT.goods[x]["name"]} for x in used_in],
            "used_as_equipment_by": [{"id": x, "name": CAT.goods[x]["name"]} for x in used_eq]}


# ---------------------------------------------------------------- timelines
@route("GET", "/api/timelines")
def timelines(q, body):
    out = []
    for t in ENGINE.store.timelines():
        t["policy_events"] = ENGINE.store.policy_events(t["id"], own_only=True)
        out.append(t)
    return {"timelines": out, "status": ENGINE.status()}


@route("POST", "/api/timelines")
def create(q, body):
    ENGINE.create(body.get("scenario", "emerging_2025"), int(body.get("seed", 1)),
                  body.get("name"), body.get("burn_in"))
    return {"status": ENGINE.status()}


@route("POST", r"/api/timelines/(\d+)/run")
def run(q, body, tid):
    ENGINE.run(int(tid), int(body.get("months", 12)))
    return {"status": ENGINE.status()}


@route("POST", r"/api/timelines/(\d+)/policy")
def set_policy(q, body, tid):
    tick = body.get("tick")
    r = ENGINE.apply_policy(int(tid), body.get("patch", {}), body.get("note", ""),
                            None if tick is None else int(tick), body.get("branch_name"))
    return r


@route("POST", r"/api/timelines/(\d+)/fork")
def fork(q, body, tid):
    new = ENGINE.fork(int(tid), int(body["tick"]), body.get("name") or "Branch")
    return {"timeline": new}


@route("POST", r"/api/timelines/(\d+)/rename")
def rename(q, body, tid):
    ENGINE.store.rename(int(tid), body.get("name", ""))
    return {"ok": True}


@route("DELETE", r"/api/timelines/(\d+)")
def delete(q, body, tid):
    ENGINE.delete(int(tid))
    return {"ok": True}


@route("GET", "/api/status")
def status(q, body):
    return ENGINE.status()


@route("POST", "/api/cancel")
def cancel(q, body):
    ENGINE.cancel()
    return ENGINE.status()


@route("GET", r"/api/timelines/(\d+)/series")
def series(q, body, tid):
    keys = q.get("keys", [""])[0]
    keys = [k for k in keys.split(",") if k] or None
    return {"series": ENGINE.store.series(int(tid), keys)}


@route("GET", r"/api/timelines/(\d+)/metrics")
def metrics(q, body, tid):
    tid = int(tid)
    tl = ENGINE.store.timeline(tid)
    tick = num(q, "tick", tl["head_tick"] - 1)
    return {"tick": tick, "metrics": ENGINE.store.metrics_at(tid, tick)}


@route("GET", r"/api/timelines/(\d+)/policy")
def get_policy(q, body, tid):
    tid = int(tid)
    tl = ENGINE.store.timeline(tid)
    pol = ENGINE.effective_policy(tid) if not ENGINE.busy() or ENGINE.status().get("timeline") != tid \
        else ENGINE.head_world(tid).policy
    return {"policy": pol, "head": tl["head_tick"], "events": ENGINE.store.policy_events(tid),
            "regions": [{"id": r.id, "name": r.name} for r in ENGINE.head_world(tid).regions]}


@route("GET", r"/api/timelines/(\d+)/goods")
def goods(q, body, tid):
    tid = int(tid)
    tl = ENGINE.store.timeline(tid)
    tick = num(q, "tick", tl["head_tick"] - 1)
    rows = ENGINE.store.goods_at(tid, tick)
    for r in rows:
        g = CAT.goods.get(r["good"])
        if g:
            r.update(name=g["name"], cat=g["cat"], sector=SECTOR_OF_CAT.get(g["cat"], "Other"),
                     unit=g["unit"], need=g["need"][0] if g["need"] else None)
    return {"tick": tick, "goods": rows}


def world_for(tid, tick):
    tl = ENGINE.store.timeline(tid)
    if tick is None or tick >= tl["head_tick"]:
        return ENGINE.head_world(tid)
    return ENGINE.world_at(tid, tick)


@route("GET", r"/api/timelines/(\d+)/good/([\w]+)")
def good(q, body, tid, gid):
    tid = int(tid)
    tick = num(q, "tick")
    if ENGINE.busy() and ENGINE.status().get("timeline") == tid:
        w = ENGINE.head_world(tid)
    else:
        w = world_for(tid, tick)
    return {"series": ENGINE.store.good_series(tid, gid), "explain": physical.explain(w, CAT, gid),
            "tick": w.tick}


@route("GET", r"/api/timelines/(\d+)/flows")
def flows(q, body, tid):
    tid = int(tid)
    tl = ENGINE.store.timeline(tid)
    hi = num(q, "to", tl["head_tick"] - 1)
    lo = num(q, "from", max(0, hi - 11))
    agg = ENGINE.store.ledger_flows(tid, lo, hi)
    accts = ENGINE.store.accounts(tid)

    def node(a):
        if a.startswith("hh"):
            return "Households"
        if a == "gov":
            return "Government"
        if a == "bank":
            return "Banks"
        if a == "row":
            return "Rest of world"
        if a.startswith("market:freight"):
            return "Transport & logistics"
        if a.startswith("market:") or a.startswith("sector:"):
            return a.split(":", 1)[1]
        if a.startswith("firm:"):
            return accts.get(a, {}).get("sector", "Other")
        return a

    links = {}
    kinds = {}
    for (s, d, k), v in agg.items():
        a, b = node(s), node(d)
        if a == b or v <= 0:
            continue
        links[(a, b)] = links.get((a, b), 0.0) + v
        kinds.setdefault((a, b), {})
        kinds[(a, b)][k] = kinds[(a, b)].get(k, 0.0) + v
    out = [{"source": a, "target": b, "value": v, "kinds": kinds[(a, b)]} for (a, b), v in links.items()]
    out.sort(key=lambda x: -x["value"])
    return {"from": lo, "to": hi, "links": out}


@route("GET", r"/api/timelines/(\d+)/ledger")
def ledger(q, body, tid):
    tid = int(tid)
    tl = ENGINE.store.timeline(tid)
    hi = num(q, "to", tl["head_tick"] - 1)
    lo = num(q, "from", hi)
    rows, total = ENGINE.store.ledger_rows(tid, lo, hi, q.get("account", [None])[0] or None,
                                          q.get("kind", [None])[0] or None,
                                          num(q, "limit", 300), num(q, "offset", 0))
    accts = ENGINE.store.accounts(tid)
    labels = {}
    for r in rows:
        for a in (r["src"], r["dst"]):
            if a in accts:
                labels[a] = accts[a]["label"]
    return {"rows": rows, "total": total, "labels": labels, "kinds": ENGINE.store.ledger_kinds(tid)}


@route("GET", r"/api/timelines/(\d+)/events")
def events(q, body, tid):
    kinds = q.get("kinds", [""])[0]
    kinds = [k for k in kinds.split(",") if k] or None
    return {"events": ENGINE.store.events(int(tid), num(q, "from", 0), num(q, "to", 10 ** 9), kinds,
                                          num(q, "limit", 400), q.get("search", [None])[0])}


@route("GET", r"/api/timelines/(\d+)/detail/(\w+)")
def detail(q, body, tid, kind):
    tid = int(tid)
    tl = ENGINE.store.timeline(tid)
    return ENGINE.store.detail(tid, num(q, "tick", tl["head_tick"]), kind) or {"tick": None, "data": None}


# ------------------------------------------------------------------- server
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("ECONSIM_LOG"):
            super().log_message(fmt, *args)

    def _send(self, code, payload, ctype="application/json"):
        data = payload if isinstance(payload, bytes) else json.dumps(payload, default=_json_default).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, method):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        body = {}
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return self._send(400, {"error": "bad json"})
        if u.path.startswith("/api/"):
            for m, rx, fn in ROUTES:
                if m != method:
                    continue
                mt = rx.match(u.path)
                if mt:
                    try:
                        return self._send(200, fn(q, body, *mt.groups()))
                    except (RuntimeError, ValueError, KeyError) as e:
                        return self._send(400, {"error": str(e)})
                    except Exception as e:  # pragma: no cover
                        traceback.print_exc()
                        return self._send(500, {"error": str(e)})
            return self._send(404, {"error": "not found"})
        return self._send(404, {"error": "This is the simulation API. Open the Next.js frontend (pnpm --dir frontend dev) at http://localhost:3000"})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_DELETE(self):
        self._handle("DELETE")


def _json_default(o):
    if isinstance(o, (set, tuple)):
        return list(o)
    return str(o)


def main():
    global ENGINE, CAT
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--db", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "econsim.db"))
    a = ap.parse_args()
    CAT = _catalog.get()
    ENGINE = Engine(a.db)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"Domestic economic simulation running at http://{a.host}:{a.port}  (db: {a.db})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
