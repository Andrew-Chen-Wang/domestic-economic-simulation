"""Simulation state containers and scenario generation.

Agents: each Person represents `scale` real people of the same age, region,
education and occupation. Firms are representative firms producing one good
with one process at a time. Everything that matters for the next month is in
World, so a pickled World is a complete snapshot (used for rewind).
"""
import math
import random

from . import catalog as _catalog
from . import policy as _policy
from .catalog.people import eligible

HOURS = 160.0


class Person:
    __slots__ = ("id", "age", "region", "edu", "field", "h", "occ", "skill", "jobs",
                 "savings", "school", "school_years", "guardian", "last_good", "urban",
                 "unemp", "prev_wage", "immigrant", "income_last", "debt", "inactive")

    def __init__(self, pid, age_m, region):
        self.id = pid
        self.age = age_m          # months
        self.region = region
        self.edu = 0
        self.field = "general"
        self.h = 0.3              # human capital from schooling 0..1
        self.occ = None
        self.skill = {}           # occupation -> 0..1
        self.jobs = {}            # firm id -> [fte, monthly wage per person]
        self.savings = 0.0        # per person
        self.school = None        # current schooling stage
        self.school_years = 0
        self.guardian = None
        self.last_good = None
        self.urban = True
        self.unemp = 0
        self.prev_wage = 0.0
        self.immigrant = False
        self.income_last = 0.0
        self.debt = 0.0
        self.inactive = False

    @property
    def fte(self):
        return sum(j[0] for j in self.jobs.values())


class Firm:
    __slots__ = ("id", "name", "region", "good", "proc", "owner", "founded", "equip",
                 "staff", "cash", "debt", "inv", "inv_in", "price", "markup", "sales_ema",
                 "demand_ema", "design", "cum_output", "gen", "quality", "rd_share",
                 "rd_progress", "vacancies", "wage_offer", "distress", "alive", "orders",
                 "cost_ema", "profit_ema", "last", "plan", "potential", "export_ema",
                 "util_ema", "eq_prec", "blocked", "subsidy_rate", "state_backed")

    def __init__(self, fid, name, region, good, proc, owner="private", tick=0):
        self.id = fid
        self.name = name
        self.region = region
        self.good = good
        self.proc = proc
        self.owner = owner
        self.founded = tick
        self.equip = {}           # good id -> count (fractional allowed)
        self.eq_prec = {}         # good id -> delivered precision (um)
        self.staff = {}           # person id -> fte
        self.cash = 0.0
        self.debt = 0.0
        self.inv = 0.0
        self.inv_in = {}
        self.price = 0.0
        self.markup = 0.15
        self.sales_ema = 0.0
        self.demand_ema = 0.0
        self.export_ema = 0.0
        self.design = 1.0
        self.cum_output = 0.0
        self.gen = 0
        self.quality = 1.0
        self.rd_share = 0.0
        self.rd_progress = 0.0
        self.vacancies = {}
        self.wage_offer = {}
        self.distress = 0
        self.alive = True
        self.orders = {}          # equipment good -> qty to buy this month
        self.cost_ema = 0.0
        self.profit_ema = 0.0
        self.util_ema = 0.8
        self.last = {}            # last month's accounts
        self.plan = 0.0
        self.potential = 0.0
        self.blocked = None       # human-readable reason production is blocked
        self.subsidy_rate = 0.0
        self.state_backed = False


class Region:
    __slots__ = ("id", "name", "arch", "area", "urban_km2", "temp", "rain", "sun", "wind",
                 "port", "deposits", "land", "land_used", "infra", "dwellings", "rent",
                 "pos", "pop", "urban_pop", "productivity", "suit")

    def __init__(self, rid, name, arch):
        self.id = rid
        self.name = name
        self.arch = arch
        self.deposits = {}
        self.land = {}
        self.land_used = {}
        self.infra = {}
        self.dwellings = 0.0
        self.rent = 0.0
        self.pop = 0
        self.urban_pop = 0
        self.productivity = 1.0
        self.suit = {}


class World:
    def __init__(self):
        self.tick = 0
        self.start_year = 2025
        self.scale = 500.0
        self.rng = random.Random(1)
        self.persons = {}
        self.firms = {}
        self.regions = []
        self.dist = []
        self.knowledge = {}
        self.k_frontier = {}       # progress on things nobody in the world knows yet
        self.policy = _policy.default()
        self.gov = {}
        self.bank = {}
        self.fx = 1.0
        self.prices = {}           # domestic reference price per good (last avg)
        self.price_index = 1.0
        self.wage_index = {}       # occupation -> average monthly wage per person
        self.imports_12m = {}      # good -> imported qty, rolling
        self.produced_ever = set()
        self.next_pid = 1
        self.next_fid = 1
        self.stats = {}
        self.hist = {}
        self.events = []
        self.scenario = {}
        self.policy_rate = 0.04
        self.world_gen_base = {}

    @property
    def year(self):
        return self.start_year + self.tick / 12.0

    @property
    def month(self):
        return self.tick % 12

    def new_person(self, age_m, region):
        p = Person(self.next_pid, age_m, region)
        self.next_pid += 1
        self.persons[p.id] = p
        return p

    def new_firm(self, name, region, good, proc, owner="private"):
        f = Firm(self.next_fid, name, region, good, proc, owner, self.tick)
        self.next_fid += 1
        self.firms[f.id] = f
        return f

    def event(self, kind, text, **data):
        self.events.append({"tick": self.tick, "kind": kind, "text": text, "data": data})


