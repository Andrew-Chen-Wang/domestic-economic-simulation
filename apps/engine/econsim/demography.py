"""Births, deaths, schooling, university, career entry, migration, immigration.

Fertility falls with income, urbanization and education (the demographic
transition); mortality falls with health spending; school enrollment is
capped by teachers actually employed in public schools; field-of-study choice
responds to wages; graduates can emigrate when domestic pay for their skills
is far below world pay (brain drain).
"""
import math

from .catalog.people import eligible

SCHOOL_MONTH = 8  # September


def annual_mortality(age_y, health):
    """Gompertz adult mortality + infant/child mortality, scaled by health access."""
    base = 0.00004 * math.exp(0.088 * age_y)
    if age_y < 1:
        base += 0.03
    elif age_y < 5:
        base += 0.003
    # health: 0 (none) .. 1 (rich-country access)
    mult = 0.45 + 1.6 * math.exp(-2.5 * health)
    return min(0.6, base * mult)


def fertility(w):
    st = w.stats
    inc = st.get("cons_pc_real", 600.0)
    urban = st.get("urbanization", 0.5)
    edu = st.get("avg_school_years", 9.0)
    tfr = 1.35 + 5.0 * math.exp(-inc / 700.0) * (1.0 - 0.35 * urban) * max(0.3, 1.0 - 0.045 * edu)
    tfr += 0.25 * w.policy.get("child_benefit", 0) / 0.05
    return max(0.9, min(7.5, tfr))


def step(sim, ctx):
    w, cat = sim.w, sim.cat
    rng = w.rng
    pol = w.policy
    ret_age = pol["retirement_age"] * 12
    health = w.stats.get("health_access", 0.5)
    tfr = fertility(w)
    w.stats["tfr"] = tfr
    birth_p = tfr / (25.0 * 12.0) / 2.0 * 2.0 / 2.0  # per adult agent aged 20-44 per month
    births = deaths = 0
    dead = []
    newborn = []
    for p in w.persons.values():
        p.age += 1
        ay = p.age / 12.0
        if rng.random() < annual_mortality(ay, health) / 12.0:
            dead.append(p)
            continue
        if 240 <= p.age < 540 and rng.random() < birth_p:
            newborn.append(p)
        if p.age == ret_age and p.jobs:
            sim.quit_all_jobs(p)
    for p in dead:
        _die(sim, p)
        deaths += 1
    for parent in newborn:
        c = w.new_person(0, parent.region)
        c.guardian = parent.id
        c.h = 0.15
        c.urban = parent.urban
        births += 1
    ctx.stats["births"] = births * w.scale
    ctx.stats["deaths"] = deaths * w.scale
    if w.month == SCHOOL_MONTH:
        _school_year(sim, ctx)
    _youth_entry(sim, ctx)
    if w.month % 3 == 0:
        _migration(sim, ctx)
    _immigration(sim, ctx)


def _die(sim, p):
    w = sim.w
    sim.quit_all_jobs(p)
    # bequest to a random adult in the region (inheritance keeps wealth in families)
    if p.savings > 0:
        heirs = [q for q in w.persons.values() if q.guardian == p.id]
        if not heirs:
            heir = w.persons.get(p.guardian) if p.guardian else None
            heirs = [heir] if heir else []
        if heirs:
            share = p.savings / len(heirs)
            for h in heirs:
                h.savings += share
        else:
            w.gov["cash"] += p.savings * w.scale  # estate escheats to the state
            sim.ledger("hh:%d" % p.region, "gov", "estates", p.savings * w.scale)
    for q in w.persons.values():
        if q.guardian == p.id:
            q.guardian = None
    del w.persons[p.id]


