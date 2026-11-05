# Organizational learning and demographic transition

## Three stocks of knowledge

Individual skills travel with the person. National understanding represents science, literature
and broad spillovers. A firm's process-specific organizational history represents accumulated
experiments, routines, tooling integration, quality control and coordination. Hiring a skilled
engineer improves research effort; it never copies the old employer's history into the new firm.
An incumbent retains organizational history when an employee leaves. A bankrupt firm's history
is lost unless an explicit future acquisition/transfer mechanism preserves the organization.

Each modeled technology has a tacit share, calendar months per feedback cycle, cycles to master
and (for selected advancing sectors) years per frontier generation. Every existing modeled
knowledge node has a profile; explicit profiles distinguish combustion engines, turbines,
batteries, semiconductor processes, processors and civilian nuclear power. The bottleneck
technique sets a process's validation schedule. This is a **cold-start organizational schedule**
with adequate staff, understood science, obtainable tools and inputs, not the time civilization
needs to invent every prerequisite from scratch.

| Technology                | Months per cycle | Cycles to master | Minimum organizational validation |
| ------------------------- | ---------------: | ---------------: | --------------------------------: |
| Lithium-ion batteries     |                6 |               12 |                           6 years |
| Internal combustion       |                9 |               12 |                           9 years |
| Jet propulsion            |               18 |               12 |                          18 years |
| FinFET                    |               12 |               14 |                          14 years |
| EUV lithography           |               18 |               16 |                          24 years |
| Civilian nuclear reactors |               24 |               10 |                          20 years |

**These numbers and the 0–100 display ranking are tunable model assumptions, not empirical
estimates, historical durations, forecasts or country scores.** The score combines log-scaled
validation years, tacitness and existing research-effort difficulty. It is a display index; the
underlying cycles and actual research effort govern behavior. Weak staffing, failed R&D,
missing inputs, weak national science, finance or a moving frontier can extend the timeline.

A month of adequately staffed R&D or normal production earns at most one calendar month toward
the next feedback cycle. More engineers help reach capacity but cannot compress a physical
18-month loop to a week. Calling the updater twice in one tick earns no extra time. Idle firms
and firms unable to validate earn no time; existing routines slowly decay during inactivity.
Incomplete cycles provide no completed-cycle credit. Histories are keyed by process, preventing
experience in one route from instantly mastering another. This is deliberately conservative:
related-process transfer and genuine acquisition of an intact organization are not modeled yet.

The firm's design progress is bounded by its validated maturity and the technology's tacit
share. Imports and national spillovers offer smaller research shortcuts for highly tacit fields.
Completed designs also face a productivity penalty while organizational routines are immature.
Design-generation improvements require another completed cycle, including improvements from
buying/licensing machines. Selected fast-moving frontiers continue beyond eight generations.
New high-tacit entrants must develop their own process even when another domestic firm makes
the same product; foreign ownership also cannot bypass this requirement. Startup financing
budgets include a one-cohort wage allowance for the modeled validation runway rather than only six months;
funding still depends on the existing credit/equity/state/parent-company mechanisms. Survival
and success remain uncertain.

Seeded incumbents explicitly receive up to 25 years of process prehistory, consistent with the
existing scenario seed's cumulative output. Entry does not receive this seed. Histories are
plain data on `Firm`, preserved in snapshots; burn-in resets their tick guards with the clock.

## Population is a growing set of weighted cohorts

The initial approximately 5,000 agents are a sample, not a permanent population cap. A person
represents `World.scale` residents; represented population is the current agent count times
that scale. Births and immigration create agents. Deaths and emigration delete them. The
weight stays fixed: growth expands the number of cohorts, rather than inflating each cohort's
weight. Dashboard metrics expose agent count and weight as well as represented population.

New worlds sample an explicit female/male reproductive cohort at birth and scenario creation.
This demographic marker only controls birth eligibility; it does not restrict schooling,
occupation or employment. Births are sampled among women aged 20–44. Over that 25-year window,
the monthly birth probability is TFR / 300. The prior approximation sampled all adults at half
that rate. Education in the fertility curve now measures women's schooling in that cohort,
rather than an all-adult mean. Income, urbanization and child benefits also remain in the curve.
The dashboard shows the cohort's average schooling and an approximate 2.1 replacement reference.

Below-replacement fertility changes future cohort sizes; it does not instantly stop population
growth. A large young cohort, falling mortality and net immigration can sustain growth for years
or decades. Women's education is one driver in this stylized curve, not a complete causal account:
housing, childcare costs, reproductive choice and work/family conditions need richer modeling.
No country-specific or innate ability modifier is introduced.

## Evidence informing the mechanism, not parameter fitting

- [IEA, Global EV Outlook 2025 executive summary](https://www.iea.org/reports/global-ev-outlook-2025/executive-summary): competition, manufacturing efficiency, supply-chain integration and skilled labor contribute to Chinese battery manufacturers' advantage. Battery leadership is not inferred from a country's performance in engines.
- [Process Innovation and Learning by Doing in Semiconductor Manufacturing](https://pubsonline.informs.org/doi/10.1287/mnsc.44.11.1461): learning can be specific to the production environment and can be lost during technology transfer.
- [Knowledge Diffusion through Employee Mobility, Federal Reserve Bank of Minneapolis](https://www.minneapolisfed.org/research/staff-reports/knowledge-diffusion-through-employee-mobility): workers do transmit some know-how. The model preserves portable skills and their effect on research, while keeping firm routines distinct.
- [TSMC 2025 annual report](https://investor.tsmc.com/static/annualReports/2025/english/index.html): technology development, manufacturing capacity and process ramp-up are ongoing organizational activities.
- [UN World Population Prospects 2024 summary](https://desapublications.un.org/file/20847/download): below-replacement fertility, demographic momentum, age structure and migration must be considered together; educational, financial and work/family conditions influence fertility.

The claim that China cannot make good engines because it lacks a century of capitalism is not
a calibration rule. Engine types, performance targets, institutions, accumulated practice and
access to suppliers differ. This implementation uses mechanisms that can produce sector-specific
advantages and changing leadership under investment and practice, not predetermined winners.

## Compatibility and verification

New worlds persist `mechanism_version: 2`. Snapshots without that marker retain legacy fertility,
frontier, productivity and R&D behavior. They do not silently receive synthetic organizational
histories or random sex assignments during replay. Historical metrics can omit the new columns.

Tests cover expert mobility without corporate-memory transfer, calendar limits under extreme R&D
staffing, blocked validation, waiting without learning, process-specific histories, serialization,
frontier advancement, ranking coverage, female education, sub-replacement fertility and birth/population
accounting beyond 5,000 agents, and population momentum followed by decline over 160 years. A separate comparison against the preceding implementation ran a
legacy snapshot for 12 months: selected metrics, RNG and deep world state matched. These checks
establish implementation behavior; the parameters still need empirical calibration and long-run
scenario acceptance. Ten-year runs of the 1850, emerging-2025 and advanced-2025 scenarios kept population accounting exact and economic metrics finite. In the advanced case, fertility reached about 1.46 while population still grew from about 3.0 to 3.07 million, illustrating momentum and migration rather than immediate stagnation.