# ======================================================================== scenarios

SCENARIOS = {
    "emerging_2025": {
        "label": "Emerging economy, 2025",
        "desc": "A middle-income country: decent schooling, cheap labor, patchy infrastructure, "
                "imports most high-tech goods and machinery.",
        "year": 2025, "population": 3_000_000, "agents": 5000, "knowledge_lag": 18,
        "wage_mult": 0.30, "edu": [0.05, 0.22, 0.43, 0.13, 0.14, 0.03],
        "infra": 0.45, "fertility": 2.3, "gov_debt": 0.5, "domestic_share": 0.65, "tfp": 0.5, "participation": 0.62, "crowding": 3.6, "gen_lag": 2,
        "savings_months": 4, "regions": 6, "burn_in": 36,
    },
    "advanced_2025": {
        "label": "Advanced economy, 2025",
        "desc": "A rich, highly educated country with dense infrastructure and an aging population.",
        "year": 2025, "population": 3_000_000, "agents": 5000, "knowledge_lag": 0,
        "wage_mult": 1.0, "edu": [0.0, 0.05, 0.37, 0.18, 0.30, 0.10],
        "infra": 0.85, "fertility": 1.6, "gov_debt": 0.9, "domestic_share": 0.6, "tfp": 1.0, "participation": 0.8, "crowding": 2.3, "gen_lag": 0,
        "savings_months": 10, "regions": 6, "burn_in": 36,
    },
    "industrializing_1950": {
        "label": "Industrializing country, 1950",
        "desc": "Mostly rural, low literacy; railways and electricity exist but factories are few.",
        "year": 1950, "population": 3_000_000, "agents": 5000, "knowledge_lag": 25,
        "wage_mult": 0.10, "edu": [0.35, 0.40, 0.18, 0.04, 0.025, 0.005],
        "infra": 0.2, "fertility": 5.5, "gov_debt": 0.2, "domestic_share": 0.75, "tfp": 0.4, "participation": 0.62, "crowding": 4.8, "gen_lag": 3,
        "savings_months": 2, "regions": 6, "burn_in": 72,
    },
    "agrarian_1850": {
        "label": "Agrarian society, 1850",
        "desc": "Pre-industrial: farms, craftsmen, sailing ships, a few steam engines. "
                "Nothing modern can be made - or bought - until it is invented.",
        "year": 1850, "population": 2_000_000, "agents": 4000, "knowledge_lag": 10,
        "wage_mult": 0.05, "edu": [0.6, 0.3, 0.08, 0.015, 0.004, 0.001],
        "infra": 0.08, "fertility": 5.8, "gov_debt": 0.1, "domestic_share": 0.85, "tfp": 0.35, "participation": 0.6, "crowding": 5.5, "gen_lag": 1,
        "savings_months": 2, "regions": 5, "burn_in": 72,
    },
}

FIRM_PREFIX = ["Allied", "United", "Northern", "Pioneer", "Summit", "Vanguard", "Crescent",
               "Keystone", "Meridian", "Atlas", "Beacon", "Granite", "Liberty", "Harbor",
               "Evergreen", "Sterling", "Apex", "Union", "Frontier", "Cardinal", "Riverside",
               "Golden", "Prairie", "Orion", "Phoenix", "Royal", "Sovereign", "Titan"]
FIRM_SUFFIX = {"resource": "Mining", "agri": "Farms", "food": "Foods", "textile": "Textiles",
               "apparel": "Apparel", "wood": "Timber", "paper": "Paper", "media": "Press",
               "energy": "Energy", "chem": "Chemicals", "mineral": "Materials", "metal": "Metals",
               "semis": "Semiconductor", "component": "Components", "electrical": "Electric",
               "electronics": "Electronics", "capital": "Machinery", "building": "Construction",
               "consumer": "Products", "personal": "Cosmetics", "toys": "Toys", "pharma": "Pharma",
               "health": "Medical", "service": "Services", "public": "Public", "software": "Software"}


def firm_name(rng, good, cat):
    g = cat.goods[good]
    if g["cat"] == "public":
        return f"Public {g['name'].split('(')[0].strip()}"
    if good == "housing":
        return "Residential Properties"
    return f"{rng.choice(FIRM_PREFIX)} {FIRM_SUFFIX.get(g['cat'], 'Industries')}"


def generate(scenario_id="emerging_2025", seed=1, overrides=None):
    cat = _catalog.get()
    sc = dict(SCENARIOS[scenario_id])
    sc.update(overrides or {})
    rng = random.Random(seed)
    w = World()
    w.rng = random.Random(seed * 7919 + 13)
    w.scenario = dict(sc, id=scenario_id, seed=seed)
    w.start_year = sc["year"]
    w.scale = sc["population"] / sc["agents"]
    w.policy = _policy.default()
    year = sc["year"]
    w.stats["tfp_mult"] = sc.get("tfp", 1.0)
    w.stats["wage_level"] = sc["wage_mult"]

    _gen_regions(w, cat, rng, sc)
    _gen_knowledge(w, cat, sc)
    _gen_population(w, cat, rng, sc)
    _gen_economy(w, cat, rng, sc)
    w.event("info", f"Simulation started: {sc['label']} ({year}). "
                    f"{sc['population']:,} people in {len(w.regions)} regions; "
                    f"{len(w.firms)} firms.")
    return w


