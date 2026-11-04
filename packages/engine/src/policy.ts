/**
 * Policy levers. A policy is a nested object; a decision is a patch applied at a tick. Rewinding
 * to a tick and applying a different patch creates a branch.
 */

export interface Policy {
  /** Marginal rates: <0.5x, 0.5-1.5x, 1.5-4x, >4x median wage */
  income_tax: number[]
  corporate_tax: number
  vat: number
  tariff_general: number
  tariff_by_category: Record<string, number>
  /** $ per tonne CO2 */
  carbon_tax: number
  /** annual, on housing rents x 12 x 15 */
  property_tax: number
  /** spending as a share of trend GDP */
  spend_education: number
  education_tertiary_share: number
  university_fields: Record<string, number>
  spend_health: number
  spend_research: number
  research_fields: Record<string, number>
  spend_infrastructure: number
  infrastructure_split: Record<string, number>
  /** region id -> weight (default: by population) */
  infrastructure_regions: Record<string, number>
  spend_admin: number
  unemployment_benefit: number
  pension_rate: number
  retirement_age: number
  child_benefit: number
  minimum_wage: number
  /** good id or category -> share of price */
  subsidies_producer: Record<string, number>
  subsidies_consumer: Record<string, number>
  rd_tax_credit: number
  industrial_policy: string[]
  fdi_openness: number
  import_bans: string[]
  skilled_immigration: number
  business_entry_cost: number
  firing_cost_months: number
  zoning_density: number
  housing_subsidy: number
  urban_expansion: number
  policy_rate_mode: "taylor" | "fixed"
  policy_rate: number
  inflation_target: number
  bank_capital_ratio: number
}

export type PolicyPatch = Record<string, unknown>

export const DEFAULT: Policy = {
  income_tax: [0.0, 0.15, 0.27, 0.38],
  corporate_tax: 0.22,
  vat: 0.15,
  tariff_general: 0.06,
  tariff_by_category: {},
  carbon_tax: 0.0,
  property_tax: 0.008,
  spend_education: 0.045,
  education_tertiary_share: 0.25,
  university_fields: {
    mech: 1,
    elec: 1,
    chem: 1,
    cs: 1,
    civil: 1,
    science: 1,
    bio: 0.6,
    med: 0.8,
    business: 1.5,
    law: 0.5,
    education: 1,
    arts: 0.6,
    agri: 0.5,
    trades: 1.5,
    elec_tech: 1.2,
    chem_tech: 0.8,
    health: 1.2,
  },
  spend_health: 0.045,
  spend_research: 0.006,
  research_fields: {
    agri: 1,
    mech: 1,
    metal: 1,
    chem: 1,
    elec: 1,
    cs: 1,
    bio: 1,
    phys: 1,
    civil: 0.5,
    med: 1,
    textile: 0.3,
    mgmt: 0.3,
  },
  spend_infrastructure: 0.03,
  infrastructure_split: {
    road: 0.35,
    rail: 0.12,
    port: 0.08,
    grid: 0.2,
    broadband: 0.08,
    transit: 0.1,
    irrigation: 0.07,
  },
  infrastructure_regions: {},
  spend_admin: 0.05,
  unemployment_benefit: 0.4,
  pension_rate: 0.3,
  retirement_age: 65,
  child_benefit: 0.02,
  minimum_wage: 0.4,
  subsidies_producer: {},
  subsidies_consumer: {},
  rd_tax_credit: 0.1,
  industrial_policy: [],
  fdi_openness: 0.5,
  import_bans: [],
  skilled_immigration: 0,
  business_entry_cost: 20000.0,
  firing_cost_months: 1.0,
  zoning_density: 1.0,
  housing_subsidy: 0.0,
  urban_expansion: 1.0,
  policy_rate_mode: "taylor",
  policy_rate: 0.04,
  inflation_target: 0.02,
  bank_capital_ratio: 0.08,
}

