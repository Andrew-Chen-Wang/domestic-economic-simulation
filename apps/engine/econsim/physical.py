"""Physical engine: what can physically be produced, where, how much, and how well.

- Capacity comes from equipment x throughput, modified by geology (deposit
  grade and depletion), climate (crop suitability), and site potential
  (solar irradiance, wind, hydro head).
- Yield and quality come from the precision gap between the maker's
  equipment and the product's tolerance, cleanroom availability, worker craft
  skill and the firm's position on its learning curve.
- Transport cost comes from mass x distance x infrastructure quality.
"""
import math

from .world import HOURS

CLEAN_ORDER = {"cleanroom_iso3": 3, "cleanroom_iso5": 5, "cleanroom_iso7": 7}
FREIGHT_PER_TKM_ROAD = 0.11
FREIGHT_PER_TKM_RAIL = 0.045
SEA_FREIGHT_PER_T = 60.0


# ------------------------------------------------------------------ geography
def regions_for_process(w, cat, p):
    out = []
    eq = p["equip"][0] if p["equip"] else None
    for r in w.regions:
        if p["dep"]:
            d = r.deposits.get(p["dep"])
            if not d or d["qty"] <= 0:
                continue
        if eq in cat.endowments:
            if r.land.get(eq, 0) <= 0:
                continue
            if p["good"] in cat.crops and r.suit.get(p["good"], 0) < 0.25:
                continue
        out.append(r.id)
    return out


def region_weights(w, cat, p, regs):
    eq = p["equip"][0] if p["equip"] else None
    out = {}
    for rid in regs:
        r = w.regions[rid]
        if p["dep"]:
            d = r.deposits[p["dep"]]
            out[rid] = max(1e-6, d["grade"] ** 2 * math.sqrt(max(d["qty"], 0)))
        elif eq in cat.endowments:
            out[rid] = r.land.get(eq, 0) * r.suit.get(p["good"], 0.6) ** 2
        else:
            out[rid] = (r.pop + 50) * (1.5 if r.port else 1.0) * (0.5 + r.infra.get("road", 0.5))
    return out


def site_factor(w, cat, p, r):
    """Multiplier on equipment throughput from the physical site."""
    f = 1.0
    eq = p["equip"][0] if p["equip"] else None
    if p["dep"]:
        d = r.deposits.get(p["dep"])
        if not d or d["qty"] <= 0:
            return 0.0
        if d["kind"] == "stock":
            f *= d["grade"] * (0.45 + 0.55 * min(1.0, d["qty"] / max(d["qty0"], 1)))
        elif d["kind"] == "renew":
            f *= min(1.0, 0.3 + d["qty"] / max(d["qty0"], 1))
        else:
            f *= d["grade"]
    if eq in cat.endowments and p["good"] in cat.crops:
        suit = r.suit.get(p["good"], 0.5)
        # irrigation tops up dry regions
        if r.rain < 900:
            suit = suit + (1 - suit) * 0.5 * r.infra.get("irrigation", 0)
        f *= suit
    return f


def capacity_per_primary(w, cat, p, r):
    return (p["rate"] or 0.0) * site_factor(w, cat, p, r)


def transport_cost(w, cat, gid, r_from, r_to):
    """Cost to move one unit of `gid` between regions (domestic currency)."""
    kg = cat.goods[gid]["kg"]
    if kg <= 0:
        return 0.0
    a, b = w.regions[r_from], w.regions[r_to]
    d = w.dist[r_from][r_to]
    road_q = 0.5 * (a.infra["road"] + b.infra["road"])
    rail_q = min(a.infra["rail"], b.infra["rail"])
    road = FREIGHT_PER_TKM_ROAD / (0.35 + 0.65 * road_q)
    rail = FREIGHT_PER_TKM_RAIL / (0.35 + 0.65 * rail_q) if rail_q > 0.1 and d > 120 else road
    per_tkm = min(road, rail * (1.3 - 0.3 * rail_q))
    return kg / 1000.0 * d * per_tkm * w.stats.get("freight_mult", 1.0)


