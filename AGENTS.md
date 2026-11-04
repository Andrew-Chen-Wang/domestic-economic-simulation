## Build Commands

All tools (Node 26, pnpm) come from mise: `.config/mise.toml`.

```bash
mise install && pnpm install     # setup
mise run dev                     # website + in-process engine on :3000
mise run test                    # vitest (engine + API)

pnpm run format                  # Oxfmt with .config/oxfmt.config.mts
pnpm run lint                    # Oxlint (type-aware) with auto-fix
```

## Architecture

pnpm monorepo, all TypeScript:

- `packages/engine` (`@econsim/engine`) - the simulation. `src/catalog` (goods, processes,
  knowledge, occupations, deposits), `world.ts` (state + scenario generation), `physical.ts`,
  `sim.ts` (monthly economic step), `demography.ts`, `knowledge-engine.ts`, `rng.ts` (serializable
  PRNG), `store.ts` (node:sqlite: timelines, snapshots, ledger), `engine.ts` (run / fork / replay),
  `api.ts` (framework-agnostic handlers whose return types the dashboard imports).
- `apps/internal-api` - Hono router mounted at `/api` by the website; calls the engine in-process
  (`getEngine()` is a process-wide singleton).
- `apps/website` - Next.js 16. `src/components/dashboard` holds the typed React dashboard: `state.tsx`
  (context: timelines, cursor, jobs), `charts.tsx` (SVG charts + tooltip), `views/*`.
- `lib/typescript/utils/*` - shared TS utilities.

There is no database server: the engine owns a SQLite file at `<repo>/data/econsim.db`
(`ECONSIM_DB` overrides).

## Engine conventions

- The simulation must stay deterministic: only draw randomness from `w.rng` (via `rng.ts`), and
  keep all state on `World` as plain data (Maps, Sets, arrays, records) so `structuredClone` /
  `v8.serialize` produce a complete snapshot. No class instances or functions in `World`.
- Iteration order matters for determinism: Maps and string-keyed records iterate in insertion order.
- The engine was ported from Python; `a || b` intentionally treats 0 as missing (Python `or`), so
  `prefer-nullish-coalescing` is off for `packages/engine`.
- Add goods/processes in `packages/engine/src/catalog/goods-data.ts`; run the tests to catch
  dangling references and costs that don't cover prices.
