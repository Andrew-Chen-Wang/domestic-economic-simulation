# Real-world detail catalog

The target is **10,000–50,000 goods and services, at least 10,000 distinct occupations,
and much deeper knowledge and process coverage**. Imported names alone do not meet the
simulation requirement. These records are a searchable source foundation, separate from
`Catalog.goods`, `Catalog.procs`, `Catalog.knowledge`, `Catalog.occupations` and `World`.
Existing scenario economics and replay behavior are unchanged.

| Category    | Imported records | Scope                                                                 |
| ----------- | ---------------: | --------------------------------------------------------------------- |
| Goods       |           19,650 | USITC HTS 2026 Basic Edition, ten-digit commodities in chapters 01–97 |
| Occupations |           12,740 | US Department of Labor DOT, revised fourth edition, 1991              |
| Knowledge   |           27,969 | NLM MeSH 2026 descriptors outside the E tree                          |
| Procedures  |            3,141 | NLM MeSH 2026 E-tree medical techniques and procedures                |

These are distinct **source identifiers**, not generated names. Commodity headings, special
customs provisions and occupational aliases are excluded. Different commodity codes may
still represent specifications within a product family, and different occupations can have
similar titles in different industries. Counts must not be described as independent calibrated
production chains, current jobs, industrial recipes, or research-ready technology nodes.
MeSH knowledge coverage is biomedical, not a comprehensive account of human knowledge.
Medical procedures are not industrial manufacturing processes. Services still need their own
classification source. DOT is historical and must be supplemented with modern occupations.

`parents` are source taxonomy relationships, not economic dependencies or research prerequisites.
A MeSH parent can be in either the knowledge or procedure file. HTS names retain the complete
indentation context so that a leaf called “Other” can be understood. HTS source measurement
units are preserved without interpreting them as the engine's units or prices.

## Rebuild

```sh
mise exec -- pnpm exec tsx packages/engine/scripts/import-reference.ts
pnpm run format
# Optional existing source cache:
mise exec -- pnpm exec tsx packages/engine/scripts/import-reference.ts /tmp/econsim-catalog-sources
```

The importer uses only Node built-ins. It stores downloaded originals outside the repository,
sorts by stable source ID, checks completeness and uniqueness, and records SHA-256 hashes and
source URLs in `manifest.json`. It does not run during startup, fetch live data during a simulation,
or use the simulation PRNG. Sources are pinned to named editions; a source refresh is an explicit
regeneration, with a diff and test review. DOL HTML can change independently of its historical
content, so raw-page hashes can change on a rebuild even if normalized records do not.

## Sources

- [USITC 2026 Basic Edition](https://www.usitc.gov/2026_hts_basic_edition)
- [US Department of Labor DOT library](https://www.dol.gov/agencies/oalj/topics/libraries/LIBDOT)
- [NLM MeSH downloads](https://www.nlm.nih.gov/databases/download/mesh.html)

## Model integration still required

Promote sourced detail into the model in coherent supply-chain batches. For each new good,
provide explicit units, mass, price assumptions, consumer demand allocation, production routes,
inputs and substitutes, capital equipment and throughput, energy, emissions, labor occupations,
skill requirements, physical constraints and knowledge dependencies. Imported descriptions do
not establish these quantities. Occupations need education/field access, skill transfer, training
and wage assumptions, plus actual process demand. Knowledge needs justified prerequisites,
frontier dates, research fields and invention effort. Medical procedures need modeled service
outputs, equipment, consumables and staffing.

Before scaling active catalogs, benchmark world creation, monthly steps, memory, snapshot size,
API payloads and browser responsiveness; avoid scanning every occupation for every person or
materializing every possible firm. Version catalogs in saved timelines before changing their
meaning, preserve deterministic order, and test replay with both existing and new catalogs.
Do not mass-clone the current 563 recipes or 43 occupations to advertise these counts as modeled.