# --------------------------------------------------------------------- regions
def _gen_regions(w, cat, rng, sc):
    archs = list(cat.archetypes)
    n = sc["regions"]
    chosen = ["coastal_plain"]  # at least one port
    pool = [a for a in archs if a != "coastal_plain"]
    rng.shuffle(pool)
    chosen += pool[: n - 1]
    names = list(_catalog.resources.REGION_NAMES)
    rng.shuffle(names)
    lvl = sc["infra"]
    for i, a in enumerate(chosen):
        A = cat.archetypes[a]
        r = Region(i, names[i], a)
        r.area = rng.uniform(8000, 30000)
        r.urban_km2 = r.area * rng.uniform(0.004, 0.012) * (0.4 + lvl)
        r.temp = A["temp"] + rng.uniform(-3, 3)
        r.rain = A["rain"] * rng.uniform(0.75, 1.25)
        r.sun = A["sun"] * rng.uniform(0.9, 1.1)
        r.wind = A["wind"] * rng.uniform(0.8, 1.2)
        r.port = A["port"]
        r.pos = (math.cos(2 * math.pi * i / n) * 300 + rng.uniform(-60, 60),
                 math.sin(2 * math.pi * i / n) * 220 + rng.uniform(-50, 50))
        r.land = {"land_crop": r.area * 100 * A["crop_frac"],
                  "land_pasture": r.area * 100 * A["pasture_frac"],
                  "forest_land": r.area * 100 * A["forest_frac"]}
        r.land_used = {k: 0.0 for k in r.land}
        # geology
        for dep, D in cat.deposits.items():
            geo_ok = "*" in D["geo"] or any(gg in A["geo"] for gg in D["geo"])
            p = 0.75 if geo_ok else 0.06
            if D["kind"] == "flow" and dep in ("solar", "water"):
                p = 1.0
            if rng.random() < p:
                size = D["rich"] * math.exp(rng.gauss(-0.4, 0.9))
                grade = min(1.3, max(0.25, rng.gauss(0.8, 0.25)))
                if dep == "solar":
                    grade = r.sun
                    size = D["rich"] * (r.area / 15000)
                elif dep == "wind":
                    grade = r.wind
                elif dep == "fish_stock" and not r.port:
                    continue
                elif dep == "forest":
                    size = r.land["forest_land"] * 150  # t of standing timber
                r.deposits[dep] = {"qty": size, "qty0": size, "grade": grade,
                                   "kind": D["kind"], "regen": D.get("regen", 0.0)}
        # crop/livestock suitability from climate
        irr = 0.0
        for crop, (t_opt, t_tol, r_opt, r_tol) in cat.crops.items():
            rain = r.rain
            st = math.exp(-((r.temp - t_opt) / t_tol) ** 2)
            sr = math.exp(-((rain - r_opt) / r_tol) ** 2)
            r.suit[crop] = 0.15 + 0.85 * st * sr
        r.infra = {
            "road": lvl * rng.uniform(0.8, 1.1), "rail": lvl * rng.uniform(0.4, 1.0),
            "port": (lvl * 1.0 if r.port else 0.0), "grid": lvl * rng.uniform(0.8, 1.1),
            "broadband": max(0.0, lvl - 0.1) * rng.uniform(0.7, 1.1),
            "transit": lvl * rng.uniform(0.5, 1.0), "irrigation": lvl * 0.5,
        }
        for k in r.infra:
            r.infra[k] = max(0.0, min(1.0, r.infra[k]))
        w.regions.append(r)
    # distances (km)
    n = len(w.regions)
    w.dist = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                w.dist[i][j] = 40.0
            else:
                a, b = w.regions[i].pos, w.regions[j].pos
                w.dist[i][j] = math.hypot(a[0] - b[0], a[1] - b[1]) * 1.3 + 30


# ------------------------------------------------------------------- knowledge
def _gen_knowledge(w, cat, sc):
    year = sc["year"]
    lag = sc["knowledge_lag"]
    for k, node in cat.knowledge.items():
        ky = cat.kyear[k]
        if ky <= year - lag:
            lvl = 1.0
        elif ky <= year:
            lvl = max(0.0, 0.85 * (1 - (ky - (year - lag)) / max(lag, 1)))
        else:
            lvl = 0.0
        w.knowledge[k] = lvl
    # prerequisites cap understanding
    for _ in range(5):
        for k, node in cat.knowledge.items():
            if node["prereqs"]:
                cap = min(w.knowledge[p] for p in node["prereqs"])
                w.knowledge[k] = min(w.knowledge[k], cap + 0.15)


# ------------------------------------------------------------------ population
def _age_pyramid(rng, fertility):
    """Sample an age (years) from a stable population with growth implied by fertility."""
    growth = 0.012 * (fertility - 2.0)
    top = max(math.exp(-growth * a) * math.exp(-((a / 82.0) ** 6)) for a in range(0, 96, 5))
    while True:
        a = rng.uniform(0, 95)
        dens = math.exp(-growth * a) * math.exp(-((a / 82.0) ** 6))
        if rng.random() * top < dens:
            return a


