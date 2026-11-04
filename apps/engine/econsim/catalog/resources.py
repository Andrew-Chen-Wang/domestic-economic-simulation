"""Natural endowments: geological deposits, renewable stocks, energy flows and
crop climate requirements.

Deposits are generated per region from geology archetypes. Nothing here says
"region X is good at Y" - it only says what is physically in the ground, how
rich it is and how hard it is to reach. Which industries appear is up to the
simulation.
"""

# kind: stock (depletes) | renew (regrows to a carrying capacity) | flow (site
# capacity, never depletes). `qty` is in output units of the extracting good.
# `rich` is the typical deposit size for a well-endowed region.
DEPOSITS = {
    "coal":        {"kind": "stock", "rich": 2.0e9, "geo": ["sedimentary"]},
    "crude_oil":   {"kind": "stock", "rich": 3.0e9, "geo": ["sedimentary", "coastal"]},
    "natural_gas": {"kind": "stock", "rich": 4.0e8, "geo": ["sedimentary", "coastal"]},
    "iron":        {"kind": "stock", "rich": 2.0e9, "geo": ["shield", "mountain"]},
    "copper":      {"kind": "stock", "rich": 6.0e7, "geo": ["mountain", "volcanic"]},
    "bauxite":     {"kind": "stock", "rich": 5.0e8, "geo": ["tropical", "shield"]},
    "nickel":      {"kind": "stock", "rich": 2.0e7, "geo": ["volcanic", "shield"]},
    "zinc_lead":   {"kind": "stock", "rich": 5.0e7, "geo": ["mountain", "sedimentary"]},
    "tin":         {"kind": "stock", "rich": 2.0e6, "geo": ["mountain", "tropical"]},
    "gold":        {"kind": "stock", "rich": 3.0e8, "geo": ["shield", "mountain"]},
    "silver":      {"kind": "stock", "rich": 3.0e8, "geo": ["mountain", "volcanic"]},
    "lithium":     {"kind": "stock", "rich": 2.0e7, "geo": ["desert", "mountain"]},
    "rare_earth":  {"kind": "stock", "rich": 2.0e7, "geo": ["shield"]},
    "uranium":     {"kind": "stock", "rich": 2.0e8, "geo": ["shield", "desert"]},
    "phosphate":   {"kind": "stock", "rich": 5.0e8, "geo": ["sedimentary", "desert"]},
    "potash":      {"kind": "stock", "rich": 5.0e8, "geo": ["sedimentary"]},
    "limestone":   {"kind": "stock", "rich": 5.0e9, "geo": ["sedimentary", "coastal", "mountain"]},
    "silica":      {"kind": "stock", "rich": 2.0e9, "geo": ["coastal", "desert", "sedimentary"]},
    "clay":        {"kind": "stock", "rich": 3.0e9, "geo": ["river", "sedimentary", "plains"]},
    "aggregate":   {"kind": "stock", "rich": 1.0e10, "geo": ["*"]},
    "salt":        {"kind": "stock", "rich": 1.0e9, "geo": ["coastal", "desert", "sedimentary"]},
    "sulfur":      {"kind": "stock", "rich": 5.0e7, "geo": ["volcanic", "sedimentary"]},
    "kaolin":      {"kind": "stock", "rich": 2.0e8, "geo": ["tropical", "river"]},
    "gypsum":      {"kind": "stock", "rich": 5.0e8, "geo": ["sedimentary", "desert"]},
    "cobalt":      {"kind": "stock", "rich": 5.0e6, "geo": ["shield", "volcanic"]},
    "manganese":   {"kind": "stock", "rich": 2.0e8, "geo": ["shield", "sedimentary"]},
    "chromium":    {"kind": "stock", "rich": 1.0e8, "geo": ["shield", "volcanic"]},
    "titanium":    {"kind": "stock", "rich": 1.0e8, "geo": ["coastal", "shield"]},
    "tungsten":    {"kind": "stock", "rich": 1.0e6, "geo": ["mountain"]},
    "graphite":    {"kind": "stock", "rich": 3.0e7, "geo": ["shield", "mountain"]},
    "hp_quartz":   {"kind": "stock", "rich": 5.0e6, "geo": ["mountain"]},
    "fluorspar":   {"kind": "stock", "rich": 5.0e7, "geo": ["mountain", "volcanic"]},
    "gems":        {"kind": "stock", "rich": 5.0e4, "geo": ["shield", "volcanic"]},
    "pgm":         {"kind": "stock", "rich": 5.0e5, "geo": ["shield"]},
    "water":       {"kind": "flow",  "rich": 3.0e8, "geo": ["*"]},
    "forest":      {"kind": "renew", "rich": 4.0e8, "geo": ["forest", "tropical", "mountain"], "regen": 0.004},
    "fish_stock":  {"kind": "renew", "rich": 4.0e6, "geo": ["coastal"], "regen": 0.03},
    "hydro":       {"kind": "flow",  "rich": 4000, "geo": ["mountain", "river"]},
    "wind":        {"kind": "flow",  "rich": 20000, "geo": ["coastal", "plains", "mountain"]},
    "solar":       {"kind": "flow",  "rich": 80000, "geo": ["*"]},
}

