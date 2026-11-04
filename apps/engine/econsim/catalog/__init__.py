"""Catalog builder.

Parses the human-readable tables, generates traditional (pre-industrial)
alternative processes, works out when each good first became possible in the
world (from its knowledge + input + equipment chain), and calibrates labor
hours and equipment throughput so that, at 2025 frontier wages and prices,
every process covers its costs. Physical quantities (inputs, energy, mass,
tolerances) come straight from the tables.
"""
import math

from . import goods as _goods
from . import knowledge as _knowledge
from . import people as _people
from . import resources as _resources

MONTHLY_RATE = 0.005  # cost of capital used for calibration (6%/yr)

NEEDS = {
    # need: (label, share at [100, 600, 3000] W$/person/month)
    "food":            ("Food & groceries",        (0.42, 0.18, 0.08)),
    "alcohol_tobacco": ("Alcohol & tobacco",       (0.03, 0.03, 0.02)),
    "clothing":        ("Clothing & footwear",     (0.07, 0.05, 0.04)),
    "housing":         ("Housing",                 (0.15, 0.22, 0.23)),
    "utilities":       ("Energy & utilities",      (0.06, 0.05, 0.03)),
    "furnishing":      ("Furnishings & appliances",(0.03, 0.05, 0.05)),
    "health":          ("Health",                  (0.03, 0.05, 0.08)),
    "transport":       ("Transport",               (0.05, 0.11, 0.12)),
    "communication":   ("Communication",           (0.02, 0.04, 0.03)),
    "recreation":      ("Recreation & culture",    (0.03, 0.07, 0.10)),
    "education":       ("Education",               (0.02, 0.02, 0.02)),
    "restaurants":     ("Restaurants & hotels",    (0.03, 0.06, 0.08)),
    "personal_care":   ("Personal care & cosmetics",(0.02, 0.03, 0.03)),
    "misc":            ("Financial & other services",(0.02, 0.04, 0.09)),
}
ENGEL_POINTS = (100.0, 600.0, 3000.0)


def engel_shares(per_capita_real):
    """Budget shares by need at a given real per-capita consumption (W$/month)."""
    x = math.log(max(per_capita_real, 20.0))
    p = [math.log(v) for v in ENGEL_POINTS]
    out = {}
    for need, (_, s) in NEEDS.items():
        if x <= p[0]:
            v = s[0]
        elif x >= p[2]:
            v = s[2]
        elif x <= p[1]:
            t = (x - p[0]) / (p[1] - p[0])
            v = s[0] + t * (s[1] - s[0])
        else:
            t = (x - p[1]) / (p[2] - p[1])
            v = s[1] + t * (s[2] - s[1])
        out[need] = v
    tot = sum(out.values())
    return {k: v / tot for k, v in out.items()}


def _split_rows(table):
    for line in table.strip().splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        cols = [c.strip() for c in line.split("|")]
        while len(cols) < 11:
            cols.append("")
        yield cols


def _parse_inputs(s):
    out = []
    for tok in s.split():
        name, qty = tok.rsplit(":", 1)
        q = float(qty)
        if q <= 0:
            continue
        out.append((name.split("/"), q))
    return out


def _parse_equip(s):
    if not s:
        return None, None, {}
    parts = s.split("+")
    first = parts[0]
    rate = None
    if "@" in first:
        first, r = first.split("@")
        rate = float(r)
    alts = first.split("/")
    aux = {}
    for p in parts[1:]:
        name, ratio = p.rsplit(":", 1)
        aux[name] = (name.split("/"), float(ratio))
    return alts, rate, aux


def _parse_labor(s):
    out = {}
    for tok in s.split():
        name, w = tok.rsplit(":", 1)
        w = float(w)
        if w > 0:
            out[name] = w
    return out


def _parse_opts(s):
    o = {}
    for tok in s.split():
        if "=" in tok:
            k, v = tok.split("=", 1)
            o[k] = v
        else:
            o[tok] = True
    return o