def _gen_population(w, cat, rng, sc):
    n = sc["agents"]
    weights = []
    for r in w.regions:
        A = cat.archetypes[r.arch]
        weights.append((A["crop_frac"] + 0.3) * (1.6 if r.port else 1.0) * rng.uniform(0.6, 1.4))
    tot = sum(weights)
    weights = [x / tot for x in weights]
    edu_dist = sc["edu"]
    fields4 = [f for f, (lvl, _) in cat.fields.items() if lvl >= 4]
    fields3 = [f for f, (lvl, _) in cat.fields.items() if lvl == 3]
    adults = []
    for _ in range(n):
        reg = rng.choices(range(len(w.regions)), weights)[0]
        age_y = _age_pyramid(rng, sc["fertility"])
        p = w.new_person(int(age_y * 12), reg)
        if age_y >= 22:
            # older cohorts are less educated (history of expanding schooling)
            shift = max(0.0, (age_y - 30) / 60.0)
            d = [edu_dist[0] + shift * 0.3, edu_dist[1] + shift * 0.1] + [x * (1 - shift * 0.5) for x in edu_dist[2:]]
            p.edu = rng.choices(range(6), d)[0]
            p.school_years = [0, 6, 12, 14, 16, 18][p.edu]
            p.field = rng.choice(fields4) if p.edu >= 4 else (rng.choice(fields3) if p.edu == 3 else "general")
            p.h = min(1.0, 0.2 + 0.06 * p.school_years * (0.6 + 0.4 * sc["infra"]) + rng.uniform(-0.1, 0.1))
            adults.append(p)
        elif age_y >= 6:
            yrs = int(age_y - 6)
            p.school = "school"
            p.school_years = min(yrs, 12)
            p.edu = 1 if p.school_years >= 6 else 0
            if p.school_years >= 12:
                p.edu = 2
            p.h = min(1.0, 0.15 + 0.05 * p.school_years)
            if age_y >= 18:
                p.school = None
                adults.append(p)
        p.savings = 0.0
    # guardians for children
    by_region = {}
    for p in w.persons.values():
        if p.age >= 25 * 12 and p.age <= 55 * 12:
            by_region.setdefault(p.region, []).append(p.id)
    for p in w.persons.values():
        if p.age < 18 * 12:
            lst = by_region.get(p.region) or [q for v in by_region.values() for q in v]
            p.guardian = rng.choice(lst)


