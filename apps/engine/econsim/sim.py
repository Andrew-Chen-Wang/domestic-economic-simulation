"""Monthly simulation step: the economic and social engine, wired to the
physical and knowledge engines.

Order of a month:
  macro & policy -> demography & schooling -> regions -> firm plans ->
  labor market -> productive potential -> demand -> market clearing ->
  production -> incomes, taxes & transfers -> firm finance, entry & exit ->
  R&D & knowledge -> infrastructure & housing -> exchange rate -> metrics
"""
import math
from collections import defaultdict

from . import catalog as _catalog
from . import demography
from . import knowledge_engine
from . import physical
from . import policy as _policy
from .catalog.people import eligible
from .world import HOURS

SIGMA = 5.0          # substitution elasticity between suppliers of the same good
HOME_BIAS = 0.5      # import presence relative to domestic suppliers
WORLD_SCALE = 30.0   # rest of world's market size relative to ours, per good
RD_INTENSITY = {"semis": 0.15, "pharma": 0.14, "electronics": 0.08, "software": 0.15,
                "electrical": 0.05, "capital": 0.04, "component": 0.03, "chem": 0.03,
                "health": 0.06, "personal": 0.02, "toys": 0.02, "consumer": 0.02}
RD_OCC = {"semis": "process_engineer", "electronics": "elec_engineer", "electrical": "elec_engineer",
          "pharma": "pharmacist", "chem": "chem_engineer", "personal": "chem_engineer",
          "metal": "materials_engineer", "software": "software_dev", "capital": "mech_engineer",
          "component": "mech_engineer", "consumer": "mech_engineer", "toys": "designer",
          "health": "elec_engineer", "mineral": "materials_engineer", "energy": "elec_engineer",
          "food": "chem_engineer", "apparel": "designer", "textile": "chem_engineer",
          "agri": "agronomist", "service": "software_dev", "media": "designer",
          "paper": "chem_engineer", "wood": "mech_engineer", "building": "civil_engineer",
          "resource": "mech_engineer", "public": "scientist"}
SECTOR_OF_CAT = {"resource": "Mining & extraction", "agri": "Agriculture", "food": "Food & beverages",
                 "textile": "Textiles & apparel", "apparel": "Textiles & apparel", "wood": "Wood & paper",
                 "paper": "Wood & paper", "media": "Media & publishing", "energy": "Energy & utilities",
                 "chem": "Chemicals & plastics", "mineral": "Building materials", "metal": "Metals",
                 "semis": "Semiconductors & electronics", "electronics": "Semiconductors & electronics",
                 "component": "Machinery & components", "electrical": "Electrical equipment",
                 "capital": "Machinery & components", "building": "Construction",
                 "consumer": "Consumer goods", "personal": "Consumer goods", "toys": "Consumer goods",
                 "pharma": "Health & pharma", "health": "Health & pharma", "service": "Services",
                 "software": "Software & IT", "public": "Public services"}
FREIGHT_GOODS = ("freight_trucking", "freight_rail")
INFRA_K = {"road": 40000.0, "rail": 25000.0, "port": 4.0e8, "grid": 350.0, "broadband": 160.0,
           "transit": 450.0, "irrigation": 600.0}


class Ctx:
    def __init__(self):
        self.ledger = defaultdict(float)
        self.stats = {}
        self.fs = {}
        self.flows = defaultdict(lambda: defaultdict(float))
        self.rd_spill = {}
        self.practiced = defaultdict(float)
        self.freight_fee = defaultdict(float)
        self.sea_fee = 0.0
        self.gov_spend = defaultdict(float)
        self.gov_rev = defaultdict(float)
        self.hh_spent = defaultdict(float)
        self.hh_plan = {}
        self.region_va = defaultdict(float)
        self.sector_va = defaultdict(float)
        self.gov_bought = defaultdict(lambda: defaultdict(float))
        self.emissions = 0.0
        self.elec_mix = defaultdict(float)
        self.informal = defaultdict(float)
        self.imp_ledger = []