def _school_year(sim, ctx):
    """Advance a school year. Enrollment is limited by seats (teachers employed
    via public education spending); quality by spending per student and
    teacher skill."""
    w, cat = sim.w, sim.cat
    rng = w.rng
    seats = w.stats.get("school_seats", {})
    useats = w.stats.get("uni_seats", {})
    quality = w.stats.get("school_quality", {})
    students = {}
    tert = {}
    for p in w.persons.values():
        if p.school == "school":
            students[p.region] = students.get(p.region, 0) + 1
        elif p.school in ("voc", "bach", "grad"):
            tert[p.region] = tert.get(p.region, 0) + 1
    ratio = {r: min(1.2, seats.get(r, 0) / max(1, students.get(r, 0) * w.scale)) for r in range(len(w.regions))}
    uratio = {r: min(1.2, useats.get(r, 0) / max(1, tert.get(r, 0) * w.scale)) for r in range(len(w.regions))}
    w.stats["enroll_ratio"] = ratio
    w.stats["uni_ratio"] = uratio
    med = w.stats.get("median_wage", 1000.0)
    for p in list(w.persons.values()):
        ay = p.age / 12.0
        if p.school is None and 6 <= ay < 7 and p.school_years == 0:
            p.school = "school"
        if p.school == "school":
            r = p.region
            if rng.random() < min(1.0, ratio.get(r, 1.0) * 1.05):
                p.school_years += 1
                q = quality.get(r, 0.6)
                p.h = min(1.0, p.h + 0.035 * q + rng.uniform(-0.01, 0.015))
            if p.school_years >= 6 and p.edu < 1:
                p.edu = 1
            if p.school_years >= 12:
                p.edu = 2
                _after_secondary(sim, p)
                continue
            # dropout: poverty and the pull of unskilled wages
            if ay >= 14 and p.school_years >= 6:
                g = w.persons.get(p.guardian) if p.guardian else None
                inc = g.income_last if g else 0.0
                poverty = max(0.0, 1.0 - inc / max(med, 1))
                drop = 0.01 + 0.12 * poverty * (1.2 - ratio.get(r, 1.0))
                if rng.random() < drop:
                    p.school = None
                    w.stats["dropouts"] = w.stats.get("dropouts", 0) + 1
        elif p.school in ("voc", "bach", "grad"):
            r = p.region
            if rng.random() < min(1.0, uratio.get(r, 1.0) * 1.1):
                p.school_years += 1
                q = quality.get(r, 0.6)
                p.h = min(1.0, p.h + 0.03 * q + rng.uniform(-0.01, 0.015))
                target = {"voc": 14, "bach": 16, "grad": 18}[p.school]
                if p.school_years >= target:
                    p.edu = {"voc": 3, "bach": 4, "grad": 5}[p.school]
                    if p.school == "bach" and rng.random() < 0.18 * p.h * uratio.get(r, 1.0):
                        p.school = "grad"
                    else:
                        p.school = None
            elif rng.random() < 0.15:
                p.school = None  # gave up waiting for a seat


def _after_secondary(sim, p):
    """Choose vocational school, university (and field), or work."""
    w, cat = sim.w, sim.cat
    rng = w.rng
    pol = w.policy
    ur = w.stats.get("uni_ratio", {}).get(p.region, 0.8)
    g = w.persons.get(p.guardian) if p.guardian else None
    afford = min(1.0, 0.3 + (g.savings if g else 0) / max(w.stats.get("median_wage", 1000) * 6, 1))
    p_bach = max(0.0, min(0.85, (p.h - 0.35) * 1.4)) * min(1.0, ur) * afford
    p_voc = 0.35 * min(1.0, ur + 0.2)
    x = rng.random()
    wages = w.wage_index
    fw = pol["university_fields"]

    def field_weight(f):
        occs = [o for o, oc in cat.occupations.items() if f in oc["fields"]]
        best = max((wages.get(o, 0) for o in occs), default=0)
        return max(0.01, fw.get(f, 0.5)) * (best / max(w.stats.get("avg_wage", 1), 1)) ** 2

    if x < p_bach:
        fields = [f for f, (lvl, _) in cat.fields.items() if lvl == 4]
        p.field = rng.choices(fields, [field_weight(f) for f in fields])[0]
        p.school = "bach"
    elif x < p_bach + p_voc:
        fields = [f for f, (lvl, _) in cat.fields.items() if lvl == 3]
        p.field = rng.choices(fields, [field_weight(f) for f in fields])[0]
        p.school = "voc"
    else:
        p.school = None


def _youth_entry(sim, ctx):
    """Young people not in school join the labor force and pick an occupation.
    Adults move in and out of the labor force: tight labor markets and low
    household income pull people in; long unemployment discourages them."""
    w, cat = sim.w, sim.cat
    rng = w.rng
    u = w.stats.get("unemployment", 0.1)
    vac = sum(w.stats.get("vacancies_by_occ", {}).values())
    pull = 0.004 + 0.02 * min(1.0, vac / 20.0) + 0.01 * max(0.0, 0.08 - u) / 0.08
    med = w.stats.get("median_wage", 1000.0)
    ret = w.policy["retirement_age"] * 12
    for p in w.persons.values():
        if p.school is None and p.occ is None and p.age >= 15 * 12 and p.age < ret:
            choose_occupation(sim, p)
            if rng.random() < 0.15:
                p.inactive = True
        elif p.inactive and p.age < ret:
            poor = 1.0 if p.income_last < 0.4 * med else 0.0
            if rng.random() < pull + 0.01 * poor:
                p.inactive = False
        elif p.occ and not p.inactive and p.fte < 0.05 and p.unemp > 12 and p.age > 25 * 12:
            if rng.random() < 0.01 + 0.02 * max(0.0, u - 0.1):
                p.inactive = True


