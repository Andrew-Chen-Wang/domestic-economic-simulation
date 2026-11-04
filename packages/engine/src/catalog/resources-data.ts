// Natural endowments: deposits, region archetypes, crop agronomy.
export interface DepositSpec {
  kind: "stock" | "renew" | "flow"
  rich: number
  geo: string[]
  regen?: number
}
export const DEPOSITS: Record<string, DepositSpec> = {
  coal: {
    kind: "stock",
    rich: 2000000000.0,
    geo: ["sedimentary"],
  },
  crude_oil: {
    kind: "stock",
    rich: 3000000000.0,
    geo: ["sedimentary", "coastal"],
  },
  natural_gas: {
    kind: "stock",
    rich: 400000000.0,
    geo: ["sedimentary", "coastal"],
  },
  iron: {
    kind: "stock",
    rich: 2000000000.0,
    geo: ["shield", "mountain"],
  },
  copper: {
    kind: "stock",
    rich: 60000000.0,
    geo: ["mountain", "volcanic"],
  },
  bauxite: {
    kind: "stock",
    rich: 500000000.0,
    geo: ["tropical", "shield"],
  },
  nickel: {
    kind: "stock",
    rich: 20000000.0,
    geo: ["volcanic", "shield"],
  },
  zinc_lead: {
    kind: "stock",
    rich: 50000000.0,
    geo: ["mountain", "sedimentary"],
  },
  tin: {
    kind: "stock",
    rich: 2000000.0,
    geo: ["mountain", "tropical"],
  },
  gold: {
    kind: "stock",
    rich: 300000000.0,
    geo: ["shield", "mountain"],
  },
  silver: {
    kind: "stock",
    rich: 300000000.0,
    geo: ["mountain", "volcanic"],
  },
  lithium: {
    kind: "stock",
    rich: 20000000.0,
    geo: ["desert", "mountain"],
  },
  rare_earth: {
    kind: "stock",
    rich: 20000000.0,
    geo: ["shield"],
  },
  uranium: {
    kind: "stock",
    rich: 200000000.0,
    geo: ["shield", "desert"],
  },
  phosphate: {
    kind: "stock",
    rich: 500000000.0,
    geo: ["sedimentary", "desert"],
  },
  potash: {
    kind: "stock",
    rich: 500000000.0,
    geo: ["sedimentary"],
  },
  limestone: {
    kind: "stock",
    rich: 5000000000.0,
    geo: ["sedimentary", "coastal", "mountain"],
  },
  silica: {
    kind: "stock",
    rich: 2000000000.0,
    geo: ["coastal", "desert", "sedimentary"],
  },
  clay: {
    kind: "stock",
    rich: 3000000000.0,
    geo: ["river", "sedimentary", "plains"],
  },
  aggregate: {
    kind: "stock",
    rich: 10000000000.0,
    geo: ["*"],
  },
  salt: {
    kind: "stock",
    rich: 1000000000.0,
    geo: ["coastal", "desert", "sedimentary"],
  },
  sulfur: {
    kind: "stock",
    rich: 50000000.0,
    geo: ["volcanic", "sedimentary"],
  },
  kaolin: {
    kind: "stock",
    rich: 200000000.0,
    geo: ["tropical", "river"],
  },
  gypsum: {
    kind: "stock",
    rich: 500000000.0,
    geo: ["sedimentary", "desert"],
  },
  cobalt: {
    kind: "stock",
    rich: 5000000.0,
    geo: ["shield", "volcanic"],
  },
  manganese: {
    kind: "stock",
    rich: 200000000.0,
    geo: ["shield", "sedimentary"],
  },
  chromium: {
    kind: "stock",
    rich: 100000000.0,
    geo: ["shield", "volcanic"],
  },
  titanium: {
    kind: "stock",
    rich: 100000000.0,
    geo: ["coastal", "shield"],
  },
  tungsten: {
    kind: "stock",
    rich: 1000000.0,
    geo: ["mountain"],
  },
  graphite: {
    kind: "stock",
    rich: 30000000.0,
    geo: ["shield", "mountain"],
  },
  hp_quartz: {
    kind: "stock",
    rich: 5000000.0,
    geo: ["mountain"],
  },
  fluorspar: {
    kind: "stock",
    rich: 50000000.0,
    geo: ["mountain", "volcanic"],
  },
  gems: {
    kind: "stock",
    rich: 50000.0,
    geo: ["shield", "volcanic"],
  },
  pgm: {
    kind: "stock",
    rich: 500000.0,
    geo: ["shield"],
  },
  water: {
    kind: "flow",
    rich: 300000000.0,
    geo: ["*"],
  },
  forest: {
    kind: "renew",
    rich: 400000000.0,
    geo: ["forest", "tropical", "mountain"],
    regen: 0.004,
  },
  fish_stock: {
    kind: "renew",
    rich: 4000000.0,
    geo: ["coastal"],
    regen: 0.03,
  },
  hydro: {
    kind: "flow",
    rich: 4000,
    geo: ["mountain", "river"],
  },
  wind: {
    kind: "flow",
    rich: 20000,
    geo: ["coastal", "plains", "mountain"],
  },
  solar: {
    kind: "flow",
    rich: 80000,
    geo: ["*"],
  },
}