def nearest_port(w, r_to):
    best = None
    for r in w.regions:
        if r.port and r.infra.get("port", 0) > 0.02:
            d = w.dist[r.id][r_to]
            if best is None or d < best[1]:
                best = (r.id, d)
    return best[0] if best else 0


def import_price(w, cat, gid, r_to):
    """Landed price of an import in region r_to (before tariff), or None."""
    wp = cat.world_price(gid, w.year)
    if wp is None:
        return None
    g = cat.goods[gid]
    if g["svc"] and (g["local"] or g["nt"]):
        return None
    if g["nt"]:
        return None
    port = nearest_port(w, r_to)
    pq = w.regions[port].infra.get("port", 0.3)
    sea = g["kg"] / 1000.0 * SEA_FREIGHT_PER_T * (1.6 - 0.6 * pq)
    return wp * w.fx + sea * w.fx + transport_cost(w, cat, gid, port, r_to)


# ---------------------------------------------------------------- production
def precision_yield(tol, eq_prec, craft):
    """Share of good output given equipment precision vs required tolerance.
    Skilled craftsmen can do better than their machines (scraping, lapping,
    selective fitting) - up to ~35% for highly skilled workers."""
    if not tol:
        return 1.0
    eff = eq_prec * (1.0 - 0.35 * craft)
    ratio = eff / tol
    if ratio <= 1.0:
        return 1.0
    if ratio >= 4.0:
        return 0.0
    return max(0.0, 1.0 - 0.95 * ((ratio - 1.0) / 3.0) ** 0.7)


def learning_yield(f, p, complex_):
    ref = max(f.plan, 1e-6) * 6.0
    m = f.cum_output / (f.cum_output + ref)
    if complex_:
        return 0.3 + 0.7 * m
    return 0.75 + 0.25 * m


def learning_labor(f):
    """Wright's law: ~15% fewer hours per doubling of cumulative output. A
    brand-new line needs twice the mature hours; a mature line (decades of
    cumulative output) is at the calibrated frontier level (1.0)."""
    ref = max(f.plan, 1e-6) * 3.0
    doublings = math.log2(1.0 + f.cum_output / ref)
    return max(1.0, 2.0 * (0.85 ** doublings))


def has_cleanroom(cat, f, need):
    if not need:
        return True
    lvl = CLEAN_ORDER[need]
    for k, v in f.equip.items():
        if k in CLEAN_ORDER and CLEAN_ORDER[k] <= lvl and v > 1e-6:
            return True
    return False


def gen_factor(w, cat, f):
    """Input & labor requirement relative to the world-frontier design
    (recipes are calibrated at the frontier); ~4% per generation."""
    return 0.96 ** (f.gen - world_generation(w, cat, f.good))


def labor_hours_per_unit(w, cat, f, p):
    """Hours per unit at this firm, before worker skill. Includes the
    learning curve, design generation, missing optional upgrades and the
    firm's total factor productivity (know-how, infrastructure, city)."""
    mult = learning_labor(f) * gen_factor(w, cat, f)
    pen = 1.0 + 0.12 * missing_optional(w, cat, f, p)
    tfp = firm_tfp(w, cat, f, p)
    return {o: h * mult * pen / tfp for o, h in p["labor"].items()}


def know_how(w, cat, p):
    """Tacit process know-how: weakest relevant process/engineering node."""
    lv = [w.knowledge.get(k, 0.0) for k in p["know"] if cat.knowledge[k]["kind"] != "sci"]
    return min(lv) if lv else 1.0


def firm_tfp(w, cat, f, p):
    r = w.regions[f.region]
    kh = 0.35 + 0.65 * know_how(w, cat, p)
    infra = 0.55 + 0.25 * r.infra.get("road", 0.5) + 0.2 * r.infra.get("grid", 0.5)
    if cat.goods[f.good]["svc"] and cat.goods[f.good]["cat"] in ("service", "software"):
        infra *= 0.85 + 0.15 * r.infra.get("broadband", 0.5)
    return kh * infra * r.productivity * w.stats.get("tfp_mult", 1.0)


def worker_productivity(skill):
    return 0.4 + 0.8 * skill


