import os
import pickle
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from econsim import catalog, physical, policy  # noqa: E402
from econsim import world as world_mod  # noqa: E402
from econsim.engine import Engine, create_world  # noqa: E402
from econsim.sim import Sim  # noqa: E402

CAT = catalog.get()


class CatalogTests(unittest.TestCase):
    def test_no_dangling_references(self):
        self.assertEqual(CAT.errors, [])

    def test_everything_is_eventually_possible(self):
        never = [g for g, v in CAT.goods.items() if v["year"] > 3000]
        self.assertEqual(never, [])

    def test_availability_follows_supply_chain(self):
        # leading-edge chips need EUV scanners, which need EUV know-how (2019)
        self.assertGreaterEqual(CAT.goods["chip_advanced"]["year"], 2019)
        self.assertGreaterEqual(CAT.goods["smartphone"]["year"], 2007)
        self.assertLess(CAT.goods["bread_bakery"]["year"], 0)
        # a product can never predate the knowledge it requires
        for p in CAT.procs.values():
            for k in p["know"]:
                self.assertGreaterEqual(p["year"], CAT.kyear[k], p["id"])

    def test_frontier_processes_cover_costs(self):
        for gid, g in CAT.goods.items():
            if g.get("endowment") or not g["processes"]:
                continue
            p = CAT.procs[g["processes"][0]]
            if p["trad"]:
                continue
            self.assertLessEqual(p["unit_cost_ref"], g["price"] * 1.001 + 1e-9, gid)


class PhysicalTests(unittest.TestCase):
    def test_precision_gate(self):
        self.assertEqual(physical.precision_yield(10, 5, 0.5), 1.0)
        self.assertEqual(physical.precision_yield(10, 100, 0.0), 0.0)
        mid = physical.precision_yield(10, 25, 0.0)
        self.assertTrue(0 < mid < 1)

    def test_1850_cannot_make_semiconductors(self):
        w = world_mod.generate("agrarian_1850", 1)
        sim = Sim(w)
        for gid in ("chip_legacy", "smartphone", "jet_engine"):
            ok = any(sim.process_feasible(CAT.procs[p])[0] for p in CAT.goods[gid]["processes"])
            self.assertFalse(ok, gid)
            self.assertIsNone(CAT.world_price(gid, w.year), gid)


class SimulationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.w = create_world("emerging_2025", 3, burn_in=6)

    def test_deterministic_replay(self):
        blob = zlib.compress(pickle.dumps(self.w))
        out = []
        for _ in range(2):
            w = pickle.loads(zlib.decompress(blob))
            s = Sim(w)
            for _ in range(4):
                _, m = s.step()
            out.append((round(m["gdp"], 6), m["firms"], w.rng.random()))
        self.assertEqual(out[0], out[1])

    def test_ledger_and_metrics_are_sane(self):
        w = pickle.loads(pickle.dumps(self.w))
        ctx, m = Sim(w).step()
        self.assertGreater(m["gdp"], 0)
        self.assertTrue(0 <= m["unemployment"] < 1)
        kinds = {k for (_, _, k) in ctx.ledger}
        for k in ("wages", "consumption", "income tax", "VAT", "sales"):
            self.assertIn(k, kinds)
        wages = sum(v for (_, _, k), v in ctx.ledger.items() if k == "wages")
        self.assertAlmostEqual(wages, ctx.stats["wage_bill"], delta=wages * 1e-6 + 1)


class EngineTests(unittest.TestCase):
    def test_branching_shares_history(self):
        with tempfile.TemporaryDirectory() as d:
            e = Engine(os.path.join(d, "t.db"))
            tid = e.create("emerging_2025", 5, burn_in=4, background=False)
            e.run(tid, 8, background=False)
            r = e.apply_policy(tid, {"vat": 0.25}, "VAT up", tick=4)
            self.assertTrue(r["branched"])
            child = r["timeline"]
            e.run(child, 4, background=False)
            a = e.store.series(tid, ["gdp"])
            b = e.store.series(child, ["gdp"])
            self.assertEqual([x["gdp"] for x in a[:4]], [x["gdp"] for x in b[:4]])
            self.assertNotEqual(a[6]["gdp"], b[6]["gdp"])
            self.assertEqual(e.world_at(child, 8).policy["vat"], 0.25)

    def test_policy_patch_merges(self):
        p = policy.apply_patch(policy.default(), {"subsidies_consumer": {"electric_car": 0.3}, "vat": 0.2})
        self.assertEqual(p["vat"], 0.2)
        self.assertEqual(p["subsidies_consumer"]["electric_car"], 0.3)
        p2 = policy.apply_patch(p, {"subsidies_consumer": {"electric_car": None}})
        self.assertNotIn("electric_car", p2["subsidies_consumer"])


if __name__ == "__main__":
    unittest.main()