def choose_occupation(sim, p):
    w, cat = sim.w, sim.cat
    rng = w.rng
    opts = sim.eligible_occs(p.edu, p.field)
    if not opts:
        opts = ["laborer"]
    vac = w.stats.get("vacancies_by_occ", {})
    best = None
    for o in opts:
        oc = cat.occupations[o]
        score = w.wage_index.get(o, 500) * (1 + 2.0 * min(1.0, vac.get(o, 0) / 5.0))
        score *= 1.0 + 0.4 * (oc["edu"] >= p.edu - 1)  # use your education
        score *= rng.uniform(0.7, 1.3)
        if best is None or score > best[0]:
            best = (score, o)
    p.occ = best[1]
    o = cat.occupations[p.occ]
    p.skill[p.occ] = max(p.skill.get(p.occ, 0), min(0.6, 0.08 + 0.35 * p.h + 0.08 * max(0, p.edu - o["edu"])))
    p.urban = p.occ not in ("farmer", "forester", "fisher", "miner")


def _migration(sim, ctx):
    w, cat = sim.w, sim.cat
    rng = w.rng
    n = len(w.regions)
    reg_stats = w.stats.get("region", {})
    if not reg_stats:
        return
    attract = []
    for r in range(n):
        rs = reg_stats.get(r, {})
        inc = rs.get("avg_wage", 1) * (1 - rs.get("unemployment", 0.1))
        rent = max(rs.get("rent", 1), 1)
        crowd = rs.get("crowding", 2.6)
        attract.append(inc / rent ** 0.35 / max(1.0, crowd / 3.0) ** 0.5)
    moved = 0
    movers = []
    for p in w.persons.values():
        if p.age < 18 * 12 or p.age > 55 * 12 or p.school:
            continue
        if p.fte > 0.6 and rng.random() > 0.15:
            continue
        cur = attract[p.region]
        best = max(range(n), key=lambda r: attract[r] / (1 + w.dist[p.region][r] / 2000.0))
        if best == p.region:
            continue
        gain = math.log(max(attract[best], 1e-9) / max(cur, 1e-9)) - 0.15
        if gain > 0 and rng.random() < 0.06 * gain * (1.6 - p.fte):
            movers.append((p, best))
    for p, r in movers:
        sim.quit_all_jobs(p)
        old = p.region
        p.region = r
        moved += 1
        for q in w.persons.values():
            if q.guardian == p.id:
                q.region = r
        if p.occ in ("farmer", "forester", "fisher", "miner"):
            p.urban = True
    ctx.stats["migrants"] = moved * w.scale


def _immigration(sim, ctx):
    w, cat = sim.w, sim.cat
    rng = w.rng
    S = w.scale
    w.stats["immig_acc"] = w.stats.get("immig_acc", 0.0) + w.policy["skilled_immigration"] / 12.0 / S
    n_in = 0
    vac = w.stats.get("vacancies_by_occ", {})
    skilled = [o for o, oc in cat.occupations.items() if oc["edu"] >= 3]
    while w.stats["immig_acc"] >= 1.0:
        w.stats["immig_acc"] -= 1.0
        o = rng.choices(skilled, [vac.get(x, 0) + 0.3 for x in skilled])[0]
        oc = cat.occupations[o]
        reg = max(range(len(w.regions)), key=lambda r: w.stats.get("region", {}).get(r, {}).get("avg_wage", 0) + rng.random())
        p = w.new_person(int(rng.uniform(25, 40) * 12), reg)
        p.edu = max(oc["edu"], 4)
        p.field = next((f for f in oc["fields"] if f != "*"), "business")
        p.school_years = [0, 6, 12, 14, 16, 18][p.edu]
        p.h = rng.uniform(0.6, 0.95)
        p.occ = o
        p.skill[o] = rng.uniform(0.55, 0.85)
        p.immigrant = True
        p.savings = w.stats.get("median_wage", 1000) * 2
        n_in += 1
    # emigration of the highly skilled when world pay is far higher
    out = 0
    wl = w.stats.get("wage_level_vs_world", 1.0)
    if wl < 0.6:
        for p in list(w.persons.values()):
            if p.edu >= 4 and 22 * 12 < p.age < 45 * 12 and p.school is None:
                if rng.random() < 0.0015 * (0.6 - wl) / 0.6 * (2.0 - p.fte):
                    sim.quit_all_jobs(p)
                    for q in w.persons.values():
                        if q.guardian == p.id:
                            q.guardian = None
                    del w.persons[p.id]
                    out += 1
    ctx.stats["immigrants"] = n_in * S
    ctx.stats["emigrants"] = out * S
