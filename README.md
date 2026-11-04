# Domestic Economic Simulation

An agent-based simulation of a national economy in which industries, talent and technology **emerge**
from physical, economic and knowledge constraints. Nothing tells the model that a region is "good at"
mining or chips: deposits, climate, infrastructure, schooling, know-how, prices and decisions do.

You set policy (taxes, subsidies, tariffs, education, research, zoning and density, infrastructure,
immigration, monetary rules, industrial policy…), run months or decades forward, and **rewind** to any
past month to decide differently. Each rewind creates a branch, so outcomes can be compared side by side.
Every payment is written to a SQLite ledger.

## Quick start

Tooling is managed with [mise](https://mise.jdx.dev) (Node 26, pnpm, Python 3.13), configured in
`.config/mise.toml`.

```bash
bin/setup.sh        # brew bundle + mise install + pnpm install
mise run dev        # engine on :8000 + website on :3000
```

Or run the pieces separately:

```bash
mise run engine     # Python simulation engine + SQLite API (apps/engine)
mise run web        # Next.js website; /api is proxied to the engine through Hono
mise run test       # engine tests (unittest) + JS tests (vitest)
```

Open http://localhost:3000, press **New simulation**, pick a scenario, then **+1 year** / **+10 years**.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/engine` | The simulation (pure-stdlib Python) and its JSON API + SQLite store |
| `apps/engine/econsim/catalog` | The catalog: 563 goods & services, 697 processes, 130 knowledge nodes, 43 occupations, deposits, climate |
| `apps/internal-api` | Hono app mounted at `/api` by Next.js; forwards to the engine (`ECONSIM_ENGINE_URL`) |
| `apps/website` | Next.js 16 dashboard (overview, policy & rewind, timelines, money flows, products, industry, labor, knowledge, regions, ledger, events, catalog) |
| `lib/typescript/utils` | Shared TS utilities from the template |

## The model

**Physical engine.** Every product is a structured engineering object: inputs (with substitutes),
primary and auxiliary equipment, labor hours by occupation, required knowledge, a dimensional tolerance
in micrometres, a cleanroom class, energy, CO₂ and opacity to reverse engineering. Output is limited by
equipment, the site (deposit grade and depletion, crop suitability from temperature and rainfall,
solar/wind/hydro potential) and inputs. Yield falls when the maker's machines are less precise than
the product's tolerance, so precision must be bootstrapped: hand tools → lathes → grinders → CNC →
ultra-precision tools → lithography. The year each good first became possible worldwide is *derived*
from its whole supply chain (e.g. leading-edge chips need EUV scanners → 2019).

**Economic & social engine.** ~5,000 agents (each a group of people) age, go to school, choose fields
by expected wages, work, migrate, have children and die. Firms hire in a matching labor market, price
off costs and inventories, invest, borrow, export when competitive, switch technologies when wages
change, and go bankrupt. Households spend by need along Engel curves. The government taxes, buys public
services (schools, hospitals, research, administration, infrastructure), pays benefits and borrows; a
central bank follows a Taylor rule; the currency floats.

**Knowledge & invention engine.** Understanding, reproducing, manufacturing economically and improving
are separate achievements. National science grows via public research, literature absorption (limited
by how educated the workforce is), learning by doing, and decays when unpracticed. Firm R&D is uncertain:
inconclusive months, setbacks, prototype failures when inputs or precision are missing, reverse
engineering that depends on how opaque the product is. Design generations can overtake the world frontier.

**Rewind.** The full state is snapshotted yearly; the simulation is deterministic, so any month is
reconstructed by replay from the nearest snapshot.

## Honest limits

This is selective approximation, not physics. Labor hours and equipment throughput are calibrated so
processes cover their costs at 2025 world prices; the rest of the world is an exogenous frontier; finance
is a single bank. The baseline shows business cycles and long runs can drift (e.g. slow erosion after a
boom), and the historical scenarios (1850, 1950) are less calibrated than the 2025 ones. Use it to
explore mechanisms and trade-offs, not to forecast.

## CI

The GitHub Actions workflow lives in `ci/ci.yml` (it could not be pushed by the automation that created
this repo). Enable it with `git mv ci/ci.yml .github/workflows/ci.yml`.