# -------------------------------------------------------------------- economy
def _gen_economy(w, cat, rng, sc):
    from . import physical
    year = sc["year"]
    S = w.scale
    wm = sc["wage_mult"]
    w.fx = 1.0
    # reference prices: world price where it exists, else catalog price
    for gid, g in cat.goods.items():
        wp = cat.world_price(gid, year)
        w.prices[gid] = wp if wp else g["price"] * 4
    # wages
    for o, occ in cat.occupations.items():
        w.wage_index[o] = occ["ref_wage"] * HOURS * wm
    # domestic production feasibility at start
    feasible = {}
    for gid, g in cat.goods.items():
        if g.get("endowment"):
            continue
        best = None
        for pid in g["processes"]:
            p = cat.procs[pid]
            if p["year"] > year:
                continue
            if not all(w.knowledge.get(k, 0) >= 0.65 for k in p["know"]):
                continue
            regs = physical.regions_for_process(w, cat, p)
            if not regs:
                continue
            # equipment must exist somewhere (world sells it, or it's a building)
            eq = p["equip"][0] if p["equip"] else None
            if eq and eq not in cat.endowments and cat.goods[eq]["year"] > year:
                continue
            # prefer the modern process when it is affordable
            cost = physical.ref_unit_cost(w, cat, p, wm)
            if best is None or cost < best[1]:
                best = (pid, cost, regs)
        if best:
            feasible[gid] = best
    pop = sc["population"]
    pol = w.policy
    dom_share = {}
    for gid, g in cat.goods.items():
        if gid not in feasible:
            dom_share[gid] = 0.0
        elif g["nt"] or g["local"] or g["svc"]:
            dom_share[gid] = 1.0
        elif g["cat"] in ("resource", "agri"):
            dom_share[gid] = min(1.0, sc["domestic_share"] * 1.5)
        else:
            dom_share[gid] = sc["domestic_share"]
    # export potential of tradables we can make cheaper than the world
    from .sim import WORLD_SCALE
    comp = {}
    for gid, (pid, cost, regs) in feasible.items():
        g = cat.goods[gid]
        if g["nt"] or g["local"] or g["capital"]:
            continue
        p = cat.procs[pid]
        c = physical.ref_unit_cost(w, cat, p, wm, sc.get("tfp", 1.0))
        comp[gid] = w.prices[gid] * 0.92 / max(c * 1.12 + g["kg"] / 1000.0 * 60, 1e-9)
    # ---- fixed point: production <-> incomes <-> demand, with exports
    # calibrated so that seeded employment matches the participating labor force
    adults = [p for p in w.persons.values() if 18 * 12 <= p.age < 65 * 12 and p.school is None]
    target_fte = len(adults) * sc.get("participation", 0.7) * 0.93
    elderly = sum(1 for p in w.persons.values() if p.age >= 65 * 12)
    kids = sum(1 for p in w.persons.values() if p.age < 18 * 12)
    gdp = pop * 2500.0 * wm ** 0.75 * 0.6
    cons = gdp * 0.6
    x_mult = 1.0
    plan = None
    for it in range(14):
        plan = _plan_economy(w, cat, sc, feasible, dom_share, comp, cons, gdp, x_mult)
        need = plan["fte"]
        avg_w = plan["avg_wage"]
        unemployed = max(0.0, len(adults) * sc.get("participation", 0.7) - need) * S
        transfers = (elderly * S * pol["pension_rate"] * avg_w + unemployed * 0.4 * avg_w * 0.8 +
                     kids * S * pol["child_benefit"] * avg_w)
        div = 0.5 * max(0.0, plan["va"] - plan["wages"]) * 0.6
        disp = plan["wages"] * 0.9 + transfers + div
        cons = 0.5 * cons + 0.5 * 0.92 * disp / (1 + pol["vat"])
        gdp = 0.5 * gdp + 0.5 * plan["va"] * 1.08
        if it >= 3:
            x_mult *= max(0.5, min(2.0, (target_fte / max(need, 1e-9)) ** 1.5))
            x_mult = max(0.05, min(20.0, x_mult))
    total, exports = plan["total"], plan["exports"]
    w.stats["export_mult"] = x_mult
    w.stats["absorb"] = {gid: v / max(w.prices[gid], 1e-9) for gid, v in total.items()}
    w.stats["seed_exports"] = sum(exports.values())
    w.stats["seed_imports"] = sum(v * (1 - dom_share.get(gid, 0)) for gid, v in total.items())
    w.stats["seed_fte"] = plan["fte"]
    w.stats["seed_target_fte"] = target_fte
    w.stats["seed_gdp"] = gdp
    gdp_month = gdp
    w.scenario["_housing_ref_price"] = w.prices["housing"]
    # capital stock implied: create firms
    min_value = 250.0 * S  # don't seed tiny industries
    for gid, (pid, cost, regs) in sorted(feasible.items()):
        g = cat.goods[gid]
        val = total.get(gid, 0) * dom_share[gid] + exports.get(gid, 0.0)
        if g["capital"] and not g["svc"]:
            continue  # seeded below from replacement demand
        if val < min_value:
            continue
        p = cat.procs[pid]
        qty = val / max(w.prices[gid], 1e-9)
        if g["local"] or g["nt"] and g["svc"]:
            # one producer per region proportional to population
            pops = {}
            for per in w.persons.values():
                pops[per.region] = pops.get(per.region, 0) + 1
            totp = sum(pops.values())
            for rid in range(len(w.regions)):
                if rid not in regs:
                    continue
                share = pops.get(rid, 0) / totp
                if share * qty <= 0:
                    continue
                _seed_firm(w, cat, rng, gid, pid, rid, share * qty)
        else:
            nf = max(1, min(4, int(1 + math.log10(max(val / (20000.0 * S), 1)))))
            reg_w = physical.region_weights(w, cat, p, regs)
            for k in range(nf):
                rid = rng.choices(list(reg_w), list(reg_w.values()))[0]
                _seed_firm(w, cat, rng, gid, pid, rid, qty / nf)
    # capital goods producers: sized to replacement demand from the plan
    for gid, (pid, cost, regs) in sorted(feasible.items()):
        g = cat.goods[gid]
        if not g["capital"] or g["svc"]:
            continue
        val = total.get(gid, 0) * dom_share[gid] + exports.get(gid, 0.0)
        if val < min_value:
            continue
        p = cat.procs[pid]
        qty = val / max(w.prices[gid], 1e-9)
        if g["local"]:
            pops = {}
            for per in w.persons.values():
                pops[per.region] = pops.get(per.region, 0) + 1
            totp = sum(pops.values())
            for rid in regs:
                _seed_firm(w, cat, rng, gid, pid, rid, qty * pops.get(rid, 0) / totp)
        else:
            reg_w = physical.region_weights(w, cat, p, regs)
            rid = rng.choices(list(reg_w), list(reg_w.values()))[0]
            _seed_firm(w, cat, rng, gid, pid, rid, qty)
    _seed_housing(w, cat, rng, sc)
    _staff_firms(w, cat, rng, sc)
    _init_finance(w, cat, rng, sc, gdp_month)
    for f in w.firms.values():
        w.produced_ever.add(f.good)