def missing_optional(w, cat, f, p):
    n = 0
    for name in p.get("optional", ()):
        if name in p["aux"]:
            alts = p["aux"][name][0]
            if not any(f.equip.get(a, 0) > 1e-9 for a in alts):
                n += 1
    return min(n, 4)


def craft_skill(w, f):
    tot = 0.0
    s = 0.0
    for pid, fte in f.staff.items():
        per = w.persons.get(pid)
        if per is None:
            continue
        sk = per.skill.get(per.occ, 0.2)
        tot += fte
        s += fte * sk
    return s / tot if tot > 0 else 0.2


def equipment_capacity(w, cat, f, p):
    """Monthly output units the firm's equipment can produce, and the
    binding reason if zero."""
    if not p["equip"]:
        return 1e18, None
    eq = None
    n = 0.0
    for a in p["equip"]:
        if f.equip.get(a, 0) > n:
            eq, n = a, f.equip[a]
    if n <= 1e-9:
        return 0.0, f"no {cat.goods[p['equip'][0]]['name']}"
    r = w.regions[f.region]
    cap = n * capacity_per_primary(w, cat, p, r)
    if p["dep"]:
        d = r.deposits.get(p["dep"])
        if d is None or d["qty"] <= 0:
            return 0.0, f"deposit of {p['dep']} exhausted"
        if d["kind"] == "flow" and p["dep"] in ("hydro",):
            cap = min(cap, d["qty"] * p["rate"] * d["grade"])
        if d["kind"] in ("stock", "renew"):
            cap = min(cap, d["qty"] * 0.02)
    for name, (alts, ratio) in p["aux"].items():
        have = sum(f.equip.get(a, 0) for a in alts)
        if name in p.get("optional", ()) and have <= 1e-9:
            continue
        if alts[0] in CLEAN_ORDER:
            continue  # handled as a yield gate
        need = ratio * n
        if need > 0 and have < need:
            if have <= 1e-9 and ratio * n > 0:
                cap = min(cap, 0.0)
                return 0.0, f"missing {cat.goods[alts[0]]['name']}"
            cap = min(cap, cap * have / need)
    return cap, None


def yield_quality(w, cat, f, p):
    """Returns (yield, quality, reason)."""
    g = cat.goods[f.good]
    if g["clean"] and not has_cleanroom(cat, f, g["clean"]):
        return 0.0, 0.0, f"requires {cat.goods[g['clean']]['name']}"
    for name, (alts, ratio) in p["aux"].items():
        if alts[0] in CLEAN_ORDER and not has_cleanroom(cat, f, alts[0]):
            if name in p.get("optional", ()):
                continue
            return 0.0, 0.0, f"requires {cat.goods[alts[0]]['name']}"
    eq = max(p["equip"], key=lambda a: f.equip.get(a, 0)) if p["equip"] else None
    craft = craft_skill(w, f)
    prec = precision_of(w, cat, f, p, eq)
    yp = precision_yield(g["tol"], prec, craft) if prec else 1.0
    if yp <= 0:
        return 0.0, 0.0, (f"equipment precision {prec:g}um too coarse for "
                          f"{g['tol']:g}um tolerance")
    complex_ = bool(g["clean"]) or (g["tol"] is not None and g["tol"] < 5)
    yl = learning_yield(f, p, complex_)
    y = yp * yl * min(1.0, 0.25 + f.design * 0.75)
    world_gen = world_generation(w, cat, f.good)
    q = (0.8 + 0.2 * yp) * quality_factor(f.gen, world_gen) * (0.94 + 0.12 * craft)
    return y, q, None


ASSEMBLY = {"assembly_line", "welding_robot", "construction_equipment", "aircraft_assembly_hall",
            "shipyard", "industrial_robot"}


def precision_of(w, cat, f, p, eq):
    """Precision (um) that limits this firm's output. Assembly equipment does
    not set tolerances - those are embodied in the components - so the
    finest machine tool the firm owns (primary or auxiliary) governs."""
    best = None
    for a, n in f.equip.items():
        if n <= 1e-9 or a in ASSEMBLY or a in CLEAN_ORDER:
            continue
        pr = f.eq_prec.get(a) or cat.goods[a]["prec"]
        if pr is None or cat.goods[a]["cat"] == "building":
            continue
        if best is None or pr < best:
            best = pr
    if best is None and eq and eq not in ASSEMBLY:
        best = f.eq_prec.get(eq) or cat.goods[eq]["prec"]
    return best


