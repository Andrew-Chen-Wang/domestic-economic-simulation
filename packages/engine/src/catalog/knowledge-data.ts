// Knowledge graph. kind: sci | eng | proc. year: when the world frontier reached it.
// diff: person-years to invent at the frontier. field: who can research it.
export const TABLE = String.raw`
# id                  | name                                   | kind | year  | diff  | prereqs                                   | field
agriculture           | Settled agriculture                     | sci  | -8000 | 50    |                                           | agri
animal_husbandry      | Animal husbandry                        | sci  | -7000 | 50    | agriculture                               | agri
irrigation            | Irrigation engineering                  | eng  | -5000 | 80    | agriculture                               | civil
pottery               | Pottery and kilns                       | proc | -6000 | 40    |                                           | chem
weaving               | Spinning and weaving                    | proc | -5000 | 40    |                                           | textile
carpentry             | Carpentry and joinery                   | proc | -5000 | 40    |                                           | mech
masonry               | Masonry and building                    | proc | -4000 | 60    |                                           | civil
bronze_metallurgy     | Bronze metallurgy                       | proc | -3000 | 80    | pottery                                   | metal
smithing              | Iron smithing                           | proc | -1200 | 100   | bronze_metallurgy                         | metal
mining_basic          | Underground mining                      | proc | -3000 | 60    |                                           | metal
glassmaking           | Glassmaking                             | proc | -1500 | 80    | pottery                                   | chem
fermentation          | Brewing and fermentation                | proc | -4000 | 30    | agriculture                               | bio
grain_milling         | Grain milling                           | proc | -3000 | 30    | agriculture                               | mech
tanning               | Leather tanning                         | proc | -3000 | 30    | animal_husbandry                          | chem
dyeing                | Textile dyeing                          | proc | -2000 | 40    | weaving                                   | chem
soapmaking            | Soapmaking                              | proc | -800  | 30    |                                           | chem
shipbuilding          | Wooden shipbuilding and sailing         | eng  | -2000 | 200   | carpentry                                 | mech
papermaking           | Papermaking                             | proc | 105   | 60    | weaving                                   | chem
distillation          | Distillation                            | proc | 800   | 60    | fermentation glassmaking                  | chem
printing              | Movable-type printing                   | eng  | 1450  | 150   | papermaking smithing                      | mech
accounting            | Double-entry accounting                 | sci  | 1494  | 80    |                                           | mgmt
clockmaking           | Clockmaking / fine mechanics            | eng  | 1500  | 300   | smithing                                  | mech
optics                | Optics and lens grinding                | sci  | 1600  | 300   | glassmaking                               | phys
medicine_traditional  | Traditional medicine                    | sci  | 1000  | 100   |                                           | med
classical_mechanics   | Classical mechanics                     | sci  | 1687  | 500   | optics                                    | phys
calculus              | Calculus and analytic mathematics       | sci  | 1690  | 400   |                                           | phys
coke_ironmaking       | Coke-fired ironmaking                   | proc | 1709  | 300   | smithing mining_basic                     | metal
steam_power           | Steam engines                           | eng  | 1769  | 800   | smithing classical_mechanics              | mech
mechanized_textiles   | Mechanized spinning and weaving         | eng  | 1771  | 500   | weaving clockmaking                       | textile
modern_chemistry      | Modern chemistry (elements, reactions)  | sci  | 1789  | 800   | distillation                              | chem
puddling              | Puddling (wrought iron)                 | proc | 1784  | 200   | coke_ironmaking                           | metal
machine_tools         | Machine tools (screw-cutting lathe)     | eng  | 1800  | 900   | clockmaking steam_power                   | mech
canning               | Food preservation and canning           | proc | 1810  | 150   | smithing                                  | bio
thermodynamics        | Thermodynamics                          | sci  | 1824  | 1200  | classical_mechanics calculus              | phys
portland_cement       | Portland cement                         | proc | 1824  | 250   | masonry modern_chemistry                  | chem
railways              | Railways                                | eng  | 1825  | 900   | steam_power puddling                      | civil
electromagnetism      | Electromagnetism                        | sci  | 1831  | 1500  | calculus modern_chemistry                 | phys
telegraphy            | Telegraphy                              | eng  | 1837  | 400   | electromagnetism                          | elec
photography           | Photography                             | proc | 1839  | 300   | optics modern_chemistry                   | chem
vulcanization         | Rubber vulcanization                    | proc | 1844  | 200   | modern_chemistry                          | chem
sewing_machinery      | Sewing machines                         | eng  | 1846  | 300   | machine_tools                             | mech
anesthesia_surgery    | Anesthesia and modern surgery           | sci  | 1846  | 500   | modern_chemistry medicine_traditional     | med
precision_metrology   | Precision metrology (micrometer, gauges)| eng  | 1850  | 600   | machine_tools                             | mech
bessemer_steel        | Bessemer / open-hearth steelmaking      | proc | 1856  | 700   | coke_ironmaking modern_chemistry          | metal
organic_chemistry     | Organic chemistry                       | sci  | 1856  | 1500  | modern_chemistry                          | chem
petroleum_refining    | Petroleum refining                      | proc | 1859  | 500   | distillation organic_chemistry            | chem
germ_theory           | Germ theory of disease                  | sci  | 1862  | 1200  | optics modern_chemistry                   | med
pasteurization        | Pasteurization / food hygiene           | proc | 1864  | 200   | germ_theory                               | bio
dynamite_explosives   | Industrial explosives                   | proc | 1867  | 400   | organic_chemistry                         | chem
refrigeration         | Mechanical refrigeration                | eng  | 1876  | 600   | thermodynamics machine_tools              | mech
telephone             | Telephone                               | eng  | 1876  | 700   | telegraphy                                | elec
internal_combustion   | Internal combustion engine              | eng  | 1876  | 1500  | thermodynamics machine_tools petroleum_refining | mech
sound_recording       | Sound recording                         | eng  | 1877  | 300   | electromagnetism                          | elec
electric_lighting     | Electric lighting                       | eng  | 1879  | 600   | electromagnetism glassmaking              | elec
electric_power        | Electric power generation and grids     | eng  | 1882  | 2000  | electromagnetism steam_power              | elec
vaccines              | Vaccines                                | sci  | 1885  | 1500  | germ_theory                               | med
aluminum_electrolysis | Hall-Heroult aluminum smelting          | proc | 1886  | 800   | electric_power modern_chemistry           | metal
electric_motors       | Electric motors (AC induction)          | eng  | 1888  | 1200  | electric_power                            | elec
pneumatic_tires       | Pneumatic tires                         | proc | 1888  | 200   | vulcanization                             | chem
x_rays                | X-ray imaging                           | sci  | 1895  | 600   | electromagnetism                          | phys
radio                 | Radio                                   | eng  | 1897  | 1500  | electromagnetism telegraphy               | elec
diesel_engine         | Diesel engine                           | eng  | 1897  | 1000  | internal_combustion                       | mech
alloy_metallurgy      | Alloy steels and metallography          | sci  | 1900  | 1500  | bessemer_steel modern_chemistry           | metal
aviation              | Powered flight / aeronautics            | eng  | 1903  | 2500  | internal_combustion classical_mechanics   | mech
vacuum_tubes          | Vacuum tubes and electronics            | eng  | 1906  | 1500  | radio electric_lighting                   | elec
synthetic_polymers    | Synthetic polymers (Bakelite)           | sci  | 1907  | 1500  | organic_chemistry                         | chem
mass_production       | Moving assembly line / mass production  | eng  | 1913  | 800   | machine_tools electric_motors precision_metrology | mgmt
haber_bosch           | Haber-Bosch ammonia synthesis           | proc | 1913  | 2500  | modern_chemistry thermodynamics alloy_metallurgy | chem
stainless_steel       | Stainless steel                         | proc | 1913  | 600   | alloy_metallurgy                          | metal
household_appliances  | Household electrical appliances         | eng  | 1915  | 600   | electric_motors refrigeration             | elec
quantum_mechanics     | Quantum mechanics                       | sci  | 1926  | 5000  | electromagnetism thermodynamics calculus  | phys
cemented_carbide      | Cemented carbide cutting tools          | proc | 1926  | 600   | alloy_metallurgy                          | metal
petrochemicals        | Petrochemicals and steam cracking       | proc | 1920  | 1500  | petroleum_refining organic_chemistry      | chem
nuclear_physics       | Nuclear physics                         | sci  | 1932  | 4000  | quantum_mechanics                         | phys
television            | Television                              | eng  | 1936  | 1500  | vacuum_tubes                              | elec
synthetic_fibers      | Synthetic fibers (nylon, polyester)     | proc | 1938  | 1200  | synthetic_polymers petrochemicals         | chem
antibiotics           | Antibiotics (industrial fermentation)   | proc | 1943  | 2000  | germ_theory fermentation organic_chemistry| bio
jet_propulsion        | Jet propulsion                          | eng  | 1944  | 4000  | aviation thermodynamics alloy_metallurgy  | mech
plastics_processing   | Injection molding and extrusion         | proc | 1946  | 800   | synthetic_polymers machine_tools          | chem
computing             | Electronic digital computing            | eng  | 1946  | 4000  | vacuum_tubes calculus                     | cs
solid_state_physics   | Solid-state physics                     | sci  | 1947  | 4000  | quantum_mechanics                         | phys
transistor            | Transistor                              | eng  | 1947  | 3000  | solid_state_physics vacuum_tubes          | elec
semiconductor_materials | Ultra-pure silicon (zone refining, Czochralski) | proc | 1952 | 3000 | solid_state_physics modern_chemistry  | chem
polyolefins           | Polyethylene / polypropylene catalysis  | proc | 1953  | 1500  | petrochemicals synthetic_polymers         | chem
superalloys           | Nickel superalloys                      | proc | 1953  | 2500  | alloy_metallurgy jet_propulsion           | metal
solar_pv              | Photovoltaic cells                      | eng  | 1954  | 1500  | solid_state_physics                       | elec
numerical_control     | Numerical control of machine tools      | eng  | 1955  | 1500  | computing machine_tools                   | mech
containerization      | Containerized shipping and logistics    | eng  | 1956  | 400   | mass_production                           | mgmt
nuclear_power         | Nuclear power reactors                  | eng  | 1956  | 8000  | nuclear_physics alloy_metallurgy electric_power | phys
ultrasound_imaging    | Medical ultrasound                      | eng  | 1958  | 800   | vacuum_tubes                              | med
integrated_circuits   | Integrated circuits                     | eng  | 1959  | 5000  | transistor semiconductor_materials        | elec
photolithography      | Photolithography                        | proc | 1960  | 4000  | integrated_circuits optics organic_chemistry | elec
lasers                | Lasers                                  | eng  | 1960  | 2000  | quantum_mechanics optics                  | phys
cleanroom_tech        | Cleanroom technology                    | proc | 1962  | 800   | photolithography                          | elec
industrial_robotics   | Industrial robots                       | eng  | 1961  | 2500  | numerical_control electric_motors         | mech
cmos                  | CMOS process technology                 | proc | 1963  | 3500  | photolithography cleanroom_tech           | elec
float_glass           | Float glass process                     | proc | 1959  | 800   | glassmaking                               | chem
software_engineering  | Software engineering                    | sci  | 1968  | 3000  | computing                                 | cs
recombinant_dna       | Recombinant DNA                         | sci  | 1973  | 5000  | antibiotics organic_chemistry             | bio
composites            | Carbon-fiber composites                 | proc | 1970  | 1500  | synthetic_fibers petrochemicals           | chem
lean_manufacturing    | Lean / statistical quality manufacturing| sci  | 1970  | 1000  | mass_production                           | mgmt
microprocessors       | Microprocessors                         | eng  | 1971  | 4000  | integrated_circuits cmos software_engineering | elec
lcd_displays          | Liquid-crystal displays                 | proc | 1972  | 2500  | organic_chemistry semiconductor_materials | elec
cad_cam               | CAD / CAM                               | eng  | 1975  | 2000  | computing numerical_control               | cs
mri_imaging           | Magnetic resonance imaging              | eng  | 1977  | 3000  | nuclear_physics computing                 | med
fiber_optics          | Fiber-optic communications              | eng  | 1977  | 2500  | lasers glassmaking                        | elec
personal_computing    | Personal computers                      | eng  | 1977  | 1500  | microprocessors                           | cs
wind_turbines_modern  | Modern wind turbines                    | eng  | 1980  | 1500  | composites electric_power                 | mech
biologics             | Biologic drugs (recombinant proteins)   | proc | 1982  | 6000  | recombinant_dna                           | bio
cellular_networks     | Cellular networks                       | eng  | 1983  | 3000  | radio microprocessors                     | elec
internet              | Internet protocols and the web          | eng  | 1991  | 3000  | software_engineering personal_computing   | cs
rare_earth_magnets    | Rare-earth permanent magnets            | proc | 1984  | 1500  | alloy_metallurgy                          | metal
li_ion_batteries      | Lithium-ion batteries                   | proc | 1991  | 4000  | modern_chemistry solid_state_physics      | chem
blue_led              | Blue LEDs / solid-state lighting        | proc | 1994  | 3000  | semiconductor_materials                   | elec
duv_lithography       | Deep-UV immersion lithography           | proc | 2004  | 15000 | photolithography lasers cmos              | elec
gas_turbine_cc        | Combined-cycle gas turbines             | eng  | 1990  | 2500  | jet_propulsion superalloys electric_power | mech
digital_imaging       | Digital image sensors                   | eng  | 1995  | 2000  | cmos                                      | elec
gps_navigation        | Satellite navigation                    | eng  | 1995  | 3000  | computing radio                           | elec
oled_displays         | OLED displays                           | proc | 2007  | 5000  | lcd_displays organic_chemistry            | elec
smartphones           | Smartphones                             | eng  | 2007  | 4000  | cellular_networks microprocessors internet digital_imaging | elec
cloud_computing       | Cloud computing                         | eng  | 2006  | 3000  | internet                                  | cs
electric_vehicles     | Modern electric vehicles                | eng  | 2008  | 4000  | li_ion_batteries electric_motors power_electronics | mech
power_electronics     | Power electronics (IGBT, inverters)     | eng  | 1985  | 2000  | transistor                                | elec
additive_manufacturing| Additive manufacturing (3D printing)    | eng  | 2010  | 2000  | cad_cam lasers                            | mech
machine_learning      | Machine learning / deep learning        | sci  | 2012  | 5000  | software_engineering calculus             | cs
crispr                | Gene editing                            | sci  | 2012  | 3000  | recombinant_dna                           | bio
finfet                | FinFET transistors                      | proc | 2011  | 10000 | duv_lithography cmos                      | elec
euv_lithography       | EUV lithography                         | proc | 2019  | 40000 | duv_lithography lasers                    | elec
mrna_vaccines         | mRNA vaccines                           | proc | 2020  | 5000  | biologics vaccines                        | bio
large_language_models | Large language models                   | sci  | 2020  | 8000  | machine_learning cloud_computing          | cs
`

export const FIELDS: Record<string, string[]> = {
  agri: ["scientist", "agronomist"],
  mech: ["mech_engineer"],
  metal: ["materials_engineer"],
  chem: ["chem_engineer", "scientist"],
  elec: ["elec_engineer", "process_engineer"],
  cs: ["software_dev"],
  bio: ["scientist", "pharmacist"],
  phys: ["scientist"],
  civil: ["civil_engineer"],
  med: ["doctor", "scientist"],
  textile: ["mech_engineer", "chem_engineer"],
  mgmt: ["manager"],
}