def _plan_economy(w, cat, sc, feasible, dom_share, comp, cons, gdp, x_mult):
    """Input-output plan for given household consumption, GDP (sets public
    budgets) and export multiplier. Returns production, labor and incomes."""
    from . import physical
    from .sim import WORLD_SCALE
    S = w.scale
    pol = w.policy
    pop = sc["population"]
    year = sc["year"]
    cons_pc = cons / pop
    shares = _catalog.engel_shares(cons_pc)
    final = {}
    for need, goods in cat.by_need.items():
        gs = [g for g in goods if cat.goods[g]["year"] <= year]
        if not gs:
            continue
        ws = [cat.goods[g]["need"][1] * (max(cons_pc, 30) / 600) ** cat.goods[g]["need"][2] for g in gs]
        tot = sum(ws) or 1
        for g, x in zip(gs, ws):
            final[g] = final.get(g, 0) + cons * shares[need] * x / tot
    goods_spend = sum(v for g, v in final.items() if not cat.goods[g]["svc"])
    for g in list(final):
        if not cat.goods[g]["svc"]:
            final[g] *= 0.85
    final["retail_trade"] = final.get("retail_trade", 0) + goods_spend * 0.15
    edu = gdp * pol["spend_education"]
    final["public_education"] = edu * (1 - pol["education_tertiary_share"])
    final["public_university"] = edu * pol["education_tertiary_share"]
    final["public_health"] = gdp * pol["spend_health"]
    final["public_research"] = gdp * pol["spend_research"]
    final["public_admin_services"] = gdp * pol["spend_admin"]
    final["infrastructure_works"] = gdp * pol["spend_infrastructure"]
    dwell = pop / sc.get("crowding", 2.6)
    final["dwelling"] = final.get("dwelling", 0) + dwell * w.prices["dwelling"] / cat.goods["dwelling"]["life"]
    total = dict(final)
    exports = {}
    repl = {}
    for it in range(10):
        inter = dict(repl)
        for gid, v in total.items():
            if gid not in feasible:
                continue
            p = cat.procs[feasible[gid][0]]
            q = (v * dom_share[gid] + exports.get(gid, 0.0)) / max(w.prices[gid], 1e-9)
            for alts, qty in p["inputs"]:
                a = min(alts, key=lambda x: w.prices[x])
                inter[a] = inter.get(a, 0) + q * qty * w.prices[a]
        total = dict(final)
        for gid, v in inter.items():
            total[gid] = total.get(gid, 0) + v
        exports = {gid: x_mult * WORLD_SCALE * total.get(gid, 0.0) * physical.export_share(c) * 0.6
                   for gid, c in comp.items() if total.get(gid, 0.0) > 0}
        # replacement investment for the capital this production needs
        repl = {}
        for gid, v in total.items():
            if gid not in feasible or gid == "housing":
                continue
            p = cat.procs[feasible[gid][0]]
            q = (v * dom_share[gid] + exports.get(gid, 0.0)) / max(w.prices[gid], 1e-9)
            eq = p["equip"][0] if p["equip"] else None
            if not eq or eq in cat.endowments or not p["rate"]:
                continue
            n = q * 1.2 / p["rate"]
            items = [(eq, n)] + [(alts[-1], n * r) for _, (alts, r) in p["aux"].items()]
            for a, cnt in items:
                ga = cat.goods[a]
                if a in cat.endowments or ga["year"] > year:
                    continue
                repl[a] = repl.get(a, 0) + cnt * w.prices[a] / (ga["life"] or 120)
    # labor & incomes
    tfp_scen = sc.get("tfp", 1.0)
    fte = 0.0
    wages = 0.0
    va = 0.0
    for gid, v in total.items():
        if gid not in feasible:
            continue
        g = cat.goods[gid]
        p = cat.procs[feasible[gid][0]]
        q = (v * dom_share[gid] + exports.get(gid, 0.0)) / max(w.prices[gid], 1e-9)
        if q <= 0:
            continue
        kh = 0.35 + 0.65 * physical.know_how(w, cat, p)
        tfp = kh * (0.55 + 0.45 * sc["infra"]) * tfp_scen / 1.04 ** sc.get("gen_lag", 1)
        for o, h in p["labor"].items():
            hrs = q * h / tfp / 0.85
            fte += hrs / (HOURS * S)
            wages += hrs * w.wage_index[o] / HOURS
        inp = sum(min(w.prices[a] for a in alts) * qq for alts, qq in p["inputs"])
        va += q * max(0.0, w.prices[gid] - inp)
    return {"total": total, "exports": exports, "fte": fte, "wages": wages, "va": va,
            "avg_wage": wages / max(fte * S, 1e-9)}


def _seed_firm(w, cat, rng, gid, pid, rid, qty_month):
    from . import physical
    p = cat.procs[pid]
    g = cat.goods[gid]
    f = w.new_firm(firm_name(rng, gid, cat), rid, gid, pid,
                   owner="state" if g["cat"] == "public" else "private")
    cap_per_eq = physical.capacity_per_primary(w, cat, p, w.regions[rid])
    if cap_per_eq <= 0:
        cap_per_eq = p["rate"] or 1.0
    n_eq = qty_month * 1.2 / max(cap_per_eq, 1e-12)
    if p["equip"]:
        eq = p["equip"][0]
        f.equip[eq] = n_eq
        f.eq_prec[eq] = cat.goods[eq]["prec"] or 1000
        if eq in cat.endowments:
            r = w.regions[rid]
            r.land_used[eq] = r.land_used.get(eq, 0) + n_eq
        for name, (alts, ratio) in p["aux"].items():
            a = alts[0]
            if cat.goods[a]["year"] > w.start_year and len(alts) > 1:
                a = alts[-1]
            if cat.goods[a]["year"] > w.start_year:
                continue
            f.equip[a] = f.equip.get(a, 0) + n_eq * ratio
            f.eq_prec[a] = cat.goods[a]["prec"] or 1000
    if p["dep"]:
        dep = w.regions[rid].deposits.get(p["dep"])
        if dep and dep["kind"] == "flow":
            pass
    f.price = w.prices[gid]
    f.markup = 0.12
    f.sales_ema = qty_month
    f.demand_ema = qty_month
    f.inv = 0.0 if g["svc"] else qty_month * 0.8
    for alts, q in p["inputs"]:
        a = min(alts, key=lambda x: w.prices[x])
        if not cat.goods[a]["svc"]:
            f.inv_in[a] = q * qty_month * 1.2
    f.plan = qty_month
    f.design = 1.0
    f.cum_output = qty_month * 12 * 25  # decades of industry experience
    f.gen = max(0, physical.world_generation(w, cat, gid) - w.scenario.get("gen_lag", 1))
    return f