export interface Archetype {
  geo: string[]
  temp: number
  rain: number
  sun: number
  wind: number
  port: boolean
  crop_frac: number
  pasture_frac: number
  forest_frac: number
}
export const ARCHETYPES: Record<string, Archetype> = {
  coastal_plain: {
    geo: ["coastal", "plains", "sedimentary"],
    temp: 16,
    rain: 1100,
    sun: 1.0,
    wind: 1.2,
    port: true,
    crop_frac: 0.35,
    pasture_frac: 0.15,
    forest_frac: 0.1,
  },
  river_valley: {
    geo: ["river", "plains", "sedimentary"],
    temp: 14,
    rain: 800,
    sun: 1.0,
    wind: 0.9,
    port: false,
    crop_frac: 0.55,
    pasture_frac: 0.2,
    forest_frac: 0.08,
  },
  highlands: {
    geo: ["mountain", "volcanic", "forest"],
    temp: 8,
    rain: 1300,
    sun: 0.9,
    wind: 1.1,
    port: false,
    crop_frac: 0.08,
    pasture_frac: 0.25,
    forest_frac: 0.45,
  },
  shield_interior: {
    geo: ["shield", "forest", "plains"],
    temp: 4,
    rain: 600,
    sun: 0.85,
    wind: 1.0,
    port: false,
    crop_frac: 0.12,
    pasture_frac: 0.15,
    forest_frac: 0.5,
  },
  arid_basin: {
    geo: ["desert", "sedimentary", "mountain"],
    temp: 22,
    rain: 250,
    sun: 1.45,
    wind: 1.1,
    port: false,
    crop_frac: 0.04,
    pasture_frac: 0.3,
    forest_frac: 0.01,
  },
  tropical_coast: {
    geo: ["tropical", "coastal", "river"],
    temp: 26,
    rain: 2000,
    sun: 1.15,
    wind: 0.8,
    port: true,
    crop_frac: 0.3,
    pasture_frac: 0.1,
    forest_frac: 0.4,
  },
  temperate_plains: {
    geo: ["plains", "sedimentary", "river"],
    temp: 11,
    rain: 650,
    sun: 1.05,
    wind: 1.3,
    port: false,
    crop_frac: 0.6,
    pasture_frac: 0.2,
    forest_frac: 0.05,
  },
}

// crop: [optimal temp, tolerance, optimal rain, tolerance]
export const CROPS: Record<string, [number, number, number, number]> = {
  wheat: [12, 7, 650, 350],
  rice: [25, 5, 1600, 600],
  maize: [20, 6, 800, 400],
  soybeans: [21, 6, 800, 400],
  potatoes: [13, 6, 700, 350],
  vegetables: [17, 8, 800, 500],
  fruit: [18, 8, 900, 500],
  sugarcane: [26, 4, 1600, 600],
  sugar_beet: [11, 6, 650, 350],
  cotton: [24, 5, 800, 500],
  coffee_beans: [21, 3, 1800, 600],
  cocoa_beans: [26, 3, 2000, 600],
  tea_leaves: [19, 5, 1800, 600],
  tobacco_leaf: [20, 6, 900, 400],
  grapes: [16, 5, 600, 300],
  oilseeds: [16, 9, 800, 500],
  natural_rubber: [27, 3, 2200, 600],
  flax_hemp: [12, 6, 700, 350],
  seeds: [15, 8, 750, 400],
  hay_fodder: [12, 10, 800, 500],
  cattle: [14, 12, 800, 600],
  raw_milk: [12, 10, 900, 500],
  wool: [10, 12, 600, 500],
  horses: [12, 12, 700, 500],
}

export const REGION_NAMES = [
  "Harborview",
  "Ashford Vale",
  "Stonecrest",
  "Northmere",
  "Saltmarsh",
  "Redlands",
  "Greenhollow",
  "Ironridge",
  "Brightwater",
  "Eastreach",
  "Kestrel Bay",
  "Millbrook",
  "Westmarch",
  "Sunfield",
  "Highgate",
]