def world_generation(w, cat, gid):
    """How many design improvements the world frontier has made since the
    good was introduced (one every ~6 years)."""
    age = w.year - cat.goods[gid]["year"]
    return max(0, min(8, int(age / 6.0)))


def quality_factor(gen, world_gen):
    return 1.03 ** (gen - world_gen)


def est_unit_cost(w, cat, p, region):
    """Rough unit cost of running process p in a region at current prices and wages."""
    inp = 0.0
    for alts, q in p["inputs"]:
        inp += min(w.prices.get(a, cat.goods[a]["price"] * 3) for a in alts) * q
    r = w.regions[region]
    tfp = (0.35 + 0.65 * know_how(w, cat, p)) * (0.55 + 0.25 * r.infra["road"] + 0.2 * r.infra["grid"]) \
        * r.productivity * w.stats.get("tfp_mult", 1.0)
    lab = 0.0
    for o, h in p["labor"].items():
        lab += h * w.wage_index.get(o, 3000) / HOURS / (0.8 * max(tfp, 0.05))
    k = 0.0
    eq = p["equip"][0] if p["equip"] else None
    if eq:
        cpp = capacity_per_primary(w, cat, p, r)
        if cpp <= 0:
            return None
        g = cat.goods[eq]
        if eq in cat.endowments:
            k = g["rent"] * w.price_index * w.stats.get("wage_level", 1) ** 0.5 / cpp
        else:
            pe = w.prices.get(eq, g["price"])
            per = pe * (1 / (g["life"] or 120) + w.stats.get("lend_rate", 0.06) / 12)
            for name, (alts, ratio) in p["aux"].items():
                ga = cat.goods[alts[-1]]
                per += ratio * w.prices.get(alts[-1], ga["price"]) * (1 / (ga["life"] or 120) + 0.005)
            k = per / cpp
    return inp + lab + k


def export_share(comp):
    """Share of the world market a domestic supplier wins at a given
    quality-adjusted price competitiveness (world price / our landed price)."""
    if comp < 0.75:
        return 0.0
    return min(0.06, 0.012 * comp ** 5)


def ref_unit_cost(w, cat, p, wage_mult, tfp=1.0):
    inp = sum(min(w.prices.get(a, cat.goods[a]["price"]) for a in alts) * q for alts, q in p["inputs"])
    lab = sum(cat.occupations[o]["ref_wage"] * wage_mult * h / (0.8 * tfp) for o, h in p["labor"].items())
    eq = p["equip"][0] if p["equip"] else None
    k = 0.0
    if eq and p["rate"]:
        g = cat.goods[eq]
        if g.get("endowment"):
            k = g["rent"] / p["rate"]
        else:
            k = cat.goods[eq]["price"] * (1 / (g["life"] or 120) + 0.006) / p["rate"]
    return inp + lab + k