def _scale_to_labor_force(w, cat, sc):
    """The economy before the simulation employed (roughly) the people who
    wanted to work. Scale market firms so seeded labor demand matches the
    participating labor force at ~7% unemployment."""
    from . import physical
    S = w.scale
    need = 0.0
    for f in w.firms.values():
        p = cat.procs[f.proc]
        hrs = physical.labor_hours_per_unit(w, cat, f, p)
        need += f.plan * sum(hrs.values()) / (HOURS * S * 0.85)
    adults = sum(1 for p in w.persons.values() if 18 * 12 <= p.age < 65 * 12 and p.school is None)
    target = adults * sc.get("participation", 0.7) * 0.93
    k = max(0.6, min(2.5, target / max(need, 1e-9)))
    for f in w.firms.values():
        g = cat.goods[f.good]
        if g["cat"] == "public" or f.good == "housing":
            continue
        f.plan *= k
        f.sales_ema *= k
        f.demand_ema *= k
        f.inv *= k
        f.cum_output *= k
        for a in f.inv_in:
            f.inv_in[a] *= k
        for e in list(f.equip):
            if e in cat.endowments:
                r = w.regions[f.region]
                free = r.land.get(e, 0) - r.land_used.get(e, 0)
                add = min(free, f.equip[e] * (k - 1)) if k > 1 else f.equip[e] * (k - 1)
                f.equip[e] += add
                r.land_used[e] = r.land_used.get(e, 0) + add
            else:
                f.equip[e] *= k
    w.stats["seed_scale"] = k


def _seed_housing(w, cat, rng, sc):
    pops = {}
    for p in w.persons.values():
        pops[p.region] = pops.get(p.region, 0) + 1
    for r in w.regions:
        people = pops.get(r.id, 0) * w.scale
        r.dwellings = people / sc.get("crowding", 2.6)
        hf = [f for f in w.firms.values() if f.good == "housing" and f.region == r.id]
        if hf:
            f = hf[0]
            f.equip = {"dwelling": r.dwellings}
            f.eq_prec = {"dwelling": 5000}
        r.rent = w.prices["housing"]


def _staff_firms(w, cat, rng, sc):
    """Assign the initial workforce. Fields of study are (re)drawn so that the
    educated population roughly matches the occupations the economy needs -
    this stands in for the country's history before the simulation starts."""
    from . import physical
    S = w.scale
    need = []  # (firm, occ, fte)
    occ_total = {}
    for f in w.firms.values():
        p = cat.procs[f.proc]
        hrs = physical.labor_hours_per_unit(w, cat, f, p)
        for occ, h in hrs.items():
            fte = f.plan * h / (HOURS * S * 0.85)
            if fte > 1e-4:
                need.append((f, occ, fte))
                occ_total[occ] = occ_total.get(occ, 0) + fte
    # field demand from occupations
    field_need = {}
    for occ, fte in occ_total.items():
        o = cat.occupations[occ]
        if o["edu"] >= 3:
            fs = [x for x in o["fields"] if x != "*"] or ["business"]
            for x in fs:
                field_need[x] = field_need.get(x, 0) + fte / len(fs)
    adults = [p for p in w.persons.values() if 18 * 12 <= p.age < 65 * 12 and p.school is None]
    rng.shuffle(adults)
    for p in adults:
        if p.edu >= 3 and field_need:
            lvl_fields = [f for f in field_need if cat.fields[f][0] <= max(p.edu, 3)]
            if p.edu == 3:
                lvl_fields = [f for f in field_need if cat.fields[f][0] == 3] or lvl_fields
            if lvl_fields:
                p.field = rng.choices(lvl_fields, [field_need[f] + 0.3 for f in lvl_fields])[0]
    # assign by most demanding occupations first
    need.sort(key=lambda x: -cat.occupations[x[1]]["edu"])
    free = {p.id: 1.0 for p in adults}
    by_region = {}
    for p in adults:
        by_region.setdefault(p.region, []).append(p)
    for f, occ, fte in need:
        o = cat.occupations[occ]
        remaining = fte
        pools = [by_region.get(f.region, [])] + [by_region[r] for r in by_region if r != f.region]
        for strict in (True, False):
            for pool in pools:
                for p in pool:
                    if remaining <= 1e-6:
                        break
                    if free[p.id] <= 1e-6:
                        continue
                    if p.occ and p.occ != occ:
                        continue
                    if strict and not eligible(o, p.edu, p.field):
                        continue
                    if not strict and p.edu + 1 < o["edu"]:
                        continue
                    take = min(free[p.id], remaining)
                    free[p.id] -= take
                    remaining -= take
                    p.occ = occ
                    yrs = max(0, (p.age / 12) - 18 - p.school_years + 6)
                    cap = 0.55 + 0.12 * max(0, p.edu - o["edu"]) + 0.3 * p.h
                    p.skill[occ] = min(cap, 0.25 + 0.025 * yrs + 0.2 * p.h)
                    wage = w.wage_index[occ]
                    p.jobs[f.id] = [take, wage]
                    f.staff[p.id] = f.staff.get(p.id, 0) + take
                    if p.region != f.region and strict is False:
                        pass
                if remaining <= 1e-6:
                    break
            if remaining <= 1e-6:
                break
    # everyone else: an occupation they could do, unemployed or outside the labor force
    part = sc.get("participation", 0.7)
    jobless = sum(1 for p in adults if not p.jobs) / max(len(adults), 1)
    p_inactive = min(0.9, max(0.0, (1 - part) / max(jobless, 1e-6)))
    for p in adults:
        if not p.jobs and rng.random() < p_inactive:
            p.inactive = True
        if p.occ is None:
            opts = [o for o, oc in cat.occupations.items() if eligible(oc, p.edu, p.field)]
            opts = [o for o in opts if cat.occupations[o]["edu"] >= min(p.edu, 2) - 1] or opts
            p.occ = rng.choice(opts) if opts else "laborer"
            p.skill[p.occ] = 0.3
        p.urban = p.occ not in ("farmer", "forester", "fisher", "miner")
        p.prev_wage = w.wage_index.get(p.occ, 0)


