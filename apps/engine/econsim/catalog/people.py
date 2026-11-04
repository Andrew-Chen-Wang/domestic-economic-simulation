"""Occupations, education levels and fields of study.

A person can work in an occupation only if their education level is at least
`edu` and their field of study is in `fields` ('*' = any field). Skill inside
an occupation (0..1) is built through education quality and on-the-job
experience, and decays during unemployment. Wages are NOT fixed here:
`ref_wage` is the 2025 world-frontier hourly wage (W$) used only to calibrate
the labor content of production recipes; domestic wages are set by the labor
market.
"""

EDU_LEVELS = ["none", "primary", "secondary", "vocational", "bachelor", "graduate"]

# field -> (education level at which it is studied, label)
FIELDS = {
    "general":   (2, "General / no specialization"),
    "trades":    (3, "Mechanical trades (machining, welding)"),
    "elec_tech": (3, "Electrical & electronics technician"),
    "chem_tech": (3, "Process / lab technician"),
    "health":    (3, "Nursing & allied health"),
    "agri":      (4, "Agronomy & agricultural science"),
    "mech":      (4, "Mechanical engineering"),
    "elec":      (4, "Electrical engineering"),
    "chem":      (4, "Chemical & materials engineering"),
    "cs":        (4, "Computer science"),
    "civil":     (4, "Civil engineering"),
    "science":   (4, "Natural sciences"),
    "bio":       (4, "Biology & pharmacy"),
    "med":       (4, "Medicine"),
    "business":  (4, "Business, economics, accounting"),
    "law":       (4, "Law"),
    "education": (4, "Education"),
    "arts":      (4, "Arts & design"),
}

TABLE = r"""
# id               | name                              | edu | fields                          | ref_wage
laborer            | General laborer                   | 0   | *                               | 16
farmer             | Farmer / farm worker              | 0   | *                               | 15
fisher             | Fisher / seafarer                 | 0   | *                               | 20
forester           | Forestry worker                   | 0   | *                               | 19
miner              | Miner                             | 1   | *                               | 27
construction       | Construction worker               | 1   | *                               | 25
operator           | Machine / plant operator          | 1   | *                               | 22
assembler          | Assembler                         | 1   | *                               | 19
textile_worker     | Textile & garment worker          | 0   | *                               | 14
food_worker        | Food processing worker            | 1   | *                               | 17
craftsman          | Craftsman (wood, metal, leather)  | 1   | *                               | 22
driver             | Driver / transport operator       | 1   | *                               | 22
sales              | Retail & sales worker             | 1   | *                               | 16
cook               | Cook & food service               | 0   | *                               | 16
service            | Personal service worker           | 0   | *                               | 15
care_worker        | Care worker                       | 1   | *                               | 18
clerk              | Office clerk                      | 2   | *                               | 22
security           | Security / police officer         | 2   | *                               | 25
public_admin       | Civil servant                     | 2   | *                               | 30
machinist          | Machinist / toolmaker             | 3   | trades mech                     | 29
welder             | Welder / fabricator               | 3   | trades mech                     | 27
electrician        | Electrician                       | 3   | elec_tech elec                  | 31
technician         | Electronics technician            | 3   | elec_tech elec cs               | 30
lab_tech           | Process & lab technician          | 3   | chem_tech chem science bio      | 28
nurse              | Nurse                             | 3   | health med                      | 38
agronomist         | Agronomist                        | 4   | agri science bio                | 40
mech_engineer      | Mechanical engineer               | 4   | mech                            | 47
elec_engineer      | Electrical / electronics engineer | 4   | elec                            | 52
chem_engineer      | Chemical engineer                 | 4   | chem                            | 50
materials_engineer | Materials / metallurgical engineer| 4   | chem mech science               | 50
civil_engineer     | Civil engineer                    | 4   | civil                           | 45
software_dev       | Software developer                | 4   | cs elec science                 | 60
process_engineer   | Semiconductor process engineer    | 5   | elec chem science               | 65
scientist          | Research scientist                | 5   | science bio chem agri           | 52
pharmacist         | Pharmacist / pharma scientist     | 4   | bio med                         | 58
doctor             | Physician                         | 5   | med                             | 95
teacher            | Teacher                           | 4   | education *                     | 32
professor          | Professor                         | 5   | *                               | 58
designer           | Designer / artist                 | 4   | arts                            | 38
accountant         | Accountant / finance professional | 4   | business                        | 42
lawyer             | Lawyer                            | 4   | law                             | 70
manager            | Manager                           | 4   | business *                      | 58
pilot              | Pilot / ship officer              | 4   | mech trades                     | 72
"""

HOURS_PER_MONTH = 160.0


def parse():
    occ = {}
    for line in TABLE.strip().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        oid, name, edu, fields, wage = [c.strip() for c in line.split("|")]
        occ[oid] = {
            "id": oid,
            "name": name,
            "edu": int(edu),
            "fields": fields.split(),
            "ref_wage": float(wage),
        }
    return occ


def eligible(occ, edu, field, skill=0.0):
    """Can a person with this education/field work in occupation `occ`?

    Experience substitutes for credentials: someone who already has real skill
    in an occupation (e.g. learned on the job) can keep working in it.
    """
    if skill >= 0.35:
        return True
    if edu < occ["edu"]:
        return False
    f = occ["fields"]
    return "*" in f or field in f