export interface SchemaItem {
  key: keyof Policy
  type: "brackets" | "pct" | "num" | "map_pct" | "map_num" | "list" | "choice"
  label: string
  help?: string
  min?: number
  max?: number
  step?: number
  domain?: string
  choices?: string[]
}

export const SCHEMA: { group: string; items: SchemaItem[] }[] = [
  {
    group: "Taxes",
    items: [
      {
        key: "income_tax",
        type: "brackets",
        label: "Income tax brackets",
        help: "Marginal rates for monthly income below 0.5x, 0.5-1.5x, 1.5-4x and above 4x the median wage.",
      },
      {
        key: "corporate_tax",
        type: "pct",
        min: 0,
        max: 0.6,
        label: "Corporate profit tax",
      },
      {
        key: "vat",
        type: "pct",
        min: 0,
        max: 0.3,
        label: "VAT / sales tax",
      },
      {
        key: "tariff_general",
        type: "pct",
        min: 0,
        max: 1.0,
        label: "General import tariff",
      },
      {
        key: "tariff_by_category",
        type: "map_pct",
        domain: "categories",
        label: "Extra tariffs by category",
      },
      {
        key: "carbon_tax",
        type: "num",
        min: 0,
        max: 300,
        step: 5,
        label: "Carbon tax ($/t CO2)",
      },
      {
        key: "property_tax",
        type: "pct",
        min: 0,
        max: 0.03,
        step: 0.001,
        label: "Property tax (annual)",
      },
    ],
  },
  {
    group: "Public spending (% of GDP)",
    items: [
      {
        key: "spend_education",
        type: "pct",
        min: 0,
        max: 0.12,
        step: 0.0025,
        label: "Education",
      },
      {
        key: "education_tertiary_share",
        type: "pct",
        min: 0.05,
        max: 0.6,
        label: "Share of education budget for universities & vocational",
      },
      {
        key: "university_fields",
        type: "map_num",
        domain: "fields",
        min: 0,
        max: 5,
        step: 0.1,
        label: "University seats by field (weights)",
      },
      {
        key: "spend_health",
        type: "pct",
        min: 0,
        max: 0.15,
        step: 0.0025,
        label: "Healthcare",
      },
      {
        key: "spend_research",
        type: "pct",
        min: 0,
        max: 0.05,
        step: 0.001,
        label: "Public research",
      },
      {
        key: "research_fields",
        type: "map_num",
        domain: "research_fields",
        min: 0,
        max: 5,
        step: 0.1,
        label: "Research priorities (weights)",
      },
      {
        key: "spend_infrastructure",
        type: "pct",
        min: 0,
        max: 0.1,
        step: 0.0025,
        label: "Infrastructure",
      },
      {
        key: "infrastructure_split",
        type: "map_num",
        domain: "infra",
        min: 0,
        max: 1,
        step: 0.01,
        label: "Infrastructure mix",
      },
      {
        key: "infrastructure_regions",
        type: "map_num",
        domain: "regions",
        min: 0,
        max: 5,
        step: 0.1,
        label: "Infrastructure by region (weights)",
      },
      {
        key: "spend_admin",
        type: "pct",
        min: 0.01,
        max: 0.15,
        step: 0.0025,
        label: "Administration, police & defense",
      },
    ],
  },
  {
    group: "Social insurance",
    items: [
      {
        key: "unemployment_benefit",
        type: "pct",
        min: 0,
        max: 0.9,
        label: "Unemployment benefit (replacement rate)",
      },
      {
        key: "pension_rate",
        type: "pct",
        min: 0,
        max: 0.9,
        label: "Pension (share of average wage)",
      },
      {
        key: "retirement_age",
        type: "num",
        min: 55,
        max: 75,
        step: 1,
        label: "Retirement age",
      },
      {
        key: "child_benefit",
        type: "pct",
        min: 0,
        max: 0.2,
        step: 0.005,
        label: "Child benefit (share of avg wage, per child)",
      },
      {
        key: "minimum_wage",
        type: "pct",
        min: 0,
        max: 0.9,
        label: "Minimum wage (share of median)",
      },
    ],
  },
  {
    group: "Industrial policy",
    items: [
      {
        key: "subsidies_producer",
        type: "map_pct",
        domain: "goods_and_categories",
        label: "Producer subsidies (share of price)",
      },
      {
        key: "subsidies_consumer",
        type: "map_pct",
        domain: "goods_and_categories",
        label: "Consumer purchase subsidies",
      },
      {
        key: "rd_tax_credit",
        type: "pct",
        min: 0,
        max: 1.0,
        label: "R&D tax credit",
      },
      {
        key: "industrial_policy",
        type: "list",
        domain: "goods_and_categories",
        label: "State-backed industry entry",
      },
      {
        key: "fdi_openness",
        type: "pct",
        min: 0,
        max: 1,
        label: "Openness to foreign direct investment",
      },
      {
        key: "import_bans",
        type: "list",
        domain: "goods_and_categories",
        label: "Import bans",
      },
      {
        key: "skilled_immigration",
        type: "num",
        min: 0,
        max: 50000,
        step: 500,
        label: "Skilled immigrants per year",
      },
      {
        key: "business_entry_cost",
        type: "num",
        min: 0,
        max: 500000,
        step: 5000,
        label: "Business registration cost ($)",
      },
      {
        key: "firing_cost_months",
        type: "num",
        min: 0,
        max: 12,
        step: 0.5,
        label: "Severance (months of wage)",
      },
    ],
  },
  {
    group: "Cities & housing",
    items: [
      {
        key: "zoning_density",
        type: "num",
        min: 0.3,
        max: 4,
        step: 0.1,
        label: "Zoning density (x allowed dwellings per km2)",
      },
      {
        key: "housing_subsidy",
        type: "pct",
        min: 0,
        max: 0.5,
        label: "New housing construction subsidy",
      },
      {
        key: "urban_expansion",
        type: "num",
        min: 0,
        max: 3,
        step: 0.1,
        label: "Urban land release (x)",
      },
    ],
  },
  {
    group: "Money & banking",
    items: [
      {
        key: "policy_rate_mode",
        type: "choice",
        choices: ["taylor", "fixed"],
        label: "Central bank rule",
      },
      {
        key: "policy_rate",
        type: "pct",
        min: 0,
        max: 0.25,
        step: 0.0025,
        label: "Policy rate (if fixed)",
      },
      {
        key: "inflation_target",
        type: "pct",
        min: 0,
        max: 0.1,
        step: 0.0025,
        label: "Inflation target",
      },
      {
        key: "bank_capital_ratio",
        type: "pct",
        min: 0.02,
        max: 0.25,
        step: 0.005,
        label: "Bank capital requirement",
      },
    ],
  },
]

export function defaultPolicy(): Policy {
  return structuredClone(DEFAULT)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Deep-merge a patch into a policy (objects merge, everything else replaces; null deletes). */
export function applyPatch(policy: Policy, patch: PolicyPatch | null | undefined): Policy {
  const out = structuredClone(policy) as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(patch ?? {})) {
    const cur = out[k]
    if (isObj(v) && isObj(cur)) {
      const d: Record<string, unknown> = { ...cur }
      for (const [kk, vv] of Object.entries(v)) {
        if (vv === null) delete d[kk]
        else d[kk] = vv
      }
      out[k] = d
    } else out[k] = structuredClone(v)
  }
  return out as unknown as Policy
}

/** Rate for a good from a {good-or-category: rate} map (good wins). */
export function lookupRate(
  mapping: Record<string, number> | undefined,
  good: string,
  cat: string,
): number {
  if (!mapping) return 0
  if (good in mapping) return Number(mapping[good])
  return Number(mapping[cat] ?? 0)
}

export function inList(lst: string[] | undefined, good: string, cat: string): boolean {
  return !!lst && lst.length > 0 && (lst.includes(good) || lst.includes(cat))
}
