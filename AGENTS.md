## Build Commands

All tools (Node 26, pnpm, Python 3.13) come from mise: `.config/mise.toml`.

```bash
mise install && pnpm install     # setup
mise run dev                     # engine (:8000) + website (:3000)
mise run engine                  # Python engine only
mise run web                     # Next.js only (needs the engine for /api)
mise run test                    # Python unittest + vitest

pnpm run format                  # Oxfmt with .config/oxfmt.config.mts
pnpm run lint                    # Oxlint (type-aware) with auto-fix
python -m unittest discover -s apps/engine/tests -v
```

## Architecture

pnpm monorepo:

- `apps/engine` - the simulation. Pure-stdlib Python + SQLite. `econsim/catalog` (goods, processes,
  knowledge, occupations, deposits), `world.py` (state + scenario generation), `physical.py`,
  `sim.py` (monthly economic step), `demography.py`, `knowledge_engine.py`, `store.py` (timelines,
  snapshots, ledger), `engine.py` (run / fork / replay), `server.py` (JSON API).
- `apps/internal-api` - Hono app mounted at `/api` by the website; proxies to the engine
  (`ECONSIM_ENGINE_URL`, default `http://127.0.0.1:8000`).
- `apps/website` - Next.js 16. `src/app/page.tsx` renders the shell; `src/lib/dashboard/*.js` renders
  the views imperatively (untyped JS, excluded from type-aware lint until ported to typed components).
- `lib/typescript/utils/*` - shared TS utilities.

There is no database server: the engine owns a SQLite file at `apps/engine/data/econsim.db`.

## Engine conventions

- The simulation must stay deterministic: only use `w.rng`, never iterate over sets whose order
  matters, and keep all state on `World` so a pickled snapshot is complete.
- Add goods/processes in `econsim/catalog/goods.py`; run the engine tests to catch dangling references
  and costs that don't cover prices.
