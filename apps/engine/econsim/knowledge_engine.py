"""Knowledge and invention.

National knowledge levels (0..1) per node change through:
  * public research (scientists paid by the research budget, by field priority)
  * university professors (part-time research)
  * firm R&D spillovers
  * absorbing world literature (needs an educated workforce: absorptive capacity)
  * learning by doing: process know-how grows while it is practiced domestically
  * forgetting: process know-how decays when nobody practices it

Firms separately hold *designs*. Reproducing a product (design 0 -> 1) is an
uncertain R&D project: months can be inconclusive, setbacks happen,
prototypes fail if the needed inputs or equipment precision are missing, and
disassembling imports helps only as much as the product is transparent and
the firm understands the underlying science. After a design works, firms
improve it generation by generation; they can overtake the world frontier.
"""
import math

from . import physical

CATCHUP_FACTOR = 0.12      # re-discovering known science costs ~12% of inventing it
FRONTIER_FACTOR = 4.0      # genuine invention: wrong turns, failed experiments, no roadmap
LITERATURE_RATE = 0.0006   # monthly absorption from world literature at full capacity
DECAY = 0.0012             # monthly loss of unpracticed process know-how


def research_effort(w, cat, firm, occs=None):
    """Person-years of research per month from a firm's staff."""
    e = 0.0
    for pid, fte in firm.staff.items():
        p = w.persons.get(pid)
        if p is None:
            continue
        if occs and p.occ not in occs:
            continue
        e += fte * w.scale * (0.3 + p.skill.get(p.occ, 0.2)) / 12.0
    return e


def step(sim, ctx):
    w, cat = sim.w, sim.cat
    rng = w.rng
    pol = w.policy
    K = w.knowledge
    year = w.year
    # ------------------------------------------------ national research effort by field
    field_effort = {}
    research_occs = {"scientist", "lab_tech", "professor", "agronomist", "doctor",
                     "mech_engineer", "elec_engineer", "chem_engineer", "materials_engineer",
                     "software_dev", "process_engineer", "civil_engineer"}
    pub = 0.0
    for f in w.firms.values():
        if f.good == "public_research":
            pub += research_effort(w, cat, f, research_occs) * min(1.0, f.last.get("util", 1.0) + 0.2)
        elif f.good == "public_university":
            pub += 0.3 * research_effort(w, cat, f, {"professor"})
    weights = pol["research_fields"]
    totw = sum(max(0, v) for v in weights.values()) or 1
    for fld, wt in weights.items():
        field_effort[fld] = pub * max(0, wt) / totw
    # firm R&D spills over into the national stock (25%)
    for fid, (eff, nodes) in ctx.rd_spill.items():
        for k in nodes:
            fld = cat.knowledge[k]["field"]
            field_effort[fld] = field_effort.get(fld, 0) + 0.25 * eff / max(1, len(nodes))
    ctx.stats["research_py"] = pub * 12
    # ------------------------------------------------ allocate to nodes
    by_field = {}
    for k, node in cat.knowledge.items():
        if K.get(k, 0) >= 0.999:
            continue
        pre = node["prereqs"]
        pmin = min((K.get(x, 0) for x in pre), default=1.0)
        if pmin < 0.55:
            continue
        by_field.setdefault(node["field"], []).append((k, pmin))
    for fld, eff in field_effort.items():
        nodes = by_field.get(fld)
        if not nodes or eff <= 0:
            continue
        # catch up on known science first; frontier work gets a minority share
        known = [x for x in nodes if cat.kyear[x[0]] <= year]
        front = [x for x in nodes if cat.kyear[x[0]] > year]
        alloc = []
        if known:
            known.sort(key=lambda x: cat.kyear[x[0]])
            focus = known[:4]
            share = 0.85 if front else 1.0
            for x in focus:
                alloc.append((x, eff * share / len(focus)))
        # frontier work needs the prerequisites mastered, not just understood
        front = [x for x in front if x[1] >= 0.85]
        if front:
            front.sort(key=lambda x: cat.kyear[x[0]])
            focus = front[:2]
            share = 0.15 if known else 1.0
            for x in focus:
                alloc.append((x, eff * share / len(focus)))
        for (k, pmin), e in alloc:
            node = cat.knowledge[k]
            world_knows = cat.kyear[k] <= year
            # inventing something nobody has done is far harder than re-learning it
            diff = node["diff"] * (CATCHUP_FACTOR if world_knows else FRONTIER_FACTOR)
            pf = min(1.0, pmin / 0.8) ** 2
            noise = math.exp(rng.gauss(-0.1, 0.5))
            d = e / diff * pf * noise
            before = K.get(k, 0)
            if not world_knows:
                # frontier research is genuinely uncertain
                if rng.random() < 0.02:
                    K[k] = max(0.0, before - 0.15 * before)
                    if before > 0.1:
                        w.event("research", f"Research on {node['name']} hit a dead end; "
                                            f"a promising approach failed (understanding {before:.0%} -> {K[k]:.0%}).",
                                node=k)
                    continue
            K[k] = min(1.0, before + d)
            _announce(w, cat, k, before, K[k], world_knows)
    # ------------------------------------------------ literature absorption
    absorb = w.stats.get("absorptive", 0.3)
    for k, node in cat.knowledge.items():
        lv = K.get(k, 0)
        if lv >= 1.0 or cat.kyear[k] > year:
            continue
        pmin = min((K.get(x, 0) for x in node["prereqs"]), default=1.0)
        if pmin < 0.7:
            continue
        rate = LITERATURE_RATE * absorb * (0.3 if node["kind"] == "proc" else 1.0)
        nv = min(1.0, lv + rate * (1.05 - lv) * 2)
        K[k] = nv
        _announce(w, cat, k, lv, nv, True)
    # ------------------------------------------------ learning by doing / forgetting
    practiced = ctx.practiced
    for k, node in cat.knowledge.items():
        if node["kind"] == "sci":
            continue
        lv = K.get(k, 0)
        if k in practiced:
            intensity = min(1.0, practiced[k] / 5e5)
            nv = min(1.0, lv + 0.01 * intensity * (1.0 - lv) + 0.002 * intensity)
            K[k] = nv
            _announce(w, cat, k, lv, nv, cat.kyear[k] <= year)
        elif lv > 0 and node["kind"] == "proc":
            K[k] = max(0.0, lv - DECAY * (0.5 + lv))
            if lv >= 0.5 > K[k]:
                w.event("knowledge", f"Process know-how for {node['name']} is fading: "
                                     f"nobody has practiced it domestically for years.", node=k)