class Catalog:
    def __init__(self):
        self.knowledge = _knowledge.parse()
        self.occupations = _people.parse()
        self.fields = _people.FIELDS
        self.deposits = _resources.DEPOSITS
        self.archetypes = _resources.ARCHETYPES
        self.crops = _resources.CROPS
        self.needs = NEEDS
        self.endowments = dict(_goods.ENDOWMENTS)
        self.goods = {}
        self.procs = {}
        self.errors = []
        self._parse()
        self._overheads()
        self._gen_trad()
        self._resolve()
        self._availability()
        self._calibrate()
        self._derived()

    # ------------------------------------------------------------------ parse
    def _add_row(self, cols, is_alt=False):
        if is_alt:
            pid, gid, inputs, equip, labor, know, opts = cols[:7]
            g = self.goods.get(gid)
            if g is None:
                self.errors.append(f"alt process {pid}: unknown good {gid}")
                return
            o = _parse_opts(opts)
        else:
            gid, name, cat, unit, kg, price, inputs, equip, labor, know, opts = cols[:11]
            o = _parse_opts(opts)
            need = None
            if "need" in o:
                parts = o["need"].split(":")
                need = (parts[0], float(parts[1]), float(parts[2]) if len(parts) > 2 else 0.0)
            g = {
                "id": gid, "name": name, "cat": cat, "unit": unit,
                "kg": float(kg or 0), "price": float(price), "need": need,
                "svc": bool(o.get("svc")), "local": bool(o.get("local")),
                "nt": bool(o.get("nt")), "tol": float(o["tol"]) if "tol" in o else None,
                "clean": o.get("clean"), "prec": float(o["prec"]) if "prec" in o else None,
                "life": int(o["life"]) if "life" in o else None,
                "opq": float(o.get("opq", 0.2)), "restricted": bool(o.get("restricted")),
                "capital": cat in ("capital", "building"),
                "processes": [],
                "vas": float(o["vas"]) if "vas" in o else None,
            }
            if g["capital"] and g["life"] is None:
                g["life"] = 240
            self.goods[gid] = g
            pid = gid
        alts, rate, aux = _parse_equip(equip)
        p = {
            "id": pid, "good": g["id"], "inputs": _parse_inputs(inputs),
            "equip": alts, "rate": rate, "aux": aux,
            "labor_w": _parse_labor(labor), "know": know.split() if know else [],
            "dep": o.get("dep"), "co2": float(o.get("co2", 0.0)),
            "lx": float(o.get("lx", 1.0)), "kx": float(o.get("kx", 1.0)),
            "trad": False, "alt_trad": o.get("alt") == "trad",
            "vas": float(o["vas"]) if "vas" in o else g.get("vas"),
        }
        self.procs[pid] = p
        g["processes"].append(pid)

    def _parse(self):
        for cols in _split_rows(_goods.TABLE):
            self._add_row(cols)
        for cols in _split_rows(_goods.EXTRA_CAPITAL):
            self._add_row(cols)
        for cols in _split_rows(_goods.ALT_PROCESSES):
            self._add_row(cols, is_alt=True)
        for eid, e in self.endowments.items():
            self.goods[eid] = {
                "id": eid, "name": e["name"], "cat": "endowment", "unit": "ha", "kg": 0,
                "price": e["rent"] / MONTHLY_RATE, "need": None, "svc": False, "local": True,
                "nt": True, "tol": None, "clean": None, "prec": None, "life": 10 ** 6,
                "opq": 0, "restricted": False, "capital": True, "processes": [],
                "endowment": True, "rent": e["rent"], "vas": None,
            }

    # ---------------------------------------------------------------- overheads
    OVERHEADS = (
        # service good, share of output value, applies to
        ("wholesale_logistics", 0.035, "goods"),
        ("business_services", 0.02, "all"),
        ("financial_services", 0.01, "all"),
        ("software_services", 0.008, "modern"),
        ("advertising_marketing", 0.012, "consumer"),
    )

    OVERHEAD_IDS = {"wholesale_logistics", "business_services", "financial_services", "software_services",
                    "advertising_marketing"}

    def _overheads(self):
        """Every business buys services: distribution, legal & accounting,
        finance, IT and marketing. Added as small inputs to each recipe."""
        for pid, p in self.procs.items():
            g = self.goods[p["good"]]
            if g["cat"] in ("public",) or g.get("endowment") or g["id"] in (o[0] for o in self.OVERHEADS):
                continue
            if g["cat"] in ("building",) and g["svc"]:
                continue
            have = {alts[0] for alts, _ in p["inputs"]}
            modern = any(self.knowledge.get(k, {}).get("year", 0) >= 1960 for k in p["know"])
            for sid, share, scope in self.OVERHEADS:
                if sid in have or sid not in self.goods:
                    continue
                if scope == "goods" and (g["svc"] or g["local"]):
                    continue
                if scope == "modern" and not modern:
                    continue
                if scope == "consumer" and not g["need"]:
                    continue
                if g["svc"] and sid == "wholesale_logistics":
                    continue
                qty = share * g["price"] / self.goods[sid]["price"]
                p["inputs"].append(([sid], qty))

    # --------------------------------------------------------- traditional alts
    def _gen_trad(self):
        """Pre-industrial way of making the same thing: hand tools (and draft
        animals on farms), many more labor hours, lower land yields, and only
        inputs that pre-industrial societies could make."""
        old_know_ok = lambda k: self.knowledge.get(k, {"year": 9999})["year"] <= 1780
        for pid, p in list(self.procs.items()):
            if not p["alt_trad"]:
                continue
            g = self.goods[p["good"]]
            tp = dict(p)
            tp["id"] = pid + "__trad"
            tp["trad"] = True
            tp["alt_trad"] = False
            is_land = p["equip"] and p["equip"][0] in self.endowments
            if is_land:
                tp["equip"] = p["equip"]
                tp["rate"] = (p["rate"] or 1.0) * 0.35
                tp["aux"] = {"horses": (["horses"], 0.04), "hand_tools": (["hand_tools"], 0.05)}
                lx = 6.0
            else:
                tp["equip"] = ["hand_tools"]
                tp["rate"] = None
                tp["aux"] = {}
                lx = 10.0 if g["cat"] == "resource" else 7.0
            tp["lx"] = p["lx"] * lx
            tp["kx"] = 0.4
            tp["inputs"] = []  # filtered after availability is known
            tp["_orig_inputs"] = p["inputs"]
            know = [k for k in p["know"] if old_know_ok(k)]
            tp["know"] = know
            # a craftsman/laborer does what specialists do in the modern plant
            lw = {}
            for occ, w in p["labor_w"].items():
                o = self.occupations.get(occ)
                if o and o["edu"] >= 3:
                    occ = "craftsman"
                lw[occ] = lw.get(occ, 0) + w
            tp["labor_w"] = lw
            self.procs[tp["id"]] = tp
            g["processes"].append(tp["id"])

    # -------------------------------------------------------------- resolve
    def _resolve(self):
        for pid, p in self.procs.items():
            for alts, _ in p["inputs"] + p.get("_orig_inputs", []):
                for a in alts:
                    if a not in self.goods:
                        self.errors.append(f"{pid}: unknown input {a}")
            for a in (p["equip"] or []):
                if a not in self.goods:
                    self.errors.append(f"{pid}: unknown equipment {a}")
            for name, (alts, _) in p["aux"].items():
                for a in alts:
                    if a not in self.goods:
                        self.errors.append(f"{pid}: unknown aux equipment {a}")
            for occ in p["labor_w"]:
                if occ not in self.occupations:
                    self.errors.append(f"{pid}: unknown occupation {occ}")
            for k in p["know"]:
                if k not in self.knowledge:
                    self.errors.append(f"{pid}: unknown knowledge {k}")
            if p["dep"] and p["dep"] not in self.deposits:
                self.errors.append(f"{pid}: unknown deposit {p['dep']}")
        for g in self.goods.values():
            if g["clean"] and g["clean"] not in self.goods:
                self.errors.append(f"{g['id']}: unknown cleanroom {g['clean']}")
            if g["need"] and g["need"][0] not in NEEDS:
                self.errors.append(f"{g['id']}: unknown need {g['need'][0]}")
        for k in self.knowledge.values():
            for pr in k["prereqs"]:
                if pr not in self.knowledge:
                    self.errors.append(f"knowledge {k['id']}: unknown prereq {pr}")
        # drop broken references so the sim can still run
        for pid, p in self.procs.items():
            p["inputs"] = [([a for a in alts if a in self.goods], q) for alts, q in p["inputs"]]
            p["inputs"] = [(alts, q) for alts, q in p["inputs"] if alts]
            if "_orig_inputs" in p:
                p["_orig_inputs"] = [([a for a in alts if a in self.goods], q) for alts, q in p["_orig_inputs"]]
                p["_orig_inputs"] = [(alts, q) for alts, q in p["_orig_inputs"] if alts]
            p["labor_w"] = {o: w for o, w in p["labor_w"].items() if o in self.occupations}
            p["know"] = [k for k in p["know"] if k in self.knowledge]

    # ---------------------------------------------------------- availability
    def _availability(self):
        """Year the world frontier could first make each good/process."""
        INF = 10 ** 6
        kyear = {k: v["year"] for k, v in self.knowledge.items()}
        # knowledge is only usable once prerequisites exist
        for _ in range(10):
            for k, v in self.knowledge.items():
                for pr in v["prereqs"]:
                    kyear[k] = max(kyear[k], kyear.get(pr, -10 ** 4))
        self.kyear = kyear
        # Optimistic fixed point: start everything at "always possible" and push
        # dates up to the latest prerequisite. Production cycles (cement kilns
        # need concrete, which needs cement) are bootstrappable in reality, so
        # they resolve to the date their knowledge appears.
        avail = {gid: -10 ** 4 for gid in self.goods}
        pav = {pid: -10 ** 4 for pid in self.procs}

        def core_year(p):
            return max([kyear[k] for k in p["know"]] or [None] if p["know"] else [None])

        for _ in range(300):
            changed = False
            new_avail = {gid: INF for gid in self.goods}
            for gid, g in self.goods.items():
                if g.get("endowment"):
                    new_avail[gid] = -10 ** 4
            for pid, p in self.procs.items():
                core = max([kyear[k] for k in p["know"]]) if p["know"] else None
                y = core if core is not None else -10 ** 4
                g_self = p["good"]
                req = []
                if not p["trad"]:
                    req += [alts for alts, _ in p["inputs"]]
                req += [alts for alts, _ in p["aux"].values()]
                for alts in req:
                    a_y = min((avail[a] if a != g_self else -10 ** 4) for a in alts)
                    if core is not None and a_y > core + 10:
                        continue  # later invention: an optional upgrade, not a prerequisite
                    y = max(y, a_y)
                if p["equip"]:
                    y = max(y, min((avail[a] if a != g_self else -10 ** 4) for a in p["equip"]))
                if y != pav[pid]:
                    pav[pid] = y
                    changed = True
                if y < new_avail[g_self]:
                    new_avail[g_self] = y
            if new_avail != avail:
                changed = True
            avail = new_avail
            if not changed:
                break
        # mark optional inputs / aux equipment per process
        for pid, p in self.procs.items():
            core = max([kyear[k] for k in p["know"]]) if p["know"] else None
            opt = set()
            if core is not None:
                for alts, _ in p["inputs"]:
                    if min(avail[a] for a in alts) > core + 10:
                        opt.add(alts[0])
                for name, (alts, _) in p["aux"].items():
                    if min(avail[a] for a in alts) > core + 10:
                        opt.add(name)
            # overhead services are bought when available, never a hard requirement
            for alts, _ in p["inputs"]:
                if alts[0] in self.OVERHEAD_IDS:
                    opt.add(alts[0])
            p["optional"] = opt
        # traditional processes keep only inputs that existed before ~1800
        for pid, p in self.procs.items():
            if p["trad"]:
                p["inputs"] = [([a for a in alts if avail[a] <= 1800], q)
                               for alts, q in p.pop("_orig_inputs")]
                p["inputs"] = [(alts, q) for alts, q in p["inputs"] if alts]
            p.pop("_orig_inputs", None)
        self.avail = avail
        self.proc_avail = pav
        for gid, g in self.goods.items():
            g["year"] = avail[gid]
        for pid, p in self.procs.items():
            p["year"] = pav[pid]

    # ------------------------------------------------------------ calibration
    def _calibrate(self):
        """Pass 1: derive labor hours and equipment throughput from listed
        prices. Pass 2: with quantities fixed, raise world prices where the
        frontier process cannot cover its costs (keeps the price system
        consistent with the physical recipes)."""
        wage = {o: v["ref_wage"] for o, v in self.occupations.items()}
        listed = {gid: g["price"] for gid, g in self.goods.items()}

        def eq_monthly(gid, price):
            g = self.goods[gid]
            if g.get("endowment"):
                return g["rent"]
            return price[gid] * (1.0 / (g["life"] or 120) + MONTHLY_RATE)

        def per_primary_cost(p, price):
            eq = p["equip"][0] if p["equip"] else None
            c = eq_monthly(eq, price) if eq else 0.0
            for name, (alts, ratio) in p["aux"].items():
                c += ratio * min(eq_monthly(a, price) for a in alts)
            return c

        for pid, p in self.procs.items():
            g = self.goods[p["good"]]
            price = listed
            inp = sum(min(price[a] for a in alts) * q for alts, q in p["inputs"])
            vas = p["vas"] if p["vas"] is not None else (0.55 if not g["capital"] else 0.6)
            if g["cat"] == "resource":
                vas = min(vas, 0.4)
            kshare = (1.0 - vas) * 0.6
            va = max(price[p["good"]] - inp, 0.25 * price[p["good"]])
            ppc = per_primary_cost(p, price)
            if p["rate"] is not None and p["equip"]:
                rate = p["rate"]
            elif p["equip"]:
                rate = ppc / max(kshare * va * p["kx"], 1e-9)
                if p["trad"]:
                    rate = ppc / max(kshare * va * 0.4, 1e-9)
            else:
                rate = None
            if rate is not None and p["equip"] and p["good"] in p["equip"]:
                rate = max(rate, 0.5)  # machines that make themselves: <=2 machine-months per unit
            lw = p["labor_w"]
            wsum = sum(lw.values()) or 1.0
            avg_w = sum(wage[o] * w for o, w in lw.items()) / wsum if lw else 20.0
            hours_total = vas * va / avg_w * p["lx"]
            p["labor"] = {o: hours_total * w / wsum for o, w in lw.items()}
            p["rate"] = rate

        price = dict(listed)
        for it in range(25):
            for pid, p in self.procs.items():
                g = self.goods[p["good"]]
                inp = sum(min(price[a] for a in alts) * q for alts, q in p["inputs"])
                kcost = per_primary_cost(p, price) / p["rate"] if p["rate"] else 0.0
                lcost = sum(wage[o] * h for o, h in p["labor"].items())
                full = inp + kcost + lcost
                p["unit_cost_ref"] = full
                if not p["trad"] and pid == g["processes"][0] and not g.get("endowment"):
                    need = min(full * 1.12, listed[g["id"]] * 4.0)
                    if need > price[g["id"]]:
                        price[g["id"]] = need
        for gid, g in self.goods.items():
            g["price_listed"] = listed[gid]
            g["price"] = price[gid]

    # --------------------------------------------------------------- derived
    def _derived(self):
        self.consumer_goods = [gid for gid, g in self.goods.items() if g["need"]]
        self.capital_goods = [gid for gid, g in self.goods.items() if g["capital"] and not g.get("endowment")]
        self.by_need = {}
        for gid in self.consumer_goods:
            self.by_need.setdefault(self.goods[gid]["need"][0], []).append(gid)
        # R&D difficulty to reproduce a product (person-years)
        for p in self.procs.values():
            g = self.goods[p["good"]]
            tol = g["tol"]
            n_in = len(p["inputs"])
            kdiff = max([self.knowledge[k]["diff"] for k in p["know"]] or [0])
            tolf = 1 + (math.log10(1 + 100.0 / tol) if tol else 0)
            cleanf = 3.0 if g["clean"] == "cleanroom_iso3" else (2.0 if g["clean"] else 1.0)
            p["design_effort"] = 20.0 * (1 + n_in) * tolf * cleanf * (1 + kdiff / 1000.0)
            if p["trad"]:
                p["design_effort"] *= 0.2
        # users: which processes use a good as input / equipment
        self.used_as_input = {gid: [] for gid in self.goods}
        self.used_as_equip = {gid: [] for gid in self.goods}
        for pid, p in self.procs.items():
            for alts, _ in p["inputs"]:
                for a in alts:
                    self.used_as_input[a].append(pid)
            for a in (p["equip"] or []):
                self.used_as_equip[a].append(pid)
            for alts, _ in p["aux"].values():
                for a in alts:
                    self.used_as_equip[a].append(pid)

    def world_price(self, gid, year):
        """World price in W$ for a year: new technologies start expensive and
        fall along an experience curve towards the 2025 reference price."""
        g = self.goods[gid]
        base = g["price"]
        intro = g["year"]
        if intro > year:
            return None
        age = year - intro
        return base * (1.0 + 3.0 * math.exp(-age / 10.0))

    def summary(self):
        return {
            "goods": len(self.goods), "processes": len(self.procs),
            "knowledge": len(self.knowledge), "occupations": len(self.occupations),
            "consumer_goods": len(self.consumer_goods), "capital_goods": len(self.capital_goods),
            "errors": self.errors,
        }


_CAT = None


def get():
    global _CAT
    if _CAT is None:
        _CAT = Catalog()
    return _CAT