# Region geology/climate archetypes. temp in deg C (annual mean), rain mm/yr,
# sun = solar capacity-factor multiplier, wind = wind CF multiplier.
ARCHETYPES = {
    "coastal_plain":   {"geo": ["coastal", "plains", "sedimentary"], "temp": 16, "rain": 1100, "sun": 1.0, "wind": 1.2, "port": True,  "crop_frac": 0.35, "pasture_frac": 0.15, "forest_frac": 0.10},
    "river_valley":    {"geo": ["river", "plains", "sedimentary"],   "temp": 14, "rain": 800,  "sun": 1.0, "wind": 0.9, "port": False, "crop_frac": 0.55, "pasture_frac": 0.20, "forest_frac": 0.08},
    "highlands":       {"geo": ["mountain", "volcanic", "forest"],   "temp": 8,  "rain": 1300, "sun": 0.9, "wind": 1.1, "port": False, "crop_frac": 0.08, "pasture_frac": 0.25, "forest_frac": 0.45},
    "shield_interior": {"geo": ["shield", "forest", "plains"],       "temp": 4,  "rain": 600,  "sun": 0.85,"wind": 1.0, "port": False, "crop_frac": 0.12, "pasture_frac": 0.15, "forest_frac": 0.50},
    "arid_basin":      {"geo": ["desert", "sedimentary", "mountain"],"temp": 22, "rain": 250,  "sun": 1.45,"wind": 1.1, "port": False, "crop_frac": 0.04, "pasture_frac": 0.30, "forest_frac": 0.01},
    "tropical_coast":  {"geo": ["tropical", "coastal", "river"],     "temp": 26, "rain": 2000, "sun": 1.15,"wind": 0.8, "port": True,  "crop_frac": 0.30, "pasture_frac": 0.10, "forest_frac": 0.40},
    "temperate_plains":{"geo": ["plains", "sedimentary", "river"],   "temp": 11, "rain": 650,  "sun": 1.05,"wind": 1.3, "port": False, "crop_frac": 0.60, "pasture_frac": 0.20, "forest_frac": 0.05},
}

# Crop agronomy: optimal temperature, tolerance, optimal rainfall, tolerance.
# Irrigation infrastructure tops up effective rainfall.
CROPS = {
    "wheat":         (12, 7, 650, 350),
    "rice":          (25, 5, 1600, 600),
    "maize":         (20, 6, 800, 400),
    "soybeans":      (21, 6, 800, 400),
    "potatoes":      (13, 6, 700, 350),
    "vegetables":    (17, 8, 800, 500),
    "fruit":         (18, 8, 900, 500),
    "sugarcane":     (26, 4, 1600, 600),
    "sugar_beet":    (11, 6, 650, 350),
    "cotton":        (24, 5, 800, 500),
    "coffee_beans":  (21, 3, 1800, 600),
    "cocoa_beans":   (26, 3, 2000, 600),
    "tea_leaves":    (19, 5, 1800, 600),
    "tobacco_leaf":  (20, 6, 900, 400),
    "grapes":        (16, 5, 600, 300),
    "oilseeds":      (16, 9, 800, 500),
    "natural_rubber":(27, 3, 2200, 600),
    "flax_hemp":     (12, 6, 700, 350),
    "seeds":         (15, 8, 750, 400),
    "hay_fodder":    (12, 10, 800, 500),
    "cattle":        (14, 12, 800, 600),
    "raw_milk":      (12, 10, 900, 500),
    "wool":          (10, 12, 600, 500),
    "horses":        (12, 12, 700, 500),
}

REGION_NAMES = [
    "Harborview", "Ashford Vale", "Stonecrest", "Northmere", "Saltmarsh",
    "Redlands", "Greenhollow", "Ironridge", "Brightwater", "Eastreach",
    "Kestrel Bay", "Millbrook", "Westmarch", "Sunfield", "Highgate",
]