def _set_prices(w, cat, sc):
    """Seeded firms charge cost-based prices: non-tradables (housing, local
    services) at local cost, tradables between cost and the import price."""
    from . import physical
    for it in range(4):
        by_good = {}
        for f in w.firms.values():
            p = cat.procs[f.proc]
            c = physical.est_unit_cost(w, cat, p, f.region)
            g = cat.goods[f.good]
            if c is None or c <= 0:
                continue
            if g["nt"] or g["local"] or g["svc"]:
                f.price = c * 1.15
            else:
                wp = cat.world_price(f.good, w.year) or g["price"]
                f.price = max(c * 1.05, min(wp, c * 1.4))
            f.cost_ema = c
            by_good.setdefault(f.good, []).append((f.plan, f.price))
        for gid, lst in by_good.items():
            tot = sum(q for q, _ in lst)
            if tot > 0:
                w.prices[gid] = sum(q * pr for q, pr in lst) / tot
    # housing stock consistent with what households can afford at cost-based rents
    for f in w.firms.values():
        if f.good == "housing":
            value = f.plan * w.scenario.get("_housing_ref_price", cat.goods["housing"]["price"])
            q = value / max(f.price, 1e-9)
            f.plan = f.sales_ema = f.demand_ema = q
            f.equip["dwelling"] = q * 1.04
            w.regions[f.region].dwellings = f.equip["dwelling"]


def _init_finance(w, cat, rng, sc, gdp_month):
    S = w.scale
    _set_prices(w, cat, sc)
    # household savings
    for p in w.persons.values():
        if p.age >= 18 * 12:
            wage = sum(j[0] * j[1] for j in p.jobs.values())
            inc = wage * 0.85 + (1 - p.fte) * 0.25 * w.wage_index.get(p.occ, 500)
            p.income_last = inc
            p.prev_wage = max(p.prev_wage, wage)
            p.savings = max(0.0, max(inc, 200) * sc["savings_months"] * math.exp(rng.gauss(0, 0.9)))
    # firms: cash for ~2 months of costs, debt half of capital value
    for f in w.firms.values():
        p = cat.procs[f.proc]
        wages = sum(w.persons[pid].jobs[f.id][0] * w.persons[pid].jobs[f.id][1] for pid in f.staff) * S
        inputs = sum(min(w.prices[a] for a in alts) * q for alts, q in p["inputs"]) * f.plan
        f.cash = 2.0 * (wages + inputs) + 1e4
        kval = sum(n * w.prices.get(e, 0) for e, n in f.equip.items() if e not in cat.endowments)
        f.debt = (0.15 if f.good == "housing" else 0.35) * kval
        f.last = {"revenue": f.plan * f.price, "wages": wages, "inputs": inputs}
    hh_dep = sum(p.savings for p in w.persons.values()) * S
    firm_dep = sum(max(0, f.cash) for f in w.firms.values())
    loans = sum(f.debt for f in w.firms.values())
    gov_debt = sc["gov_debt"] * gdp_month * 12
    w.gov = {"cash": gdp_month * 0.3, "debt": gov_debt, "revenue": {}, "spending": {},
             "gdp_est": gdp_month, "students": {}, "infra_stock": {}}
    w.bank = {"loans": loans, "bonds": gov_debt, "equity": 0.1 * (loans + gov_debt),
              "deposits": hh_dep + firm_dep + w.gov["cash"]}
    w.bank["reserves"] = w.bank["deposits"] + w.bank["equity"] - w.bank["loans"] - w.bank["bonds"]
    w.policy_rate = 0.04
    # value added implied by the seeded firms (better than the a-priori guess)
    va = 0.0
    for f in w.firms.values():
        p = cat.procs[f.proc]
        inp = sum(min(w.prices[a] for a in alts) * q for alts, q in p["inputs"])
        va += f.plan * max(0.0, f.price - inp)
    gdp_month = max(va * 1.08, w.stats.get("seed_gdp", gdp_month) * 0.5)
    w.gov["cash"] = gdp_month * 0.3
    w.gov["debt"] = sc["gov_debt"] * gdp_month * 12
    w.bank["bonds"] = w.gov["debt"]
    w.bank["equity"] = 0.1 * (w.bank["loans"] + w.bank["bonds"])
    w.stats["gdp_month"] = gdp_month
    w.stats["gdp_trailing"] = gdp_month
    w.stats["gdp_trend"] = gdp_month
    w.stats["cpi"] = 1.0
    w.stats["avg_wage"] = sum(w.wage_index.values()) / len(w.wage_index)