def _announce(w, cat, k, before, after, world_knows):
    node = cat.knowledge[k]
    if before < 0.5 <= after:
        if world_knows:
            w.event("knowledge", f"Domestic researchers now understand {node['name']} "
                                 f"(known abroad since {cat.kyear[k]}).", node=k)
        else:
            w.event("invention", f"BREAKTHROUGH: {node['name']} achieved domestically "
                                 f"before the rest of the world!", node=k)


def firm_rd(sim, ctx, f):
    """Run a firm's R&D for one month: reproduce its product, or improve it."""
    w, cat = sim.w, sim.cat
    rng = w.rng
    p = cat.procs[f.proc]
    g = cat.goods[f.good]
    # embodied technical change: replacing machines and buying licences slowly
    # brings an established producer's design up toward the world frontier
    if f.design >= 1.0 and f.gen < physical.world_generation(w, cat, f.good) - 1 and rng.random() < 1 / 30.0:
        f.gen += 1
    if f.rd_share <= 0:
        return
    occs = {"mech_engineer", "elec_engineer", "chem_engineer", "materials_engineer",
            "software_dev", "process_engineer", "scientist", "pharmacist", "agronomist",
            "designer", "technician", "lab_tech"}
    eff = research_effort(w, cat, f, occs) * f.rd_share
    if f.design >= 1.0:
        # only the engineers actually assigned to R&D count
        tech = sum(fte for pid, fte in f.staff.items() if w.persons.get(pid) and w.persons[pid].occ in occs)
        rd_fte = ctx.fs.get(f.id, {}).get("rd_fte", 0.0)
        eff *= min(1.0, rd_fte / tech) if tech > 0 else 0.0
    if eff <= 0:
        if f.design < 1.0:
            f.blocked = "no engineers available for R&D"
        return
    ctx.rd_spill[f.id] = (eff, p["know"])
    ctx.stats["rd_py"] = ctx.stats.get("rd_py", 0) + eff * 12
    D = p["design_effort"]
    if f.design < 1.0:
        # ---- scientific feasibility gate
        missing = [k for k in p["know"] if w.knowledge.get(k, 0) < 0.5]
        if missing:
            f.blocked = "science not understood: " + ", ".join(cat.knowledge[k]["name"] for k in missing[:3])
            if rng.random() < 0.02:
                w.event("rd", f"{f.name} cannot progress on {g['name']}: the country does not yet "
                              f"understand {cat.knowledge[missing[0]]['name']}.", firm=f.id, good=f.good)
            return
        mult = 1.0
        # reverse engineering imports
        if w.imports_12m.get(f.good, 0) > 0:
            under = min((w.knowledge.get(k, 0) for k in p["know"]), default=1.0)
            mult += 3.0 * (1.0 - g["opq"]) * under ** 2
        # other domestic producers' engineers carry tacit knowledge
        if any(o.good == f.good and o.design >= 1 and o.id != f.id for o in w.firms.values()):
            mult += 2.0
        if f.owner == "foreign":
            mult += 4.0
        roll = rng.random()
        if roll < 0.28:
            outcome = "inconclusive"
            d = 0.0
        elif roll < 0.33:
            outcome = "setback"
            d = -0.08 * f.design
        elif roll < 0.36:
            outcome = "breakthrough"
            d = 3.0 * eff * mult / D
        else:
            outcome = "progress"
            d = eff * mult / D * math.exp(rng.gauss(0, 0.4))
        new = max(0.0, f.design + d)
        # engineering prototype gate at 85%: needs real inputs and precise enough tools
        if new >= 0.85:
            reason = prototype_blocker(w, cat, f, p)
            if reason:
                new = min(new, 0.85)
                if f.blocked != reason:
                    w.event("rd", f"{f.name}'s {g['name']} prototype failed: {reason}.", firm=f.id, good=f.good)
                f.blocked = reason
            else:
                f.blocked = None
        if outcome == "setback" and f.design > 0.2 and rng.random() < 0.3:
            w.event("rd", f"{f.name} hit unexpected problems developing {g['name']} "
                          f"(test results contradicted the design; progress {f.design:.0%} -> {new:.0%}).",
                    firm=f.id, good=f.good)
        if new >= 1.0:
            f.design = 1.0
            f.blocked = None
            f.gen = max(0, physical.world_generation(w, cat, f.good) - 2)
            first = f.good not in w.produced_ever
            w.event("invention" if first else "rd",
                    f"{f.name} can now reproduce {g['name']}" +
                    (" - a first for the country." if first else "."), firm=f.id, good=f.good)
        else:
            f.design = new
    else:
        # ---- improvement R&D: needs a working product line
        if g["cat"] == "public" or f.cum_output <= f.plan * 12:
            return
        ahead = f.gen - physical.world_generation(w, cat, f.good)
        # catching up to the frontier is far cheaper than pushing beyond it
        if ahead < 0:
            need = max(D, 500.0) * 2.0
        else:
            need = max(D, 2000.0) * 6.0 * (3.0 ** ahead)
        if rng.random() < min(0.03, eff / need):
            f.gen += 1
            ahead = f.gen - physical.world_generation(w, cat, f.good)
            if ahead >= 1:
                w.event("invention", f"{f.name} improved {g['name']} beyond the world frontier "
                                     f"(generation +{ahead}).", firm=f.id, good=f.good)
            elif rng.random() < 0.2:
                w.event("rd", f"{f.name} released an improved {g['name']} design.", firm=f.id, good=f.good)