class Sim:
    def __init__(self, world):
        self.w = world
        self.cat = _catalog.get()
        self._elig = {}
        self._ctx = None

    # ------------------------------------------------------------ helpers
    def ledger(self, src, dst, kind, amount):
        if amount and self._ctx is not None:
            self._ctx.ledger[(src, dst, kind)] += amount

    def eligible_occs(self, edu, field):
        key = (edu, field)
        if key not in self._elig:
            self._elig[key] = [o for o, oc in self.cat.occupations.items() if eligible(oc, edu, field)]
        return self._elig[key]

    def quit_all_jobs(self, p):
        w = self.w
        if p.jobs:
            p.prev_wage = max((j[1] for j in p.jobs.values()), default=p.prev_wage)
        for fid in list(p.jobs):
            f = w.firms.get(fid)
            if f:
                f.staff.pop(p.id, None)
        p.jobs = {}

    def faccount(self, f):
        return "firm:%d" % f.id

    def tariff(self, gid):
        g = self.cat.goods[gid]
        pol = self.w.policy
        return pol["tariff_general"] + float(pol["tariff_by_category"].get(g["cat"], 0.0)) + \
            float(pol["tariff_by_category"].get(gid, 0.0))

    def import_ok(self, gid):
        g = self.cat.goods[gid]
        if g["restricted"] or g["nt"] or (g["svc"] and g["local"]):
            return False
        if g["year"] > self.w.year:
            return False
        if _policy.in_list(self.w.policy["import_bans"], gid, g["cat"]):
            return False
        return True

    # ---------------------------------------------------------------- step
    def step(self):
        w = self.w
        ctx = Ctx()
        self._ctx = ctx
        self._macro(ctx)
        demography.step(self, ctx)
        self._regions(ctx)
        self._firm_plan(ctx)
        self._labor_market(ctx)
        self._potential(ctx)
        demand = self._demand(ctx)
        self._markets(ctx, demand)
        self._production(ctx)
        self._incomes(ctx)
        self._firm_finance(ctx)
        knowledge_engine.step(self, ctx)
        knowledge_engine.update_skills(self, ctx)
        self._infrastructure(ctx)
        self._external(ctx)
        metrics = self._metrics(ctx)
        w.tick += 1
        self._ctx = None
        return ctx, metrics

    # ---------------------------------------------------------------- macro
    def _macro(self, ctx):
        w = self.w
        pol = w.policy
        st = w.stats
        infl = st.get("inflation", 0.02)
        u = st.get("unemployment", 0.06)
        if pol["policy_rate_mode"] == "fixed":
            w.policy_rate = float(pol["policy_rate"])
        else:
            # Taylor rule (natural unemployment ~8%), with interest-rate smoothing
            target = 0.02 + infl + 0.5 * (infl - pol["inflation_target"]) - 0.3 * (u - 0.08)
            target = max(0.0, min(0.25, target))
            w.policy_rate = 0.9 * w.policy_rate + 0.1 * target
        st["lend_rate"] = w.policy_rate + 0.025
        st["dep_rate"] = max(0.0, w.policy_rate - 0.01)
        # budgets follow trend (not current) GDP: spending is a stabilizer
        gdp = st.get("gdp_trend", st.get("gdp_trailing", st.get("gdp_month", 1e8)))
        st["budget"] = {k: pol["spend_" + k] * gdp for k in
                        ("education", "health", "research", "infrastructure", "admin")}

    # ------------------------------------------------------------- regions
    def _regions(self, ctx):
        w, cat = self.w, self.cat
        pop = defaultdict(int)
        urban = defaultdict(int)
        for p in w.persons.values():
            pop[p.region] += 1
            if p.urban:
                urban[p.region] += 1
        pol = w.policy
        for r in w.regions:
            r.pop = pop[r.id]
            r.urban_pop = urban[r.id]
            up = r.urban_pop * w.scale
            density = up / max(r.urban_km2, 1)
            agglo = (max(up, 2e4) / 1e6) ** 0.04
            congestion = 0.12 * (1 - r.infra["transit"]) * min(1.0, density / 12000.0)
            r.productivity = agglo * (1 - congestion)
            # cities grow outward when crowded, faster with roads and land release
            if density > 6000:
                r.urban_km2 *= 1 + 0.0006 * pol["urban_expansion"] * (0.3 + r.infra["road"])

    def max_dwellings(self, r):
        w = self.w
        rural = (r.pop - r.urban_pop) * w.scale / 2.8
        return r.urban_km2 * 2200.0 * w.policy["zoning_density"] + rural * 1.05

    # -------------------------------------------------------------- firms
    def rd_occ(self, f):
        g = self.cat.goods[f.good]
        p = self.cat.procs[f.proc]
        for k in p["know"]:
            node = self.cat.knowledge[k]
            if node["kind"] != "sci":
                from .catalog.knowledge import FIELDS
                occs = FIELDS.get(node["field"])
                if occs:
                    return occs[0]
        return RD_OCC.get(g["cat"], "mech_engineer")

    def _firm_plan(self, ctx):
        w, cat = self.w, self.cat
        pol = w.policy
        for f in list(w.firms.values()):
            p = cat.procs[f.proc]
            g = cat.goods[f.good]
            fs = ctx.fs[f.id] = {"sold": 0.0, "wanted": 0.0, "revenue": 0.0, "export_rev": 0.0,
                                 "inputs_bought": 0.0, "subsidy": 0.0, "exported": 0.0,
                                 "freight_rev": 0.0}
            hours = physical.labor_hours_per_unit(w, cat, f, p)
            fs["hours"] = hours
            rd_occ = self.rd_occ(f)
            fs["rd_occ"] = rd_occ
            if f.design < 1.0:
                fs.update(cap=0.0, y=0.0, plan=0.0, gross=0.0, labor_gross=0.0)
                f.rd_share = 1.0
                wage = w.wage_index.get(rd_occ, 3000)
                budget = max(0.0, f.cash) * 0.05 + (w.gov.get("cash", 0) * 0 if f.owner != "state" else 0)
                fs["rd_fte"] = max(0.05, min(4.0, budget / (wage * w.scale)))
                f.blocked = f.blocked or "product design in progress"
                continue
            cap, why = physical.equipment_capacity(w, cat, f, p)
            y, q, why2 = physical.yield_quality(w, cat, f, p)
            f.blocked = why or why2
            if y > 0:
                f.quality = q
            dem = max(f.demand_ema, 0.0)
            netcap = cap * y
            if g["svc"]:
                plan = min(netcap, dem * 1.1 + 1e-9)
            else:
                target_inv = dem * 1.0
                plan = max(0.0, min(netcap, dem + 0.5 * (target_inv - f.inv)))
            labor_net = min(netcap, max(plan, dem * 1.08))
            fs.update(cap=cap, y=y, plan=plan, gross=(plan / y if y > 0 else 0.0),
                      labor_gross=(labor_net / y if y > 0 else 0.0))
            f.plan = plan
            # R&D staff: by sector intensity, boosted by the R&D tax credit
            inten = RD_INTENSITY.get(g["cat"], 0.005) * (1.0 + pol["rd_tax_credit"])
            rev = f.last.get("revenue", 0.0)
            wage = w.wage_index.get(rd_occ, 3000)
            fs["rd_fte"] = inten * rev / max(wage * w.scale, 1.0) if f.profit_ema > 0 else 0.0
            f.rd_share = 0.0 if fs["rd_fte"] <= 0 else 1.0

    # --------------------------------------------------------- labor market
    def _staff_hours(self, f):
        """Effective hours by occupation (skill-adjusted)."""
        w = self.w
        out = defaultdict(float)
        for pid, fte in f.staff.items():
            p = w.persons.get(pid)
            if p is None:
                continue
            out[p.occ] += fte * w.scale * HOURS * physical.worker_productivity(p.skill.get(p.occ, 0.2))
        return out

    def _labor_market(self, ctx):
        w, cat = self.w, self.cat
        rng = w.rng
        S = w.scale
        pol = w.policy
        med = w.stats.get("median_wage", 1000.0)
        min_wage = pol["minimum_wage"] * med
        vacancies = []
        fire_cost = pol["firing_cost_months"]
        for f in w.firms.values():
            fs = ctx.fs[f.id]
            have = self._staff_hours(f)
            fs["have_hours"] = have
            want = {o: fs["labor_gross"] * h for o, h in fs["hours"].items()}
            if fs.get("rd_fte", 0) > 0:
                o = fs["rd_occ"]
                want[o] = want.get(o, 0.0) + fs["rd_fte"] * S * HOURS * 0.8
            fs["want_hours"] = want
            # firing when overstaffed (or the firm is broke)
            for o, h in list(have.items()):
                need = want.get(o, 0.0)
                excess = h - need * 1.3 - 0.02 * S * HOURS
                if f.distress >= 2:
                    excess = max(excess, h * 0.15)
                if excess > 0 and (f.util_ema < 0.75 or f.distress >= 2 or need == 0):
                    staff = sorted((pid for pid in f.staff if w.persons[pid].occ == o),
                                   key=lambda pid: w.persons[pid].skill.get(o, 0))
                    for pid in staff:
                        if excess <= 0:
                            break
                        p = w.persons[pid]
                        per_fte = S * HOURS * physical.worker_productivity(p.skill.get(o, 0.2))
                        cut = min(f.staff[pid], excess / per_fte)
                        if cut <= 0.01:
                            continue
                        wage = p.jobs[f.id][1]
                        sev = fire_cost * wage * cut * S
                        f.cash -= sev
                        p.savings += sev / S
                        self.ledger(self.faccount(f), "hh:%d" % p.region, "severance", sev)
                        p.prev_wage = max(p.prev_wage, wage)
                        f.staff[pid] -= cut
                        p.jobs[f.id][0] -= cut
                        if f.staff[pid] <= 0.01:
                            del f.staff[pid]
                            del p.jobs[f.id]
                        excess -= cut * per_fte
            # vacancies
            for o, need in want.items():
                gap = need - have.get(o, 0.0)
                if gap > 0.01 * S * HOURS:
                    base = w.wage_index.get(o, 2000.0)
                    prev = f.wage_offer.get(o, base)
                    offer = max(min_wage, min(base * 1.6, prev * 1.03)) if fs.get("unfilled_" + o) or \
                        f.wage_offer.get("_unfilled_" + o) else max(min_wage, 0.5 * prev + 0.5 * base)
                    if f.distress:
                        offer = max(min_wage, base * 0.95)
                    f.wage_offer[o] = offer
                    vacancies.append((offer, f, o, gap / (S * HOURS * 0.8)))
        # candidate pools
        pool = defaultdict(list)        # (region, occ) -> persons
        anyp = defaultdict(list)        # region -> fully unemployed persons
        ret = pol["retirement_age"] * 12
        for p in w.persons.values():
            if p.school or p.occ is None or p.age < 15 * 12 or p.age >= ret or p.inactive:
                continue
            free = 1.0 - p.fte
            if free < 0.05:
                continue
            pool[(p.region, p.occ)].append(p)
            if free > 0.95:
                anyp[p.region].append(p)
        for k in pool:
            pool[k].sort(key=lambda p: -p.skill.get(p.occ, 0))
        vacancies.sort(key=lambda v: -v[0])
        vac_by_occ = defaultdict(float)
        hires = 0.0
        nreg = len(w.regions)
        for offer, f, o, fte in vacancies:
            remaining = fte
            occ = cat.occupations[o]
            sources = [pool[(f.region, o)]]
            # unemployed people can retrain into the occupation if qualified
            cands = [p for p in anyp[f.region] if p.fte < 0.05 and eligible(occ, p.edu, p.field,
                                                                               p.skill.get(o, 0))]
            sources.append(cands)
            for r2 in rng.sample(range(nreg), nreg):
                if r2 != f.region:
                    sources.append([p for p in pool[(r2, o)] if p.fte < 0.05 and p.unemp >= 2])
            # long-term unemployed elsewhere will move and retrain if qualified
            for r2 in rng.sample(range(nreg), nreg):
                if r2 != f.region:
                    sources.append([p for p in anyp[r2] if p.fte < 0.05 and p.unemp >= 4 and
                                    eligible(occ, p.edu, p.field, p.skill.get(o, 0))])
            for src in sources:
                for p in src:
                    if remaining <= 0.01:
                        break
                    free = 1.0 - p.fte
                    if free < 0.05:
                        continue
                    reservation = max(min_wage * 0.9, 0.6 * p.prev_wage)
                    if offer < reservation and p.unemp < 6:
                        continue
                    take = min(free, remaining)
                    if p.occ != o:
                        # switching occupation (only when fully unemployed)
                        if p.fte > 0.01:
                            continue
                        p.occ = o
                        p.skill[o] = max(p.skill.get(o, 0.0), min(0.5, 0.08 + 0.3 * p.h))
                        p.urban = o not in ("farmer", "forester", "fisher", "miner")
                    if p.region != f.region:
                        self.quit_all_jobs(p)
                        p.region = f.region
                        for q in w.persons.values():
                            if q.guardian == p.id:
                                q.region = f.region
                    if f.id in p.jobs:
                        p.jobs[f.id][0] += take
                        p.jobs[f.id][1] = 0.5 * (p.jobs[f.id][1] + offer)
                    else:
                        p.jobs[f.id] = [take, offer]
                    f.staff[p.id] = f.staff.get(p.id, 0.0) + take
                    remaining -= take
                    hires += take
                    # tacit know-how travels with experienced workers
                    if f.design < 1.0 and p.last_good == f.good:
                        f.design = min(0.95, f.design + 0.08 * p.skill.get(o, 0.3))
                    p.last_good = f.good
                if remaining <= 0.01:
                    break
            f.wage_offer["_unfilled_" + o] = remaining > 0.05
            if remaining > 0.01:
                vac_by_occ[o] += remaining
        w.stats["vacancies_by_occ"] = dict(vac_by_occ)
        ctx.stats["hires"] = hires * S
        ctx.stats["vacancies"] = sum(vac_by_occ.values()) * S

    # ------------------------------------------------------------ potential
    def _potential(self, ctx):
        w, cat = self.w, self.cat
        for f in w.firms.values():
            fs = ctx.fs[f.id]
            if f.design < 1.0 or fs["cap"] <= 0 or fs["y"] <= 0:
                fs.update(labor_cap=0.0, offer=0.0, prod_gross=0.0)
                continue
            have = self._staff_hours(f)
            fs["have_hours"] = have
            hours = fs["hours"]
            tot_h = sum(hours.values()) or 1.0
            H = sum(have.get(o, 0.0) for o in hours)
            balanced = H / tot_h
            g = cat.goods[f.good]
            floor = 0.02 if (g["clean"] or (g["tol"] and g["tol"] < 5)) else 0.25
            lc = 1.0
            for o, h in hours.items():
                r = have.get(o, 0.0) / h if h > 0 else 1e18
                r = max(r, floor * balanced)
                lc *= max(r, 1e-12) ** (h / tot_h)
            fs["labor_cap"] = lc
            gross = min(fs["cap"], lc)
            fs["pot_gross"] = gross
            fs["offer"] = gross * fs["y"] if g["svc"] else 0.0
            fs["prod_gross"] = min(fs["gross"], gross) if not g["svc"] else 0.0

    # --------------------------------------------------------------- demand
    def hh_price(self, gid, r):
        """Expected price households face (before VAT)."""
        return self.w.prices.get(gid, self.cat.goods[gid]["price"])

    def _demand(self, ctx):
        """Returns {good: [(kind, key, region, qty)]}"""
        w, cat = self.w, self.cat
        pol = w.policy
        S = w.scale
        demand = defaultdict(list)
        supply_regions = defaultdict(set)
        for f in w.firms.values():
            fs = ctx.fs[f.id]
            if f.design >= 1 and ((not cat.goods[f.good]["svc"] and f.inv > 0) or fs.get("offer", 0) > 0
                                  or fs.get("prod_gross", 0) > 0):
                supply_regions[f.good].add(f.region)
        self._supply_regions = supply_regions

        def available(gid, r):
            g = cat.goods[gid]
            sr = supply_regions.get(gid)
            if sr:
                if g["local"]:
                    if r in sr:
                        return True
                else:
                    return True
            return self.import_ok(gid)

        # ---- firm intermediate inputs & equipment orders
        for f in w.firms.values():
            fs = ctx.fs[f.id]
            p = cat.procs[f.proc]
            g = cat.goods[f.good]
            if f.design >= 1 and fs.get("y", 0) > 0:
                if g["svc"]:
                    gross = min(fs.get("pot_gross", 0), max(f.demand_ema, f.sales_ema) * 1.1 / fs["y"])
                else:
                    gross = fs.get("prod_gross", 0)
                gf = physical.gen_factor(w, cat, f)
                for alts, q in p["inputs"]:
                    choice = None
                    for a in alts:
                        if available(a, f.region):
                            pa = w.prices.get(a, 1e18)
                            if choice is None or pa < choice[1]:
                                choice = (a, pa)
                    if choice is None:
                        continue
                    a = choice[0]
                    need = gross * q * gf
                    if cat.goods[a]["svc"]:
                        order = need
                    else:
                        have = sum(f.inv_in.get(x, 0.0) for x in alts)
                        order = max(0.0, 1.5 * need - have)
                    if order > 1e-12:
                        demand[a].append(("firm", f.id, f.region, order))
            for eq, qty in list(f.orders.items()):
                if qty <= 1e-12:
                    continue
                if eq == f.good and f.inv > 0:
                    # a machine maker equips itself from its own output
                    take = min(f.inv, qty)
                    f.inv -= take
                    f.equip[eq] = f.equip.get(eq, 0.0) + take
                    f.eq_prec[eq] = f.eq_prec.get(eq, cat.goods[eq]["prec"] or 1000)
                    f.orders[eq] = qty - take
                    qty -= take
                if qty > 1e-12 and available(eq, f.region):
                    demand[eq].append(("inv", f.id, f.region, qty))
                elif not available(eq, f.region) and cat.goods[eq]["year"] > w.year + 5:
                    f.orders[eq] = 0.0  # cannot be obtained: drop the order
        # ---- households
        ret = pol["retirement_age"] * 12
        groups = defaultdict(lambda: {"budget": 0.0, "members": 0.0, "adults": []})
        kids = defaultdict(int)
        for p in w.persons.values():
            if p.age < 18 * 12 and p.guardian:
                kids[p.guardian] += 1
        med = max(w.stats.get("median_wage", 1000.0), 1.0)
        incs = []
        for p in w.persons.values():
            if p.age < 18 * 12 and p.guardian in w.persons:
                continue
            inc = p.income_last
            nk = kids.get(p.id, 0)
            mpc = 0.95 - 0.2 * min(1.0, inc / (3 * med))
            subsist = 0.3 * med * (1 + 0.4 * nk)
            # spending out of wealth rises once savings exceed a comfortable buffer
            buffer = 6 * max(inc, 0.5 * med)
            wealth_spend = 0.01 * min(p.savings, buffer) + 0.04 * max(0.0, p.savings - buffer)
            c = max(subsist, mpc * inc + wealth_spend)
            c = min(c, max(0.0, p.savings))
            pc = inc / (1 + 0.5 * nk)
            incs.append((pc, p, c, nk))
        incs.sort(key=lambda x: x[0])
        n = len(incs)
        for i, (pc, p, c, nk) in enumerate(incs):
            tier = 0 if i < n * 0.5 else (1 if i < n * 0.9 else 2)
            key = (p.region, tier)
            gr = groups[key]
            gr["budget"] += c * S
            gr["members"] += (1 + nk) * S
            gr["adults"].append((p, c))
        self._hh_groups = groups
        cpi = max(w.price_index, 1e-6)
        vat = pol["vat"]
        csub = pol["subsidies_consumer"]
        hh_need = defaultdict(float)
        for (r, tier), gr in groups.items():
            B = gr["budget"]
            if B <= 0:
                continue
            pc_real = B / gr["members"] / cpi / max(w.fx, 1e-6) ** 0.0
            shares = _catalog.engel_shares(pc_real)
            unspent = 0.0
            plans = []
            for need, share in shares.items():
                goods = [gid for gid in cat.by_need.get(need, []) if available(gid, r)]
                if not goods:
                    unspent += share
                    continue
                ws = []
                for gid in goods:
                    gg = cat.goods[gid]
                    _, wt, el = gg["need"]
                    ref = (cat.world_price(gid, w.year) or gg["price"] * 3) * w.fx
                    pr = self.hh_price(gid, r) * (1 - _policy.lookup_rate(csub, gid, gg["cat"]))
                    rel = max(0.05, pr / max(ref, 1e-9))
                    ws.append(wt * (max(pc_real, 30) / 600.0) ** el * rel ** -1.5)
                tw = sum(ws)
                for gid, x in zip(goods, ws):
                    plans.append((gid, share * x / tw))
            scale_up = 1.0 / max(1e-6, 1.0 - unspent)
            goods_value = 0.0
            for gid, sh in plans:
                gg = cat.goods[gid]
                spend = B * sh * scale_up
                if not gg["svc"]:
                    goods_value += spend * 0.15
                    spend *= 0.85
                pr = self.hh_price(gid, r) * (1 + vat) * (1 - _policy.lookup_rate(csub, gid, gg["cat"]))
                demand[gid].append(("hh", (r, tier), r, spend / max(pr, 1e-9)))
                hh_need[gg["need"][0]] += spend
            if goods_value > 0:
                pr = self.hh_price("retail_trade", r) * (1 + vat)
                demand["retail_trade"].append(("hh", (r, tier), r, goods_value / max(pr, 1e-9)))
        ctx.stats["hh_need"] = dict(hh_need)
        # ---- government
        bud = w.stats["budget"]
        regs = w.regions
        tot_pop = sum(r.pop for r in regs) or 1
        students = defaultdict(int)
        tert = defaultdict(int)
        for p in w.persons.values():
            if p.school == "school":
                students[p.region] += 1
            elif p.school:
                tert[p.region] += 1
        ts = sum(students.values()) or 1
        tt = sum(tert.values()) or 1
        edu_b = bud["education"]
        tshare = pol["education_tertiary_share"]
        infra_w = pol["infrastructure_regions"] or {}
        iw = {r.id: float(infra_w.get(str(r.id), infra_w.get(r.id, r.pop / tot_pop * len(regs)))) for r in regs}
        tiw = sum(iw.values()) or 1
        for r in regs:
            gov = "gov"
            items = [
                ("public_education", edu_b * (1 - tshare) * students[r.id] / ts),
                ("public_university", edu_b * tshare * (tert[r.id] / tt * 0.5 + r.pop / tot_pop * 0.5)),
                ("public_health", bud["health"] * r.pop / tot_pop),
                ("public_research", bud["research"] * r.pop / tot_pop),
                ("public_admin_services", bud["admin"] * r.pop / tot_pop),
                ("infrastructure_works", bud["infrastructure"] * iw[r.id] / tiw),
            ]
            for gid, val in items:
                if val <= 0:
                    continue
                pr = w.prices.get(gid, cat.goods[gid]["price"])
                demand[gid].append(("gov", r.id, r.id, val / max(pr, 1e-9)))
        return demand

    # --------------------------------------------------------------- markets
    def _markets(self, ctx, demand):
        w, cat = self.w, self.cat
        rng = w.rng
        pol = w.policy
        vat = pol["vat"]
        sellers_by_good = defaultdict(list)
        for f in w.firms.values():
            if f.design < 1:
                continue
            fs = ctx.fs[f.id]
            g = cat.goods[f.good]
            avail = fs.get("offer", 0.0) if g["svc"] else f.inv
            if avail > 1e-12:
                sellers_by_good[f.good].append([f, avail])
        goods = [g for g in set(demand) | set(sellers_by_good) if g not in FREIGHT_GOODS]
        goods.sort()
        for gid in goods:
            self._clear(ctx, gid, demand.get(gid, []), sellers_by_good.get(gid, []))
        self._clear_freight(ctx, sellers_by_good)
        # household budgets: deduct actual spending from adults' savings
        for key, gr in self._hh_groups.items():
            spent = ctx.hh_spent.get(key, 0.0)
            plan = sum(c for _, c in gr["adults"]) * w.scale
            ratio = spent / plan if plan > 0 else 0.0
            for p, c in gr["adults"]:
                p.savings -= c * ratio
                if p.savings < 0:
                    p.savings = 0.0

    def _clear(self, ctx, gid, buyers, sellers):
        w, cat = self.w, self.cat
        g = cat.goods[gid]
        pol = w.policy
        vat = pol["vat"]
        csub = _policy.lookup_rate(pol["subsidies_consumer"], gid, g["cat"])
        psub = _policy.lookup_rate(pol["subsidies_producer"], gid, g["cat"])
        imp_ok = self.import_ok(gid)
        tariff = self.tariff(gid) if imp_ok else 0.0
        by_region = defaultdict(list)
        for b in buyers:
            by_region[b[2]].append(b)
        rem = {id(s): s[1] for s in sellers}
        fl = ctx.flows[gid]
        regions = list(by_region)
        w.rng.shuffle(regions)
        paid_total = 0.0
        qty_total = 0.0
        for r in regions:
            bl = by_region[r]
            D = sum(b[3] for b in bl)
            if D <= 0:
                continue
            cands = []
            for s in sellers:
                f = s[0]
                if g["local"] and f.region != r:
                    continue
                if rem[id(s)] <= 1e-12:
                    continue
                tc = physical.transport_cost(w, cat, gid, f.region, r)
                eff = (f.price + tc) / max(f.quality, 0.05) ** 1.2
                cands.append([s, tc, eff])
            imp_p = None
            if imp_ok:
                ip = physical.import_price(w, cat, gid, r)
                if ip is not None:
                    imp_p = ip * (1 + tariff)
            weights = []
            for c in cands:
                weights.append(rem[id(c[0])] ** 0.5 * max(c[2], 1e-12) ** -SIGMA)
            wm = 0.0
            if imp_p is not None:
                wm = HOME_BIAS * D ** 0.5 * max(imp_p, 1e-12) ** -SIGMA
            tw = sum(weights) + wm
            alloc = [0.0] * len(cands)
            imp_q = 0.0
            if tw > 0:
                left = D
                for i, c in enumerate(cands):
                    want = D * weights[i] / tw
                    c[0][0].__class__  # noqa
                    ctx.fs[c[0][0].id]["wanted"] += want
                    take = min(want, rem[id(c[0])])
                    alloc[i] = take
                    left -= take
                imp_q = D * wm / tw
                left -= imp_q
                # overflow: other domestic sellers with spare stock, then imports
                if left > 1e-12:
                    for i, c in sorted(enumerate(cands), key=lambda x: x[1][2]):
                        spare = rem[id(c[0])] - alloc[i]
                        if spare > 1e-12:
                            t = min(spare, left)
                            alloc[i] += t
                            left -= t
                        if left <= 1e-12:
                            break
                if left > 1e-12 and imp_p is not None:
                    imp_q += left
                    left = 0.0
                fl["shortage"] += max(0.0, left)
            else:
                fl["shortage"] += D
                continue
            served = sum(alloc) + imp_q
            if served <= 0:
                continue
            # money: what buyers in this region pay in total
            dom_val = 0.0
            for i, c in enumerate(cands):
                q = alloc[i]
                if q <= 0:
                    continue
                s, tc, _ = c
                f = s[0]
                rem[id(s)] -= q
                rev = q * f.price
                f.cash += rev
                ctx.fs[f.id]["sold"] += q
                ctx.fs[f.id]["revenue"] += rev
                self.ledger("market:%s" % gid, self.faccount(f), "sales", rev)
                if psub > 0:
                    sub = rev * psub
                    f.cash += sub
                    ctx.fs[f.id]["subsidy"] += sub
                    w.gov["cash"] -= sub
                    ctx.gov_spend["producer subsidies"] += sub
                    self.ledger("gov", self.faccount(f), "subsidy", sub)
                ctx.freight_fee[r] += q * tc
                if tc > 0:
                    self.ledger("market:%s" % gid, "market:freight", "transport", q * tc)
                dom_val += q * (f.price + tc)
                if not g["svc"]:
                    f.inv -= q
                fl["dom_sold"] += q
                fl["dom_value"] += rev
            imp_val = 0.0
            if imp_q > 0:
                base = imp_p / (1 + tariff)
                imp_val = imp_q * imp_p
                tariff_rev = imp_q * base * tariff
                world_part = imp_q * (cat.world_price(gid, w.year) or 0) * w.fx * (1.0 + 0.0)
                sea = imp_q * physical.SEA_FREIGHT_PER_T * g["kg"] / 1000.0 * w.fx
                inland = max(0.0, imp_q * base - world_part - sea)
                w.gov["cash"] += tariff_rev
                ctx.gov_rev["tariffs"] += tariff_rev
                ctx.freight_fee[r] += inland
                ctx.sea_fee += sea
                fl["imports"] += imp_q
                fl["import_value"] += world_part
                ctx.stats["imports"] = ctx.stats.get("imports", 0.0) + world_part
                self.ledger("market:%s" % gid, "row", "imports", world_part)
                self.ledger("market:%s" % gid, "gov", "tariffs", tariff_rev)
                self.ledger("market:%s" % gid, "market:freight", "transport", sea + inland)
            total_val = dom_val + imp_val
            paid_total += total_val
            qty_total += served
            # buyers pay proportionally
            frac = served / D
            unit = total_val / served
            for kind, key, _, q in bl:
                got = q * frac
                cost = got * unit
                if kind == "hh":
                    tax = cost * vat
                    sub = cost * csub
                    pay = cost + tax - sub
                    ctx.hh_spent[key] += pay
                    w.gov["cash"] += tax - sub
                    ctx.gov_rev["VAT"] += tax
                    if sub:
                        ctx.gov_spend["consumer subsidies"] += sub
                    self.ledger("hh:%d" % key[0], "market:%s" % gid, "consumption", cost - sub)
                    if tax:
                        self.ledger("hh:%d" % key[0], "gov", "VAT", tax)
                    if sub:
                        self.ledger("gov", "hh:%d" % key[0], "consumer subsidy", sub)
                    fl["hh_qty"] += got
                    fl["hh_value"] += cost + tax - sub
                elif kind == "gov":
                    w.gov["cash"] -= cost
                    ctx.gov_spend[gid] += cost
                    ctx.gov_bought[gid][key] += got
                    self.ledger("gov", "market:%s" % gid, "government purchase", cost)
                    fl["gov_qty"] += got
                    fl["gov_value"] += cost
                else:
                    f = w.firms.get(key)
                    if f is None:
                        continue
                    hs = 0.0
                    if gid == "dwelling" and pol["housing_subsidy"] > 0:
                        hs = cost * pol["housing_subsidy"]
                        w.gov["cash"] -= hs
                        ctx.gov_spend["housing subsidy"] += hs
                        self.ledger("gov", self.faccount(f), "housing subsidy", hs)
                    f.cash -= cost - hs
                    self.ledger(self.faccount(f), "market:%s" % gid,
                                "investment" if kind == "inv" else "inputs", cost)
                    ctx.fs[f.id]["inputs_bought" if kind == "firm" else "capex"] = \
                        ctx.fs[f.id].get("inputs_bought" if kind == "firm" else "capex", 0.0) + cost
                    if kind == "firm":
                        f.inv_in[gid] = f.inv_in.get(gid, 0.0) + got
                        fl["firm_qty"] += got
                        fl["firm_value"] += cost
                    else:
                        old = f.equip.get(gid, 0.0)
                        prec_new = cat.goods[gid]["prec"] or 1000
                        f.equip[gid] = old + got
                        op = f.eq_prec.get(gid, prec_new)
                        f.eq_prec[gid] = (op * old + prec_new * got) / max(old + got, 1e-12)
                        f.orders[gid] = max(0.0, f.orders.get(gid, 0.0) - got)
                        fl["inv_qty"] += got
                        fl["inv_value"] += cost
                        if gid in cat.endowments:
                            pass
        # exports: the rest of the world (WORLD_SCALE times our size, with a
        # similar demand mix) buys from domestic producers in proportion to
        # how competitive they are against the world price.
        wp = cat.world_price(gid, w.year)
        frontier_premium = False
        if wp is None and gid in w.produced_ever:
            wp = g["price"] * 2.5
            frontier_premium = True
        absorb = w.stats.setdefault("absorb", {})
        absorb[gid] = 0.9 * absorb.get(gid, qty_total) + 0.1 * qty_total
        if wp and not g["nt"] and not (g["svc"] and g["local"]) and sellers:
            comps = []
            for s in sellers:
                f = s[0]
                port = physical.nearest_port(w, f.region)
                tc = physical.transport_cost(w, cat, gid, f.region, port)
                sea = physical.SEA_FREIGHT_PER_T * g["kg"] / 1000.0 * w.fx
                comp = wp * w.fx * f.quality / max(f.price + tc + sea, 1e-12)
                comps.append((s, comp, tc))
            world_mkt = WORLD_SCALE * w.stats.get("export_mult", 1.0) * max(absorb[gid], 0.0)
            if frontier_premium:
                world_mkt *= 0.3
            weights = [physical.export_share(c) for _, c, _ in comps]
            for (s, comp, tc), share in zip(comps, weights):
                f = s[0]
                fs = ctx.fs[f.id]
                tot_cap = sum(x[0][1] for x in comps) or 1.0
                appetite = world_mkt * share * s[1] / tot_cap
                if g["svc"]:
                    appetite *= 0.5
                if appetite <= 1e-12:
                    continue
                fs["wanted"] += appetite
                q = min(rem[id(s)], appetite)
                if q <= 1e-12:
                    continue
                rev = q * f.price
                f.cash += rev
                rem[id(s)] -= q
                if not g["svc"]:
                    f.inv -= q
                fs["sold"] += q
                fs["exported"] += q
                fs["revenue"] += rev
                fs["export_rev"] += rev
                ctx.freight_fee[f.region] += q * tc
                if psub > 0:
                    sub = rev * psub
                    f.cash += sub
                    w.gov["cash"] -= sub
                    ctx.gov_spend["producer subsidies"] += sub
                    self.ledger("gov", self.faccount(f), "subsidy", sub)
                self.ledger("row", self.faccount(f), "exports", rev)
                fl["exports"] += q
                fl["export_value"] += rev
                ctx.stats["exports"] = ctx.stats.get("exports", 0.0) + rev
                if frontier_premium and w.rng.random() < 0.05:
                    w.event("trade", f"{f.name} is exporting {g['name']} - something the rest of the world "
                                     f"cannot yet make.", firm=f.id, good=gid)
        # reference price: what buyers paid on average (net of tax)
        if qty_total > 0:
            w.prices[gid] = 0.7 * w.prices.get(gid, paid_total / qty_total) + 0.3 * paid_total / qty_total
        elif sellers:
            w.prices[gid] = 0.8 * w.prices.get(gid, sellers[0][0].price) + 0.2 * min(s[0].price for s in sellers)
        else:
            ip = physical.import_price(w, cat, gid, 0) if imp_ok else None
            if ip:
                w.prices[gid] = 0.8 * w.prices.get(gid, ip) + 0.2 * ip * (1 + tariff)
        w.imports_12m[gid] = w.imports_12m.get(gid, 0.0) * (11.0 / 12.0) + fl.get("imports", 0.0)

    def _clear_freight(self, ctx, sellers_by_good):
        """Transport fees collected in each region go to domestic carriers up to
        their capacity; the rest is informal own-account haulage (households)."""
        w, cat = self.w, self.cat
        for r, fee in ctx.freight_fee.items():
            if fee <= 0:
                continue
            carriers = [s for gid in FREIGHT_GOODS for s in sellers_by_good.get(gid, []) if s[0].region == r]
            cap_val = sum(s[1] * s[0].price for s in carriers)
            served_val = min(fee, cap_val)
            for s in carriers:
                f = s[0]
                share = s[1] * f.price / cap_val if cap_val > 0 else 0
                v = served_val * share
                q = v / max(f.price, 1e-9)
                f.cash += v
                ctx.fs[f.id]["sold"] += q
                ctx.fs[f.id]["revenue"] += v
                ctx.fs[f.id]["wanted"] += fee * share / max(f.price, 1e-9)
                ctx.flows[f.good]["dom_sold"] += q
                ctx.flows[f.good]["dom_value"] += v
                self.ledger("market:freight", self.faccount(f), "freight", v)
            rest = fee - served_val
            if rest > 0:
                self._informal[r] += rest
                ctx.flows["freight_trucking"]["shortage"] += rest / max(w.prices.get("freight_trucking", 110), 1)
        # sea freight: domestic shipping lines first, foreign carriers for the rest
        ships = sellers_by_good.get("freight_shipping", [])
        cap_val = sum(s[1] * s[0].price for s in ships)
        served = min(ctx.sea_fee, cap_val)
        for s in ships:
            f = s[0]
            v = served * s[1] * f.price / cap_val if cap_val > 0 else 0
            f.cash += v
            self.ledger("market:freight", self.faccount(f), "freight", v)
            ctx.fs[f.id]["sold"] += v / max(f.price, 1e-9)
            ctx.fs[f.id]["revenue"] += v
        ctx.stats["sea_freight_foreign"] = ctx.sea_fee - served
        for s_ in ships:
            pass
        if ctx.sea_fee - served > 0:
            self.ledger("market:freight", "row", "sea freight", ctx.sea_fee - served)
        ctx.stats["imports"] = ctx.stats.get("imports", 0.0) + ctx.sea_fee - served

    # ------------------------------------------------------------ production
    def _production(self, ctx):
        w, cat = self.w, self.cat
        pol = w.policy
        S = w.scale
        ctax = pol["carbon_tax"]
        cpi = w.price_index
        for f in list(w.firms.values()):
            fs = ctx.fs[f.id]
            p = cat.procs[f.proc]
            g = cat.goods[f.good]
            net = 0.0
            gross = 0.0
            used_val = 0.0
            if f.design >= 1 and fs.get("y", 0) > 0:
                y = fs["y"]
                gf = physical.gen_factor(w, cat, f)
                if g["svc"]:
                    gross = fs["sold"] / y
                    if f.good in FREIGHT_GOODS or f.good == "freight_shipping":
                        gross = min(gross, fs.get("pot_gross", gross))
                else:
                    gross = fs.get("prod_gross", 0.0)
                # input limit
                limit = gross
                for alts, q in p["inputs"]:
                    if alts[0] in p.get("optional", ()):
                        continue
                    have = sum(f.inv_in.get(a, 0.0) for a in alts)
                    need = q * gf
                    if need > 0:
                        limit = min(limit, have / need)
                if not g["svc"]:
                    if limit < gross * 0.999:
                        short = [cat.goods[alts[0]]["name"] for alts, q in p["inputs"]
                                 if alts[0] not in p.get("optional", ())
                                 and sum(f.inv_in.get(a, 0) for a in alts) < q * gf * gross * 0.999]
                        if short and gross > 0:
                            f.blocked = "short of " + ", ".join(short[:2])
                    gross = max(0.0, limit)
                net = gross * y
                for alts, q in p["inputs"]:
                    need = gross * q * gf
                    for a in sorted(alts, key=lambda x: w.prices.get(x, 1e18)):
                        if need <= 0:
                            break
                        have = f.inv_in.get(a, 0.0)
                        take = min(have, need)
                        if take > 0:
                            f.inv_in[a] = have - take
                            need -= take
                            used_val += take * w.prices.get(a, 0)
                if not g["svc"]:
                    f.inv += net
                f.cum_output += net
                # depletion
                if p["dep"]:
                    d = w.regions[f.region].deposits.get(p["dep"])
                    if d and d["kind"] in ("stock", "renew"):
                        d["qty"] = max(0.0, d["qty"] - gross)
                        if d["qty"] <= 0 and d["kind"] == "stock":
                            w.event("resource", f"The {p['dep']} deposit in {w.regions[f.region].name} is exhausted.",
                                    region=f.region)
                if f.good not in w.produced_ever and net > 0:
                    w.produced_ever.add(f.good)
                val = net * f.price
                for k in p["know"]:
                    ctx.practiced[k] += val
                em = p["co2"] * gross
                ctx.emissions += em
                if ctax > 0 and em > 0:
                    t = em * ctax * cpi
                    f.cash -= t
                    w.gov["cash"] += t
                    ctx.gov_rev["carbon tax"] += t
                    self.ledger(self.faccount(f), "gov", "carbon tax", t)
                if f.good == "electricity":
                    ctx.elec_mix[f.proc] += net
            # non-storable inputs do not keep
            for a in list(f.inv_in):
                if cat.goods[a]["svc"]:
                    del f.inv_in[a]
            # land rent to rural landowners
            eq = p["equip"][0] if p["equip"] else None
            land_rent = 0.0
            if eq in cat.endowments:
                r = w.regions[f.region]
                scarcity = 0.5 + r.land_used.get(eq, 0) / max(r.land.get(eq, 1), 1)
                land_rent = f.equip.get(eq, 0) * cat.endowments[eq]["rent"] * cpi * w.stats.get("wage_level", 1) ** 0.5 * scarcity
                f.cash -= land_rent
                self._informal[f.region] += land_rent
                self.ledger(self.faccount(f), "hh:%d" % f.region, "land rent", land_rent)
            # depreciation
            dep_val = 0.0
            dep_units = {}
            for e, n in list(f.equip.items()):
                if e in cat.endowments:
                    continue
                life = cat.goods[e]["life"] or 120
                d = n / life
                f.equip[e] = n - d
                dep_units[e] = d
                dep_val += d * w.prices.get(e, cat.goods[e]["price"])
            fs.update(net=net, gross_done=gross, used_val=used_val, land_rent=land_rent, dep_val=dep_val,
                      dep_units=dep_units)
            f.last["output"] = net
        # renewable stocks regrow
        for r in w.regions:
            for d in r.deposits.values():
                if d["kind"] == "renew" and d["qty0"] > 0:
                    d["qty"] = min(d["qty0"], d["qty"] + d["regen"] * d["qty"] * (1 - d["qty"] / d["qty0"]) + d["qty0"] * 0.0005)

    # --------------------------------------------------------------- incomes
    def income_tax(self, monthly):
        br = self.w.policy["income_tax"]
        med = max(self.w.stats.get("median_wage", 1000.0), 1.0)
        edges = [0.0, 0.5 * med, 1.5 * med, 4.0 * med, float("inf")]
        tax = 0.0
        for i in range(4):
            lo, hi = edges[i], edges[i + 1]
            if monthly > lo:
                tax += (min(monthly, hi) - lo) * br[i]
        return tax

    def _incomes(self, ctx):
        w, cat = self.w, self.cat
        pol = w.policy
        S = w.scale
        st = w.stats
        avg_wage = st.get("avg_wage", 1000.0)
        med = st.get("median_wage", avg_wage)
        ret = pol["retirement_age"] * 12
        lend = st["lend_rate"] / 12.0
        dep = st["dep_rate"] / 12.0
        income = defaultdict(float)
        wages_by_firm = defaultdict(float)
        kids = defaultdict(int)
        for p in w.persons.values():
            if p.age < 18 * 12 and p.guardian:
                kids[p.guardian] += 1
        tax_total = 0.0
        ben_total = pen_total = child_total = 0.0
        int_hh = 0.0
        hh_wage_r = defaultdict(float)
        hh_tax_r = defaultdict(float)
        hh_ben_r = defaultdict(float)
        for p in w.persons.values():
            gross = 0.0
            for fid, (fte, wage) in p.jobs.items():
                pay = fte * wage
                gross += pay
                wages_by_firm[fid] += pay * S
            tax = self.income_tax(gross) if gross > 0 else 0.0
            net = gross - tax
            fte = p.fte
            ben = 0.0
            if p.age >= ret:
                ben += pol["pension_rate"] * avg_wage
                pen_total += pol["pension_rate"] * avg_wage
            elif p.occ and not p.school and p.age >= 18 * 12 and fte < 0.95 and not p.inactive:
                if fte < 0.5:
                    p.unemp += 1
                base = max(p.prev_wage, 0.5 * med)
                rate = pol["unemployment_benefit"] * (1.0 if p.unemp <= 12 else 0.5)
                b = rate * base * (1 - fte)
                ben += b
                ben_total += b
            if fte >= 0.5:
                p.unemp = 0
            nk = kids.get(p.id, 0)
            if nk:
                cb = nk * pol["child_benefit"] * avg_wage
                ben += cb
                child_total += cb
            interest = max(p.savings, 0) * dep
            int_hh += interest
            p.savings += net + ben + interest
            p.income_last = net + ben + interest
            if gross > 0:
                p.prev_wage = max(p.prev_wage * 0.98, gross / max(fte, 0.05))
            tax_total += tax
            hh_wage_r[p.region] += gross * S
            hh_tax_r[p.region] += tax * S
            hh_ben_r[p.region] += ben * S
        # firms pay wages
        for fid, amt in wages_by_firm.items():
            f = w.firms[fid]
            f.cash -= amt
            ctx.fs[fid]["wages"] = amt
            ctx.region_va[f.region] += amt
            self.ledger(self.faccount(f), "hh:%d" % f.region, "wages", amt)
        w.gov["cash"] += tax_total * S
        ctx.gov_rev["income tax"] += tax_total * S
        for r, t in hh_tax_r.items():
            self.ledger("hh:%d" % r, "gov", "income tax", t)
        for r, b in hh_ben_r.items():
            self.ledger("gov", "hh:%d" % r, "transfers", b)
        trans = (ben_total + pen_total + child_total) * S
        w.gov["cash"] -= trans
        ctx.gov_spend["unemployment benefits"] += ben_total * S
        ctx.gov_spend["pensions"] += pen_total * S
        ctx.gov_spend["child benefits"] += child_total * S
        w.bank["equity"] -= int_hh * S
        self.ledger("bank", "hh", "deposit interest", int_hh * S)
        ctx.stats["wage_bill"] = sum(wages_by_firm.values())
        # informal incomes (own-account haulage, land rents) -> households in region
        for r, amt in self._informal.items():
            people = [p for p in w.persons.values() if p.region == r and p.age >= 18 * 12]
            if not people or amt <= 0:
                continue
            per = amt / S / len(people)
            for p in people:
                p.savings += per
                p.income_last += per
            self.ledger("market:freight", "hh:%d" % r, "own-account & rents", amt)
        # interest on firm debt & government debt
        bank_int = 0.0
        for f in w.firms.values():
            if f.debt > 0:
                i = f.debt * lend
                f.cash -= i
                bank_int += i
                ctx.fs[f.id]["interest"] = i
                self.ledger(self.faccount(f), "bank", "interest", i)
        gi = w.gov["debt"] * (w.policy_rate + 0.005) / 12.0
        w.gov["cash"] -= gi
        ctx.gov_spend["interest on debt"] += gi
        self.ledger("gov", "bank", "interest", gi)
        w.bank["equity"] += bank_int + gi
        # property tax on dwellings
        ptax = pol["property_tax"] / 12.0
        for f in w.firms.values():
            if f.good == "housing":
                t = f.equip.get("dwelling", 0) * w.prices.get("dwelling", 2e5) * ptax
                f.cash -= t
                w.gov["cash"] += t
                ctx.gov_rev["property tax"] += t
                self.ledger(self.faccount(f), "gov", "property tax", t)
        # ---- profits, corporate tax, dividends
        wealthy = sorted((p for p in w.persons.values() if p.age >= 18 * 12), key=lambda p: -p.savings)
        top = wealthy[: max(1, len(wealthy) // 4)]
        topw = sum(max(p.savings, 1.0) ** 0.5 for p in top)
        div_pool = 0.0
        div_region = defaultdict(float)
        ctax = pol["corporate_tax"]
        for f in w.firms.values():
            fs = ctx.fs[f.id]
            rev = fs.get("revenue", 0.0) + fs.get("subsidy", 0.0) + fs.get("freight_rev", 0.0)
            costs = fs.get("wages", 0.0) + fs.get("used_val", 0.0) + fs.get("interest", 0.0) + \
                fs.get("dep_val", 0.0) + fs.get("land_rent", 0.0)
            # unsold production adds to inventory (valued at cost) - not a loss
            profit = rev - costs + (fs.get("net", 0) - fs.get("sold", 0)) * f.cost_ema * (0 if cat.goods[f.good]["svc"] else 1)
            fs["profit"] = profit
            f.profit_ema = 0.85 * f.profit_ema + 0.15 * profit
            tax = 0.0
            if profit > 0 and f.owner != "state":
                tax = profit * ctax
                f.cash -= tax
                w.gov["cash"] += tax
                ctx.gov_rev["corporate tax"] += tax
                self.ledger(self.faccount(f), "gov", "corporate tax", tax)
            fs["tax"] = tax
            monthly_costs = max(costs, 1.0)
            if f.cash > 3 * monthly_costs and f.profit_ema > 0:
                div = 0.8 * max(0.0, profit - tax) + 0.1 * (f.cash - 3 * monthly_costs)
                div = min(div, f.cash - 2 * monthly_costs)
                if div > 0:
                    f.cash -= div
                    if f.owner == "state":
                        w.gov["cash"] += div
                        ctx.gov_rev["state firm profits"] += div
                        self.ledger(self.faccount(f), "gov", "dividends", div)
                    elif f.owner == "foreign":
                        ctx.stats["foreign_dividends"] = ctx.stats.get("foreign_dividends", 0) + div
                        self.ledger(self.faccount(f), "row", "dividends", div)
                    else:
                        div_pool += div
                        self.ledger(self.faccount(f), "hh:%d" % f.region, "dividends", div)
            # loan repayment from surplus cash (amortization, not a fire sale)
            if f.debt > 0 and f.cash > 3 * monthly_costs:
                rep = min(f.debt, 0.05 * (f.cash - 3 * monthly_costs), f.debt / 120.0 + 0.0)
                f.cash -= rep
                f.debt -= rep
                w.bank["loans"] -= rep
                self.ledger(self.faccount(f), "bank", "loan repayment", rep)
        # bank pays dividends when well capitalized
        req = pol["bank_capital_ratio"] * (w.bank["loans"] + 0.2 * w.bank["bonds"])
        if w.bank["equity"] > req * 1.5:
            bd = 0.1 * (w.bank["equity"] - req * 1.5)
            w.bank["equity"] -= bd
            div_pool += bd
            self.ledger("bank", "hh", "dividends", bd)
        if div_pool > 0 and topw > 0:
            # 60% to direct shareholders (the wealthy), 40% via pension funds
            # and savings plans to all working-age and retired adults
            for p in top:
                d = 0.5 * div_pool * max(p.savings, 1.0) ** 0.5 / topw / S
                p.savings += d
                p.income_last += d
            adults = [p for p in w.persons.values() if p.age >= 25 * 12]
            if adults:
                per = 0.5 * div_pool / S / len(adults)
                for p in adults:
                    p.savings += per
                    p.income_last += per
        ctx.stats["dividends"] = div_pool
        # government financing
        g = w.gov
        gdp = st.get("gdp_trailing", st.get("gdp_month", 1e8))
        if g["cash"] < 0.05 * gdp:
            issue = 0.05 * gdp - g["cash"]
            g["cash"] += issue
            g["debt"] += issue
            w.bank["bonds"] += issue
            self.ledger("bank", "gov", "bond issuance", issue)
        elif g["cash"] > 0.4 * gdp and g["debt"] > 0:
            rep = min(g["debt"], g["cash"] - 0.3 * gdp)
            g["cash"] -= rep
            g["debt"] -= rep
            w.bank["bonds"] = max(0.0, w.bank["bonds"] - rep)
            self.ledger("gov", "bank", "debt repayment", rep)

    # -------------------------------------------------------- firm finance
    def bank_can_lend(self, amount):
        w = self.w
        cap = w.bank["equity"] / max(w.policy["bank_capital_ratio"], 0.01)
        return w.bank["loans"] + 0.2 * w.bank["bonds"] + amount <= cap

    def lend(self, f, amount, kind="loan"):
        w = self.w
        f.debt += amount
        f.cash += amount
        w.bank["loans"] += amount
        self.ledger("bank", self.faccount(f), kind, amount)

    def capital_value(self, f):
        cat = self.cat
        return sum(n * self.w.prices.get(e, cat.goods[e]["price"]) for e, n in f.equip.items()
                   if e not in cat.endowments)

    def _firm_finance(self, ctx):
        w, cat = self.w, self.cat
        rng = w.rng
        pol = w.policy
        dead = []
        for f in list(w.firms.values()):
            fs = ctx.fs[f.id]
            g = cat.goods[f.good]
            p = cat.procs[f.proc]
            net = fs.get("net", 0.0)
            sold = fs.get("sold", 0.0)
            costs = fs.get("wages", 0.0) + fs.get("used_val", 0.0) + fs.get("dep_val", 0.0) + \
                fs.get("interest", 0.0) + fs.get("land_rent", 0.0)
            f.last = {"output": net, "sold": sold, "revenue": fs.get("revenue", 0.0),
                      "exports": fs.get("export_rev", 0.0), "wages": fs.get("wages", 0.0),
                      "inputs": fs.get("inputs_bought", 0.0), "profit": fs.get("profit", 0.0),
                      "subsidy": fs.get("subsidy", 0.0), "capex": fs.get("capex", 0.0),
                      "util": net / max(fs.get("cap", 0) * fs.get("y", 0), 1e-12) if fs.get("cap") else 0.0,
                      "staff": sum(f.staff.values()) * w.scale, "costs": costs,
                      "va": fs.get("revenue", 0.0) + fs.get("subsidy", 0.0) - fs.get("used_val", 0.0)}
            if f.design < 1.0:
                # R&D-stage firm: burns cash on salaries
                knowledge_engine.firm_rd(self, ctx, f)
                if f.design >= 1.0:
                    self._initial_equipment(f)
                self._solvency(ctx, f, costs, dead)
                continue
            ctx.sector_va[SECTOR_OF_CAT.get(g["cat"], "Other")] += f.last["va"]
            # expectations
            f.sales_ema = 0.7 * f.sales_ema + 0.3 * sold
            f.demand_ema = 0.75 * f.demand_ema + 0.25 * max(fs.get("wanted", 0.0), sold)
            f.export_ema = 0.8 * f.export_ema + 0.2 * fs.get("exported", 0.0)
            netcap = fs.get("cap", 0) * fs.get("y", 0)
            util = net / netcap if netcap > 0 else 0.0
            f.util_ema = 0.8 * f.util_ema + 0.2 * util
            if net > 1e-9:
                # variable costs per unit + overheads spread over normal output
                # (firms do not raise prices just because a slump idles plant)
                # financing costs hit profits, not prices (no cost-channel spiral)
                fixed = costs - fs.get("used_val", 0.0) - fs.get("interest", 0.0)
                normal = max(net, 0.8 * netcap if netcap > 0 else net)
                unit = fs.get("used_val", 0.0) / net + fixed / normal
                f.cost_ema = unit if f.cost_ema <= 0 else 0.8 * f.cost_ema + 0.2 * unit
            # pricing: markup responds to stock / utilization
            if g["svc"]:
                offer = fs.get("offer", 0.0)
                u = sold / offer if offer > 0 else 1.0
                if u > 0.95:
                    f.markup += 0.01
                elif u < 0.6:
                    f.markup -= 0.01
            else:
                ratio = f.inv / max(f.sales_ema, 1e-9)
                if ratio < 0.6:
                    f.markup += 0.01
                elif ratio > 1.6:
                    f.markup -= 0.015
            # markups drift back toward a normal margin
            f.markup += 0.01 * (0.15 - f.markup)
            f.markup = max(-0.1, min(0.8, f.markup))
            if f.cost_ema > 0:
                target = f.cost_ema * (1 + f.markup)
                f.price = 0.85 * f.price + 0.15 * target
            # chronic overcapacity: sell idle machines for scrap and repay debt
            if f.util_ema < 0.45 and netcap > 0 and f.good != "housing" and g["cat"] != "public":
                self._downsize(ctx, f, p)
            # investment: maintenance every month, expansion occasionally
            self._maintain(ctx, f, p, fs)
            if rng.random() < 0.25:
                self._invest(ctx, f, p, g, netcap)
            # R&D
            knowledge_engine.firm_rd(self, ctx, f)
            # process upgrades (e.g. hand tools -> machines when wages rise)
            if (w.tick + f.id) % 12 == 0:
                self._consider_switch(ctx, f)
            self._solvency(ctx, f, costs, dead)
        for f in dead:
            self._bankrupt(ctx, f)
        self._entry(ctx)

    def _solvency(self, ctx, f, costs, dead):
        w = self.w
        if f.cash >= 0:
            f.distress = max(0, f.distress - 1)
            return
        need = -f.cash + costs
        if f.owner == "state" or self.cat.goods[f.good]["cat"] == "public":
            w.gov["cash"] -= need
            f.cash += need
            ctx.gov_spend["state firm support"] += need
            self.ledger("gov", self.faccount(f), "state support", need)
            return
        if f.owner == "foreign":
            f.cash += need
            self.ledger("row", self.faccount(f), "parent capital", need)
            ctx.stats["fdi"] = ctx.stats.get("fdi", 0) + need
            f.distress += 1
            if f.distress > 18:
                dead.append(f)
            return
        if f.good in ("housing", "electricity", "fresh_water", "retail_trade") and f.distress >= 6:
            # landlords/utilities are restructured, not liquidated: the bank
            # writes down debt and the assets keep operating
            cut = max(0.0, f.debt - 0.4 * self.capital_value(f))
            if cut > 0:
                f.debt -= cut
                w.bank["equity"] -= cut
                w.bank["loans"] -= cut
                self.ledger("bank", self.faccount(f), "debt restructuring", cut)
            f.distress = 0
        limit = 0.8 * self.capital_value(f) + 4 * max(f.last.get("revenue", 0.0), 0) + 3 * costs
        if f.debt + need <= limit and self.bank_can_lend(need):
            self.lend(f, need, "working capital loan")
            f.distress += 1 if f.profit_ema < 0 else 0
        else:
            f.distress += 2
        if f.distress >= 8:
            dead.append(f)

    def _bankrupt(self, ctx, f):
        w = self.w
        g = self.cat.goods[f.good]
        for pid in list(f.staff):
            p = w.persons.get(pid)
            if p and f.id in p.jobs:
                p.prev_wage = max(p.prev_wage, p.jobs[f.id][1])
                del p.jobs[f.id]
        f.staff = {}
        loss = max(0.0, f.debt - max(f.cash, 0) - 0.3 * self.capital_value(f))
        w.bank["equity"] -= loss
        w.bank["loans"] -= f.debt
        self.ledger("bank", self.faccount(f), "loan write-off", loss)
        r = w.regions[f.region]
        eq = self.cat.procs[f.proc]["equip"]
        if eq and eq[0] in self.cat.endowments:
            r.land_used[eq[0]] = max(0.0, r.land_used.get(eq[0], 0) - f.equip.get(eq[0], 0))
        f.alive = False
        del w.firms[f.id]
        ctx.stats["bankruptcies"] = ctx.stats.get("bankruptcies", 0) + 1
        w.event("bankruptcy", f"{f.name} ({g['name']}, {r.name}) went bankrupt.", good=f.good, firm=f.id)

    def _invest(self, ctx, f, p, g, netcap):
        w, cat = self.w, self.cat
        if f.good == "housing":
            return self._invest_housing(ctx, f)
        if not p["equip"]:
            return
        # target capacity follows expected demand (expansion); maintenance
        # replacement of worn-out machines happens separately every month
        eq = max(p["equip"], key=lambda a: f.equip.get(a, 0))
        if f.equip.get(eq, 0) <= 0 or netcap <= 0:
            return
        desired = f.demand_ema * 1.15
        if f.profit_ema < 0:
            return
        # expansion must beat the cost of borrowing (monetary policy channel)
        kv = self.capital_value(f)
        if kv > 0 and f.profit_ema * 12 / kv < w.stats.get("lend_rate", 0.06) * 0.8:
            return
        gap = desired - netcap - f.orders.get(eq, 0.0) * netcap / f.equip[eq]
        if gap <= 0.03 * netcap:
            return
        frac = min(0.1, gap / netcap)
        add = {eq: f.equip[eq] * frac}
        for name, (alts, ratio) in p["aux"].items():
            a = max(alts, key=lambda x: f.equip.get(x, 0))
            if name in p.get("optional", ()) and cat.goods[a]["year"] > w.year:
                continue
            add[a] = add[eq] * ratio
        if eq in cat.endowments:
            r = w.regions[f.region]
            free = r.land.get(eq, 0) - r.land_used.get(eq, 0)
            if free <= 0:
                f.blocked = "no free land to expand"
                add.pop(eq)
            else:
                take = min(free, add[eq])
                f.equip[eq] += take
                r.land_used[eq] = r.land_used.get(eq, 0) + take
                add.pop(eq)
        if p["dep"]:
            d = w.regions[f.region].deposits.get(p["dep"])
            if d and d["kind"] == "flow" and p["dep"] == "hydro":
                used = f.equip.get(eq, 0)
                if used >= d["qty"]:
                    return
        cost = sum(q * w.prices.get(a, cat.goods[a]["price"]) for a, q in add.items())
        if cost <= 0:
            return
        if f.cash < cost + 2 * max(f.last.get("costs", 0), 0):
            need = cost + 2 * max(f.last.get("costs", 0), 0) - f.cash
            limit = 0.7 * (self.capital_value(f) + cost) + 12 * max(f.profit_ema, 0)
            if f.debt + need > limit or not self.bank_can_lend(need):
                return
            self.lend(f, need, "investment loan")
        for a, q in add.items():
            f.orders[a] = f.orders.get(a, 0.0) + q
        ctx.stats["orders_expand"] = ctx.stats.get("orders_expand", 0) + cost

    def _downsize(self, ctx, f, p):
        w, cat = self.w, self.cat
        cut = 0.04
        proceeds = 0.0
        for e, n in list(f.equip.items()):
            if e in cat.endowments:
                r = w.regions[f.region]
                d = n * cut
                f.equip[e] = n - d
                r.land_used[e] = max(0.0, r.land_used.get(e, 0) - d)
                continue
            d = n * cut
            f.equip[e] = n - d
            proceeds += d * w.prices.get(e, cat.goods[e]["price"]) * 0.3
        if proceeds > 0:
            # scrap buyers pay out of the domestic economy (counted as a transfer from households)
            f.cash += proceeds
            self._informal[f.region] -= proceeds
            self.ledger("hh:%d" % f.region, self.faccount(f), "asset sales", proceeds)
            rep = min(f.debt, proceeds)
            f.debt -= rep
            f.cash -= rep
            w.bank["loans"] -= rep
            self.ledger(self.faccount(f), "bank", "loan repayment", rep)

    def _maintain(self, ctx, f, p, fs):
        """Replace machines that wore out this month if the plant is in use."""
        w, cat = self.w, self.cat
        if f.util_ema < 0.4 or f.good == "housing":
            return
        if f.profit_ema < -0.15 * max(f.last.get("revenue", 0.0), 1.0):
            return
        dep = fs.get("dep_units", {})
        cost = 0.0
        for a, d in dep.items():
            if d > 0 and f.orders.get(a, 0.0) < 3 * d:
                f.orders[a] = f.orders.get(a, 0.0) + d
                cost += d * w.prices.get(a, cat.goods[a]["price"])
        ctx.stats["orders_maint"] = ctx.stats.get("orders_maint", 0) + cost
        if cost > f.cash and cost > 0:
            need = cost - max(f.cash, 0)
            if self.bank_can_lend(need) and f.debt + need < 0.8 * self.capital_value(f) + 6 * max(f.last.get("revenue", 0), 0):
                self.lend(f, need, "investment loan")

    def _invest_housing(self, ctx, f):
        w, cat = self.w, self.cat
        r = w.regions[f.region]
        stock = f.equip.get("dwelling", 0.0)
        occ = f.demand_ema / max(stock, 1)
        cap = self.max_dwellings(r)
        room = cap - stock - f.orders.get("dwelling", 0)
        cost_rent = w.prices.get("dwelling", 2.2e5) * (1 - w.policy["housing_subsidy"]) * \
            (w.stats["lend_rate"] / 12 + 1 / 900.0) * 1.1
        if occ > 0.97 and f.price > cost_rent and room > 0:
            q = min(room, stock * 0.006 * min(3.0, occ / 0.97 * f.price / cost_rent))
            cost = q * w.prices.get("dwelling", 2.2e5)
            if f.cash < cost:
                need = cost - f.cash
                if self.bank_can_lend(need):
                    self.lend(f, need, "mortgage/construction loan")
                else:
                    return
            f.orders["dwelling"] = f.orders.get("dwelling", 0.0) + q
        elif room <= 0 and occ > 1.0:
            f.blocked = "zoning cap reached"

    def _initial_equipment(self, f):
        """A firm that just finished its design orders production equipment."""
        w, cat = self.w, self.cat
        p = cat.procs[f.proc]
        target = f.last.get("target_qty", 0) or f.demand_ema or 1.0
        r = w.regions[f.region]
        cpp = physical.capacity_per_primary(w, cat, p, r) or (p["rate"] or 1.0)
        n = target * 1.2 / max(cpp, 1e-12)
        if p["equip"]:
            eq = p["equip"][0]
            for a in p["equip"]:
                if a in w.produced_ever or (cat.goods[a]["year"] <= w.year and not cat.goods[a]["restricted"]):
                    eq = a
                    break
            if eq in cat.endowments:
                free = r.land.get(eq, 0) - r.land_used.get(eq, 0)
                take = max(0.0, min(free, n))
                f.equip[eq] = f.equip.get(eq, 0) + take
                r.land_used[eq] = r.land_used.get(eq, 0) + take
            else:
                f.orders[eq] = f.orders.get(eq, 0) + n
            for name, (alts, ratio) in p["aux"].items():
                a = alts[0]
                for x in alts:
                    if x in w.produced_ever or cat.goods[x]["year"] <= w.year:
                        a = x
                        break
                f.orders[a] = f.orders.get(a, 0) + n * ratio
        f.demand_ema = max(f.demand_ema, target)
        f.price = f.price or w.prices.get(f.good, cat.goods[f.good]["price"])

    def est_unit_cost(self, p, region):
        return physical.est_unit_cost(self.w, self.cat, p, region)

    def process_feasible(self, p, region=None):
        """Can this process be started domestically now? Returns (ok, reason)."""
        w, cat = self.w, self.cat
        for k in p["know"]:
            if w.knowledge.get(k, 0) < 0.5:
                return False, f"science/know-how missing: {cat.knowledge[k]['name']}"
        if p["equip"]:
            ok = False
            for a in p["equip"]:
                ga = cat.goods[a]
                if a in cat.endowments or a in w.produced_ever or \
                        (ga["year"] <= w.year and not ga["restricted"] and not ga["nt"]) or \
                        (ga["local"] and ga["year"] <= w.year):
                    ok = True
            if not ok:
                return False, f"no access to {cat.goods[p['equip'][0]]['name']}"
        regs = physical.regions_for_process(w, cat, p)
        if not regs:
            return False, "no suitable site (deposit, land or climate)"
        if region is not None and region not in regs:
            return False, "site unsuitable"
        return True, None

    def _consider_switch(self, ctx, f):
        w, cat = self.w, self.cat
        g = cat.goods[f.good]
        cur = cat.procs[f.proc]
        if len(g["processes"]) < 2:
            return
        c0 = self.est_unit_cost(cur, f.region)
        if c0 is None:
            c0 = 1e18
        best = None
        for pid in g["processes"]:
            if pid == f.proc:
                continue
            p2 = cat.procs[pid]
            ok, _ = self.process_feasible(p2, f.region)
            if not ok:
                continue
            c = self.est_unit_cost(p2, f.region)
            if c is not None and c < 0.8 * c0 and (best is None or c < best[1]):
                best = (pid, c)
        if best and f.cash > 0:
            old = f.proc
            f.proc = best[0]
            p2 = cat.procs[best[0]]
            target = max(f.sales_ema, f.plan, 1e-9)
            r = w.regions[f.region]
            # release land of the old process if it differs
            old_eq = cat.procs[old]["equip"][0] if cat.procs[old]["equip"] else None
            new_eq = p2["equip"][0] if p2["equip"] else None
            if old_eq in cat.endowments and old_eq != new_eq:
                r.land_used[old_eq] = max(0.0, r.land_used.get(old_eq, 0) - f.equip.get(old_eq, 0))
                f.equip.pop(old_eq, None)
            f.last["target_qty"] = target
            if new_eq not in cat.endowments or new_eq != old_eq:
                self._initial_equipment(f)
            else:
                for name, (alts, ratio) in p2["aux"].items():
                    a = next((x for x in alts if cat.goods[x]["year"] <= w.year), alts[0])
                    f.orders[a] = f.orders.get(a, 0) + f.equip.get(new_eq, 0) * ratio
            w.event("technology", f"{f.name} switched {g['name']} production from "
                                  f"{'traditional methods' if cat.procs[old]['trad'] else old} to "
                                  f"{'traditional methods' if p2['trad'] else 'a modern process'} "
                                  f"(est. unit cost {c0:,.4g} -> {best[1]:,.4g}).", firm=f.id, good=f.good)

    def _entry(self, ctx):
        """Entrepreneurs, foreign investors and the state look for goods that
        are imported or in short supply and could be made here profitably."""
        w, cat = self.w, self.cat
        rng = w.rng
        pol = w.policy
        S = w.scale
        cands = []
        short = w.stats.setdefault("shortage_ema", {})
        for gid, fl in ctx.flows.items():
            short[gid] = 0.9 * short.get(gid, 0.0) + 0.1 * fl.get("shortage", 0.0)
        for gid, g in cat.goods.items():
            if g.get("endowment") or g["cat"] == "public":
                continue
            imp_q = w.imports_12m.get(gid, 0.0) / 12.0
            val = (imp_q + short.get(gid, 0.0)) * w.prices.get(gid, g["price"])
            if val > 20.0 * S:
                cands.append((gid, val))
        for gid in pol.get("industrial_policy", []) or []:
            pass
        ip_goods = set()
        for item in pol.get("industrial_policy", []) or []:
            if item in cat.goods:
                ip_goods.add(item)
            else:
                ip_goods.update(g for g, gg in cat.goods.items() if gg["cat"] == item and not gg.get("endowment"))
        for gid in sorted(ip_goods):
            cands.append((gid, 1e9))
        if not cands:
            return
        picks = []
        tot = sum(v for _, v in cands)
        for _ in range(min(10, len(cands))):
            x = rng.random() * tot
            for gid, v in cands:
                x -= v
                if x <= 0:
                    if gid not in picks:
                        picks.append(gid)
                    break
        created = 0
        for gid in picks:
            if created >= 4:
                break
            g = cat.goods[gid]
            existing = [f for f in w.firms.values() if f.good == gid]
            if any(f.design < 1 for f in existing):
                continue  # someone is already developing it
            if any(f.util_ema < 0.7 and f.design >= 1 for f in existing) and gid not in ip_goods:
                continue
            fl = ctx.flows.get(gid, {})
            gap_qty = w.imports_12m.get(gid, 0.0) / 12.0 + short.get(gid, 0.0)
            best = None
            for pid in g["processes"]:
                p = cat.procs[pid]
                ok, why = self.process_feasible(p)
                if not ok:
                    continue
                regs = physical.regions_for_process(w, cat, p)
                rw = physical.region_weights(w, cat, p, regs)
                rid = max(rw, key=lambda r: rw[r] * rng.uniform(0.7, 1.3))
                c = self.est_unit_cost(p, rid)
                if c is None:
                    continue
                if best is None or c < best[1]:
                    best = (pid, c, rid)
            if best is None:
                continue
            pid, cost, rid = best
            p = cat.procs[pid]
            ip = physical.import_price(w, cat, gid, rid) if self.import_ok(gid) else None
            mkt = ip * (1 + self.tariff(gid)) if ip else w.prices.get(gid, g["price"])
            if short.get(gid, 0) > w.imports_12m.get(gid, 0) / 12.0:
                mkt = max(mkt, w.prices.get(gid, mkt))
            margin = mkt / max(cost, 1e-12) - 1.0
            state = gid in ip_goods
            if margin < 0.06 and not (state and margin > -0.35):
                continue
            # start with a pilot plant (~1/3 of the opportunity); expand once demand is proven
            target = max(gap_qty * rng.uniform(0.07, 0.15), 1e-9)
            simple = p["design_effort"] < 400 and all(w.knowledge.get(k, 0) >= 0.8 for k in p["know"])
            design = 1.0 if (gid in w.produced_ever or simple or p["trad"]) else 0.0
            owner = "private"
            if design < 1.0:
                if self.import_ok(gid) and rng.random() < pol["fdi_openness"] * min(1.0, margin + 0.3) \
                        and w.stats.get("wage_level_vs_world", 1) < 0.9:
                    owner = "foreign"
                    design = 1.0
            if state:
                owner = "state"
            # financing
            r = w.regions[rid]
            cpp = physical.capacity_per_primary(w, cat, p, r) or (p["rate"] or 1)
            n_eq = target * 1.2 / max(cpp, 1e-12)
            eq = p["equip"][0] if p["equip"] else None
            capex = 0.0
            if eq and eq not in cat.endowments:
                capex = n_eq * w.prices.get(eq, cat.goods[eq]["price"]) * (1 + 0.3 * len(p["aux"]))
            if design < 1.0:
                capex = 0.0  # R&D first; equipment after the design works
            bank_room = w.bank["equity"] / max(pol["bank_capital_ratio"], 0.01) - w.bank["loans"] - 0.2 * w.bank["bonds"]
            if capex > 0.05 * max(bank_room, 0) and owner == "private":
                shrink = 0.05 * max(bank_room, 0) / capex
                if shrink < 0.05:
                    continue
                capex *= shrink
                target *= shrink
            seed_cash = pol["business_entry_cost"] + capex + target * cost * 2 + \
                (6 * w.wage_index.get(self.rd_occ_for(p, g), 3000) * S if design < 1 else 0)
            f = w.new_firm(self._name(gid), rid, gid, pid, owner)
            f.price = mkt * 0.97
            f.demand_ema = target if design >= 1 else 0.0
            f.design = design
            f.last = {"target_qty": target}
            f.state_backed = state
            if owner == "foreign":
                f.gen = max(0, physical.world_generation(w, cat, gid) - 1)
                f.cash = seed_cash
                self.ledger("row", self.faccount(f), "FDI", seed_cash)
                ctx.stats["fdi"] = ctx.stats.get("fdi", 0) + seed_cash
            elif owner == "state":
                f.cash = seed_cash
                w.gov["cash"] -= seed_cash
                ctx.gov_spend["industrial policy"] += seed_cash
                self.ledger("gov", self.faccount(f), "state investment", seed_cash)
            else:
                equity = self._raise_equity(seed_cash * 0.35)
                loan = seed_cash - equity
                if not self.bank_can_lend(loan):
                    del w.firms[f.id]
                    continue
                f.cash = equity
                self.ledger("hh", self.faccount(f), "equity", equity)
                self.lend(f, loan, "startup loan")
            f.cash -= pol["business_entry_cost"]
            w.gov["cash"] += pol["business_entry_cost"]
            ctx.gov_rev["fees"] += pol["business_entry_cost"]
            self.ledger(self.faccount(f), "gov", "registration fee", pol["business_entry_cost"])
            if design >= 1.0:
                self._initial_equipment(f)
            created += 1
            how = {"foreign": "Foreign investor", "state": "State-backed", "private": "Entrepreneurs"}[owner]
            extra = "" if design >= 1 else " It must first develop the product (R&D)."
            w.event("entry", f"{how} founded {f.name} in {r.name} to make {g['name']} "
                             f"(import price {mkt:,.4g} vs est. cost {cost:,.4g}).{extra}", firm=f.id, good=gid)
            ctx.stats["entries"] = ctx.stats.get("entries", 0) + 1

    def rd_occ_for(self, p, g):
        for k in p["know"]:
            node = self.cat.knowledge[k]
            if node["kind"] != "sci":
                from .catalog.knowledge import FIELDS
                if FIELDS.get(node["field"]):
                    return FIELDS[node["field"]][0]
        return RD_OCC.get(g["cat"], "mech_engineer")

    def _raise_equity(self, amount):
        """Wealthy households put savings into a new venture."""
        w = self.w
        S = w.scale
        rich = sorted((p for p in w.persons.values() if p.age >= 18 * 12), key=lambda p: -p.savings)[:50]
        tot = sum(p.savings for p in rich) * S
        take = min(amount, 0.2 * tot)
        if take <= 0:
            return 0.0
        for p in rich:
            p.savings -= take * (p.savings * S / tot) / S
        return take

    def _name(self, gid):
        from .world import firm_name
        return firm_name(self.w.rng, gid, self.cat)

    # ------------------------------------------------- infrastructure, housing
    def _infrastructure(self, ctx):
        w, cat = self.w, self.cat
        pol = w.policy
        split = pol["infrastructure_split"]
        ts = sum(max(0, v) for v in split.values()) or 1
        bought = ctx.gov_bought.get("infrastructure_works", {})
        price = w.prices.get("infrastructure_works", 1000.0)
        for r in w.regions:
            val = bought.get(r.id, 0.0) * price / max(w.price_index, 1e-6)
            for k in list(r.infra):
                q = r.infra[k]
                q *= 0.9988
                share = max(0.0, split.get(k, 0)) / ts
                if k == "port" and not r.port:
                    share = 0
                if share > 0 and val > 0:
                    if k in ("road", "rail"):
                        K = INFRA_K[k] * r.area
                    elif k == "port":
                        K = INFRA_K[k]
                    elif k == "irrigation":
                        K = INFRA_K[k] * r.land.get("land_crop", 1)
                    elif k == "transit":
                        K = INFRA_K[k] * max(r.urban_pop * w.scale, 1e4)
                    else:
                        K = INFRA_K[k] * max(r.pop * w.scale, 1e4)
                    q += val * share / K * (1.0 - q)
                r.infra[k] = max(0.0, min(1.0, q))
            hf = [f for f in w.firms.values() if f.good == "housing" and f.region == r.id]
            r.dwellings = sum(f.equip.get("dwelling", 0) for f in hf)
            r.rent = hf[0].price if hf else w.prices.get("housing", 1000)
        # education & health service levels from what the state actually bought
        seats = {}
        useats = {}
        qual = {}
        for r in w.regions:
            q = ctx.gov_bought.get("public_education", {}).get(r.id, 0.0)
            seats[r.id] = q * 12.0
            useats[r.id] = ctx.gov_bought.get("public_university", {}).get(r.id, 0.0) * 12.0
        teach_skill = defaultdict(list)
        for f in w.firms.values():
            if f.good == "public_education":
                for pid, fte in f.staff.items():
                    p = w.persons.get(pid)
                    if p:
                        teach_skill[f.region].append(p.skill.get(p.occ, 0.3))
        students = defaultdict(int)
        for p in w.persons.values():
            if p.school == "school":
                students[p.region] += 1
        for r in w.regions:
            ratio = seats[r.id] / max(1.0, students[r.id] * w.scale)
            ts_ = teach_skill.get(r.id) or [0.3]
            qual[r.id] = min(1.3, ratio) * (0.5 + sum(ts_) / len(ts_))
        w.stats["school_seats"] = seats
        w.stats["uni_seats"] = useats
        w.stats["school_quality"] = qual
        pop = sum(r.pop for r in w.regions) * w.scale
        health_val = sum(ctx.gov_bought.get("public_health", {}).values()) * w.prices.get("public_health", 1000)
        for gid in ("private_healthcare", "dental_care", "generic_medicines", "antibiotics", "vaccines",
                    "biologic_drugs", "insulin"):
            health_val += ctx.flows.get(gid, {}).get("hh_value", 0.0)
        hpc = health_val / max(pop, 1) / max(w.price_index, 1e-6)
        w.stats["health_pc"] = hpc
        w.stats["health_access"] = min(1.0, hpc / 180.0) ** 0.6

    # -------------------------------------------------------------- external
    def _external(self, ctx):
        w = self.w
        X = ctx.stats.get("exports", 0.0)
        M = ctx.stats.get("imports", 0.0)
        div = ctx.stats.get("foreign_dividends", 0.0)
        fdi = ctx.stats.get("fdi", 0.0)
        ca = X - M - div
        gdp = max(w.stats.get("gdp_trailing", w.stats.get("gdp_month", 1e8)), 1.0)
        # imports drain domestic money abroad; exports bring it in
        bal = w.stats.get("row_balance", 0.0) + ca + fdi
        w.stats["row_balance"] = bal
        ema = w.stats.get("ca_ema", 0.0) * 0.9 + 0.1 * (ca + fdi) / gdp
        w.stats["ca_ema"] = ema
        infl = w.stats.get("inflation", 0.02)
        # a deficit (or high inflation) weakens the currency, making imports dearer
        # deficits, inflation above the world's and low interest rates weaken the currency
        change = -0.03 * ema + (infl - 0.02) / 12.0 + 0.25 * (0.03 - w.policy_rate) / 12.0
        change = max(-0.025, min(0.025, change))
        w.fx *= math.exp(change)
        ctx.stats["current_account"] = ca

    # --------------------------------------------------------------- metrics
    def _metrics(self, ctx):
        w, cat = self.w, self.cat
        S = w.scale
        st = w.stats
        pol = w.policy
        persons = list(w.persons.values())
        pop = len(persons) * S
        ret = pol["retirement_age"] * 12
        # labor
        lf = 0.0
        emp = 0.0
        wages = []
        occ_emp = defaultdict(float)
        occ_wage = defaultdict(float)
        for p in persons:
            if p.school or p.age < 15 * 12 or p.age >= ret or p.occ is None or p.inactive:
                continue
            lf += 1
            e = p.fte
            emp += e
            for fid, (fte, wage) in p.jobs.items():
                wages.append((wage, fte))
                occ_emp[p.occ] += fte
                occ_wage[p.occ] += fte * wage
        unemp = 1 - emp / lf if lf else 0.0
        wages.sort()
        tw = sum(x[1] for x in wages)
        acc = 0.0
        med = st.get("median_wage", 1000)
        for wg, fte in wages:
            acc += fte
            if acc >= tw / 2:
                med = wg
                break
        avg_wage = sum(wg * f for wg, f in wages) / tw if tw else st.get("avg_wage", 1000)
        # unemployed occupations' wage index drifts with average wages
        st["median_wage"] = med
        st["avg_wage"] = avg_wage
        st["unemployment"] = unemp
        # expenditure GDP
        C = sum(fl.get("hh_value", 0) for fl in ctx.flows.values())
        G = sum(v for k, v in ctx.gov_spend.items() if k in cat.goods)
        I = sum(fl.get("inv_value", 0) for fl in ctx.flows.values())
        X = ctx.stats.get("exports", 0.0)
        M = ctx.stats.get("imports", 0.0)
        dinv = 0.0
        for f in w.firms.values():
            fs = ctx.fs.get(f.id)
            if fs and not cat.goods[f.good]["svc"]:
                dinv += (fs.get("net", 0) - fs.get("sold", 0)) * f.price
        gdp = C + G + I + dinv + X - M
        gdp = max(gdp, 1.0)
        # wages respond to slack in each occupation (an occupational Phillips
        # curve) on top of expected inflation; existing contracts follow slowly
        occ_lf = defaultdict(float)
        for p in persons:
            if p.occ and not p.school and not p.inactive and 15 * 12 <= p.age < ret:
                occ_lf[p.occ] += 1
        vac = st.get("vacancies_by_occ", {})
        exp_infl = max(-0.02, min(0.15, st.get("inflation", 0.02))) / 12.0
        # wages also track the trend in labor productivity (real output per worker)
        rva = gdp / max(w.price_index, 1e-9) / max(emp, 1e-9)
        prev = st.get("rva_trend", rva)
        st["rva_trend"] = 0.98 * prev + 0.02 * rva
        prod_g = max(-0.005, min(0.006, (st["rva_trend"] / prev - 1.0) if prev > 0 else 0.0))
        ref_avg = sum(oc["ref_wage"] for oc in cat.occupations.values()) / len(cat.occupations)
        mean_idx = sum(w.wage_index.values()) / max(len(w.wage_index), 1)
        for o in cat.occupations:
            lfo = occ_lf.get(o, 0)
            if lfo <= 0:
                continue
            u_o = 1 - occ_emp.get(o, 0) / lfo
            v_o = min(0.3, vac.get(o, 0) / max(lfo, 3))
            chg = 0.7 * exp_infl + 0.015 * (v_o - u_o + 0.07)
            chg = max(-0.012, min(0.012, chg))
            wi = w.wage_index.get(o, 1000) * (1 + chg)
            # scarce skills earn premiums, but substitution, training and
            # immigration keep the wage structure within a band of the world's
            rel = cat.occupations[o]["ref_wage"] / ref_avg * mean_idx
            w.wage_index[o] = max(0.5 * rel, min(2.0 * rel, wi))
        for p in persons:
            for fid, job in p.jobs.items():
                tgt = w.wage_index.get(p.occ, job[1]) * (0.85 + 0.3 * p.skill.get(p.occ, 0.5))
                d = tgt - job[1]
                job[1] += d * (0.04 if d > 0 else 0.015)
        # CPI from the household basket (chained)
        basket = {gid: fl.get("hh_qty", 0) for gid, fl in ctx.flows.items() if fl.get("hh_qty", 0) > 0}
        prev_basket = st.get("basket", {})
        prev_prices = st.get("basket_prices", {})
        num = den = 0.0
        prices_now = {}
        for gid, q in basket.items():
            fl = ctx.flows[gid]
            prices_now[gid] = fl["hh_value"] / max(q, 1e-12)
        for gid, q in prev_basket.items():
            if gid in prices_now and gid in prev_prices:
                num += q * prices_now[gid]
                den += q * prev_prices[gid]
        if den > 0:
            chg = max(0.9, min(1.1, num / den))
            w.price_index *= chg
        st["basket"] = basket
        st["basket_prices"] = {**prev_prices, **prices_now}
        hist = st.setdefault("cpi_hist", [])
        hist.append(w.price_index)
        if len(hist) > 13:
            hist.pop(0)
        infl = (hist[-1] / hist[0]) ** (12.0 / (len(hist) - 1)) - 1 if len(hist) > 1 else 0.0
        st["inflation"] = 0.7 * st.get("inflation", infl) + 0.3 * infl if len(hist) > 3 else 0.02
        gh = st.setdefault("gdp_hist", [])
        gh.append(gdp)
        if len(gh) > 12:
            gh.pop(0)
        st["gdp_month"] = gdp
        st["gdp_trailing"] = sum(gh) / len(gh)
        trend_prev = st.get("gdp_trend", st["gdp_trailing"])
        st["gdp_trend"] = 0.97 * trend_prev + 0.03 * st["gdp_trailing"]
        real_gdp = gdp / w.price_index
        rg = st.setdefault("rgdp_hist", [])
        rg.append(real_gdp)
        if len(rg) > 24:
            rg.pop(0)
        growth = (sum(rg[-12:]) / sum(rg[:12]) - 1) if len(rg) >= 24 else 0.0
        cons_pc = C / max(pop, 1) / w.price_index
        st["cons_pc_real"] = 0.9 * st.get("cons_pc_real", cons_pc) + 0.1 * cons_pc
        # people
        urban = sum(1 for p in persons if p.urban) / max(len(persons), 1)
        adults = [p for p in persons if p.age >= 25 * 12]
        st["urbanization"] = urban
        st["avg_school_years"] = sum(p.school_years for p in adults) / max(len(adults), 1)
        hi_edu = sum(1 for p in adults if p.edu >= 4) / max(len(adults), 1)
        st["absorptive"] = min(1.0, 0.15 + hi_edu * 2.5)
        ref = sum(cat.occupations[o]["ref_wage"] * HOURS * occ_emp[o] for o in occ_emp)
        act = sum(occ_wage[o] for o in occ_emp)
        st["wage_level_vs_world"] = act / max(ref, 1) / max(w.fx, 1e-9) / max(w.price_index, 1e-9) * w.price_index
        incomes = sorted(p.income_last for p in persons if p.age >= 18 * 12)
        gini = 0.0
        if incomes:
            n = len(incomes)
            tot = sum(incomes)
            if tot > 0:
                cum = sum((i + 1) * x for i, x in enumerate(incomes))
                gini = (2 * cum) / (n * tot) - (n + 1) / n
        poverty = sum(1 for x in incomes if x < 0.4 * med) / max(len(incomes), 1)
        wealth = sorted(p.savings for p in persons if p.age >= 18 * 12)
        top10w = sum(wealth[int(len(wealth) * 0.9):]) / max(sum(wealth), 1)
        edu_counts = [0] * 6
        for p in adults:
            edu_counts[p.edu] += 1
        # life expectancy at birth from current death risks (rough period table)
        health = st.get("health_access", 0.5)
        le = 0.0
        surv = 1.0
        for a in range(0, 110):
            m = demography.annual_mortality(a + 0.5, health)
            le += surv * (1 - m / 2)
            surv *= (1 - m)
        # regions
        reg = {}
        for r in w.regions:
            rp = [p for p in persons if p.region == r.id]
            lfr = [p for p in rp if not p.school and 15 * 12 <= p.age < ret and p.occ and not p.inactive]
            er = sum(p.fte for p in lfr)
            wr = [j[1] for p in rp for j in p.jobs.values()]
            reg[r.id] = {
                "name": r.name, "pop": len(rp) * S, "urban_pop": r.urban_pop * S,
                "unemployment": 1 - er / len(lfr) if lfr else 0,
                "avg_wage": sum(wr) / len(wr) if wr else avg_wage,
                "rent": r.rent, "dwellings": r.dwellings,
                "crowding": len(rp) * S / max(r.dwellings, 1),
                "dwelling_cap": self.max_dwellings(r),
                "productivity": r.productivity, "infra": dict(r.infra),
                "va": ctx.region_va.get(r.id, 0), "urban_km2": r.urban_km2,
            }
        st["region"] = reg
        # government
        rev = sum(ctx.gov_rev.values())
        spend = sum(ctx.gov_spend.values())
        st["gov_rev_ema"] = 0.9 * st.get("gov_rev_ema", rev) + 0.1 * rev
        # energy
        elec_dem = ctx.flows.get("electricity", {})
        firms_alive = list(w.firms.values())
        n_firms = len(firms_alive)
        kn = [v for v in w.knowledge.values()]
        metrics = {
            "year": round(w.year, 3), "population": pop, "gdp": gdp, "real_gdp": real_gdp,
            "gdp_pc": gdp / max(pop, 1), "real_gdp_pc": real_gdp / max(pop, 1), "growth": growth,
            "C": C, "G": G, "I": I, "dInv": dinv, "X": X, "M": M, "trade_balance": X - M,
            "cpi": w.price_index, "inflation": st["inflation"], "policy_rate": w.policy_rate,
            "fx": w.fx, "unemployment": unemp, "labor_force": lf * S, "employment": emp * S,
            "avg_wage": avg_wage, "median_wage": med, "real_avg_wage": avg_wage / w.price_index,
            "gini": gini, "poverty": poverty, "top10_wealth": top10w,
            "gov_revenue": rev, "gov_spending": spend, "gov_deficit": spend - rev,
            "gov_debt": w.gov["debt"], "debt_gdp": w.gov["debt"] / max(st["gdp_trailing"] * 12, 1),
            "gov_rev_detail": dict(ctx.gov_rev), "gov_spend_detail": dict(ctx.gov_spend),
            "bank_loans": w.bank["loans"], "bank_equity": w.bank["equity"],
            "firms": n_firms, "entries": ctx.stats.get("entries", 0),
            "bankruptcies": ctx.stats.get("bankruptcies", 0),
            "births": ctx.stats.get("births", 0), "deaths": ctx.stats.get("deaths", 0),
            "tfr": st.get("tfr", 2), "life_expectancy": le, "urbanization": urban,
            "avg_school_years": st["avg_school_years"], "tertiary_share": hi_edu,
            "edu_attainment": [c / max(len(adults), 1) for c in edu_counts],
            "enrollment": sum(st.get("enroll_ratio", {}).values()) / max(len(st.get("enroll_ratio", {})), 1) if st.get("enroll_ratio") else None,
            "health_pc": st.get("health_pc", 0), "emissions": ctx.emissions,
            "electricity": elec_dem.get("dom_sold", 0), "electricity_shortage": elec_dem.get("shortage", 0),
            "elec_mix": dict(ctx.elec_mix), "knowledge_index": sum(kn) / len(kn),
            "research_py": ctx.stats.get("research_py", 0), "rd_py": ctx.stats.get("rd_py", 0),
            "hires": ctx.stats.get("hires", 0), "vacancies": ctx.stats.get("vacancies", 0),
            "migrants": ctx.stats.get("migrants", 0), "immigrants": ctx.stats.get("immigrants", 0),
            "emigrants": ctx.stats.get("emigrants", 0), "fdi": ctx.stats.get("fdi", 0),
            "current_account": ctx.stats.get("current_account", 0),
            "wage_level_vs_world": st["wage_level_vs_world"], "housing_rent": w.prices.get("housing", 0),
            "crowding": pop / max(sum(r.dwellings for r in w.regions), 1),
            "sector_va": dict(ctx.sector_va), "hh_need": ctx.stats.get("hh_need", {}),
            "occ_employment": {o: v * S for o, v in occ_emp.items()},
            "occ_wage": {o: occ_wage[o] / occ_emp[o] for o in occ_emp if occ_emp[o] > 0},
            "dividends": ctx.stats.get("dividends", 0), "wage_bill": ctx.stats.get("wage_bill", 0),
            "domestic_products": sum(1 for gid in w.produced_ever),
            "regions": reg,
        }
        return metrics

    @property
    def _informal(self):
        return self._ctx.informal

    @property
    def _imp_ledger(self):
        return self._ctx.imp_ledger