# ---------------------------------------------------------------- explainer
def explain(w, cat, gid):
    """Why can (or can't) this country make this good? Four layers:
    scientific, engineering, manufacturing, economic."""
    g = cat.goods[gid]
    out = {"good": gid, "name": g["name"], "world_year": g["year"],
           "world_available": g["year"] <= w.year and not g["restricted"],
           "restricted": g["restricted"], "processes": []}
    producers = [f for f in w.firms.values() if f.good == gid and f.alive]
    out["producers"] = [{"id": f.id, "name": f.name, "region": w.regions[f.region].name,
                         "design": round(f.design, 3), "gen": f.gen, "quality": round(f.quality, 3),
                         "output": f.last.get("output", 0), "blocked": f.blocked} for f in producers]
    for pid in g["processes"]:
        p = cat.procs[pid]
        rep = {"id": pid, "trad": p["trad"], "year": p["year"], "layers": {}}
        # scientific feasibility
        sci = []
        for k in p["know"]:
            node = cat.knowledge[k]
            sci.append({"id": k, "name": node["name"], "level": round(w.knowledge.get(k, 0), 3),
                        "world_knows": cat.kyear[k] <= w.year, "kind": node["kind"],
                        "ok": w.knowledge.get(k, 0) >= 0.5})
        rep["layers"]["scientific"] = {"ok": all(x["ok"] for x in sci), "items": sci}
        # engineering feasibility
        best = max(producers, key=lambda f: f.design, default=None)
        rd = [f for f in w.firms.values() if f.good == gid and f.design < 1]
        eng_ok = any(f.design >= 1 for f in producers)
        rep["layers"]["engineering"] = {
            "ok": eng_ok or (all(x["ok"] for x in sci) and gid in w.produced_ever),
            "best_design": round(best.design, 3) if best else 0.0,
            "in_rd": [{"firm": f.name, "progress": round(f.design, 3), "blocked": f.blocked} for f in rd],
            "design_effort_py": round(p["design_effort"]),
            "reverse_engineering": round(1 - g["opq"], 2),
        }
        # manufacturing feasibility
        items = []
        eqs = list(p["equip"] or [])
        for a in eqs:
            items.append(_supply_item(w, cat, a, "equipment", g["tol"]))
        for name, (alts, ratio) in p["aux"].items():
            it = _supply_item(w, cat, alts, "aux equipment", None)
            it["optional"] = name in p.get("optional", ())
            items.append(it)
        for alts, q in p["inputs"]:
            it = _supply_item(w, cat, alts, "input", None)
            it["qty"] = q
            it["optional"] = alts[0] in p.get("optional", ())
            items.append(it)
        regs = regions_for_process(w, cat, p)
        site = {"ok": bool(regs), "regions": [w.regions[r].name for r in regs]}
        if p["dep"]:
            site["deposit"] = p["dep"]
        labor = []
        for o, h in p["labor"].items():
            occ = cat.occupations[o]
            n = sum(w.scale for per in w.persons.values() if per.occ == o and per.age >= 216)
            skl = [per.skill.get(o, 0) for per in w.persons.values() if per.occ == o]
            labor.append({"occ": o, "name": occ["name"], "hours": round(h, 4), "workers": n,
                          "avg_skill": round(sum(skl) / len(skl), 2) if skl else 0,
                          "ok": n > 0})
        clean = g["clean"]
        man_ok = (all(i["ok"] or i.get("optional") for i in items) and site["ok"]
                  and all(l["ok"] for l in labor))
        rep["layers"]["manufacturing"] = {
            "ok": man_ok, "tolerance_um": g["tol"], "cleanroom": clean, "site": site,
            "supplies": items, "labor": labor,
        }
        # economic viability
        dom_cost = ref_unit_cost(w, cat, p, w.stats.get("wage_level", 1.0)) * w.price_index
        imp = None
        if g["year"] <= w.year and not g["restricted"]:
            imp = import_price(w, cat, gid, 0)
        rep["layers"]["economic"] = {
            "ok": imp is None or dom_cost <= imp * 1.05,
            "est_domestic_cost": round(dom_cost, 4),
            "import_price": round(imp, 4) if imp else None,
            "domestic_price": round(w.prices.get(gid, 0), 4),
        }
        out["processes"].append(rep)
    return out


def _supply_item(w, cat, alts, role, tol):
    if isinstance(alts, str):
        alts = [alts]
    best = None
    for a in alts:
        g = cat.goods[a]
        dom = [f for f in w.firms.values() if f.good == a and f.alive and f.last.get("output", 0) > 0]
        world = g["year"] <= w.year and not g["restricted"] and not g["nt"]
        endow = a in cat.endowments
        prec = g["prec"]
        prec_ok = True
        if tol and prec:
            prec_ok = prec <= tol * 4
        ok = (bool(dom) or world or endow) and prec_ok
        it = {"id": a, "name": g["name"], "role": role, "domestic": len(dom), "importable": world,
              "endowment": endow, "precision_um": prec, "precision_ok": prec_ok, "ok": ok,
              "world_year": g["year"], "restricted": g["restricted"]}
        if best is None or (ok and not best["ok"]):
            best = it
    best["alternatives"] = [cat.goods[a]["name"] for a in alts]
    return best