def prototype_blocker(w, cat, f, p):
    g = cat.goods[f.good]
    sim_prices = w.prices
    for alts, q in p["inputs"]:
        if alts[0] in p.get("optional", ()):
            continue
        ok = False
        for a in alts:
            ga = cat.goods[a]
            if a in w.produced_ever or (ga["year"] <= w.year and not ga["restricted"] and not ga["nt"]):
                ok = True
                break
        if not ok:
            return f"{cat.goods[alts[0]]['name']} is unobtainable (not made at home, not sold abroad)"
    if p["equip"]:
        ok = False
        for a in p["equip"]:
            ga = cat.goods[a]
            if a in cat.endowments or a in w.produced_ever or (ga["year"] <= w.year and not ga["restricted"]):
                ok = True
        if not ok:
            return f"no access to {cat.goods[p['equip'][0]]['name']}"
        if g["tol"]:
            best = min(((cat.goods[a]["prec"] or 1e9) for a in p["equip"]), default=1e9)
            if best > g["tol"] * 4:
                return (f"available machines hold {best:g}um but the design needs {g['tol']:g}um "
                        f"tolerances")
    if g["clean"] and cat.goods[g["clean"]]["year"] > w.year and g["clean"] not in w.produced_ever:
        return f"needs a {cat.goods[g['clean']]['name']}"
    return None


def update_skills(sim, ctx):
    """On-the-job learning and unemployment skill loss."""
    w, cat = sim.w, sim.cat
    for p in w.persons.values():
        if p.occ is None or p.school:
            continue
        o = cat.occupations[p.occ]
        cap = min(1.0, 0.55 + 0.3 * p.h + 0.08 * max(0, p.edu - o["edu"]))
        s = p.skill.get(p.occ, 0.1)
        fte = p.fte
        if fte > 0:
            s += 0.012 * fte * max(0.0, cap - s)
        else:
            s -= 0.003 * s
        p.skill[p.occ] = s
