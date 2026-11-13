#!/usr/bin/env python3
"""Zo surovych dat v data/raw vyrobi kompaktne subory pre appku v app/data.

Pravidla legality (TCG Tournament Handbook, revizia 2026-09-01, kapitola 4):
- Standard: regulacne znacky STANDARD_MARKS.
- Trainer a Special Energy: stary vytlacok je legalny, ak ma rovnake meno a text
  ako legalny vytlacok (par. 4.1.3). Porovnavame prisne, takze pri preformulovanom
  texte radsej povieme "nelegalne" nez falosne "legalne".
- Pokemon: rozhoduje znacka na konkretnom vytlacku.
- Basic Energy je legalna vzdy.
- Novy set je legalny od druheho piatka po vydani (par. 4.1.2). Datum ide do dat ako "lf"
  a appka ho vyhodnocuje sama, takze v ten den netreba nic prepocitavat.
"""
import collections
import datetime
import json
import pathlib
import random
import re
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "app" / "data"

STANDARD_MARKS = {"H", "I", "J"}
LEGAL_STANDARD, LEGAL_EXPANDED, LEGAL_UNLIMITED = 1, 2, 4

# Sety z mobilnej hry Pokemon TCG Pocket nie su fyzicke karty.
EXCLUDED_SERIES = {"tcgp"}

ENERGY_LETTER = {
    "Grass": "G", "Fire": "R", "Water": "W", "Lightning": "L", "Psychic": "P",
    "Fighting": "F", "Darkness": "D", "Metal": "M", "Fairy": "Y", "Dragon": "N",
    "Colorless": "C",
}

# ACE SPEC z ery Black & White a XY nemaju v databaze vlastnu raritu.
OLD_ACE_SPECS = {
    "Computer Search", "Crystal Edge", "Crystal Wall", "Dowsing Machine", "G Booster",
    "G Scope", "Gold Potion", "Hero's Medal", "Life Dew", "Master Ball",
    "Rock Guard", "Scoop Up Cyclone", "Scramble Switch", "Victory Piece",
}

# Serie, ktore patria do Expanded (Handbook, kap. 4.1.1).
EXPANDED_SERIES = {"bw", "xy", "sm", "swsh", "sv", "me"}
# Stare turnaje mozu mat ine zakazane karty a inu metu.
EXPANDED_LISTS_FROM = "2025-01-01"
# Standard sa meni rychlo, staci poslednych par tyzdnov.
STANDARD_WINDOW_DAYS = 35
BUILD_DATE = datetime.date.today()
# TCGdex pri novom sete par dni nema regulacne znacky. Vtedy sa prevezme znacka z predosleho setu serie.
NEW_SET_DAYS = 45

# Kody promo setov, ktore TCGdex nema: kod -> (id setu, predpona cisla karty).
PROMO_CODES = {"SP": ("swshp", "SWSH"), "XYP": ("xyp", "XY"), "SMP": ("smp", "SM"), "BWP": ("bwp", "BW")}
# Kody z exportu Pokemon TCG Live, ktore nie su v datach setu.
EXTRA_SET_CODES = {"svp": "PR-SV", "swshp": "PR-SW"}

# Bezne preformulovania, ktore nemenia efekt karty (Handbook, par. 4.1.3).
REWORDINGS = [
    (r"</?[a-z]+>", ""),  # HTML znacky v datach, napr. <em>
    (r"this pokemon also does", "this pokemon does"),
    # Stare karty maju pravidlo pre Supporter vypisane priamo v texte.
    (r"you can play only one supporter card each turn\. when you play this card, put it next to your active pokemon\. "
     r"when your turn ends, discard this card\.", ""),
    (r"\{c\}", "colorless"), (r"\{g\}", "grass"), (r"\{r\}", "fire"), (r"\{w\}", "water"), (r"\{l\}", "lightning"),
    (r"\{p\}", "psychic"), (r"\{f\}", "fighting"), (r"\{d\}", "darkness"), (r"\{m\}", "metal"), (r"\{y\}", "fairy"),
    (r"\bhis or her\b", "their"),
    (r"\bhe or she\b", "they"),
    (r"shuffle your deck afterward", "shuffle your deck"),
    (r"\bthen, ", ""),
    (r"switch 1 of your opponent's benched pokemon with their active pokemon",
     "switch in 1 of your opponent's benched pokemon to the active spot"),
    (r"attached to 1 of your opponent's", "from 1 of your opponent's"),
]

TAGS = [
    ("draw", 1, re.compile(r"draw (\d+ |a |up to |until |cards)", re.I)),
    ("search", 2, re.compile(r"search your deck for", re.I)),
    ("switch", 4, re.compile(r"switch your active|switch this pok", re.I)),
    ("gust", 8, re.compile(r"switch (in )?1 of your opponent", re.I)),
    ("heal", 16, re.compile(r"\bheal\b", re.I)),
    ("recover", 32, re.compile(r"from your discard pile", re.I)),
    ("accel", 64, re.compile(r"attach .{0,60}energy", re.I)),
]


def strip_accents(text):
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def name_key(name):
    plain = strip_accents(name).replace("’", "'").replace("◇", " prism star").lower()
    plain = re.sub(r"^basic (?=\w+ energy$)", "", plain)
    return re.sub(r"[^a-z0-9]+", "", plain)


def same_card_name(ours, theirs):
    if name_key(ours) == name_key(theirs):
        return True
    return strip_accents(ours).lower().split()[:2] == strip_accents(theirs or "").lower().split()[:2]


def text_key(text):
    plain = strip_accents(text).replace("’", "'").lower()
    for pattern, replacement in REWORDINGS:
        plain = re.sub(pattern, replacement, plain)
    return re.sub(r"[^a-z0-9]+", "", plain)


def number_key(number):
    value = str(number or "").strip().upper()
    match = re.fullmatch(r"([A-Z]*)0*(\d+)", value)
    return match.group(1) + match.group(2) if match else value


def read_jsonl(path):
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def effective_damage(attack):
    raw = str(attack.get("damage") or "")
    match = re.search(r"\d+", raw)
    value = float(match.group()) if match else 0.0
    if "+" in raw:
        value *= 1.25
    elif "×" in raw or "x" in raw.lower():
        value *= 1.5
    effect = (attack.get("effect") or "").lower()
    if "if tails, this attack does nothing" in effect:
        value *= 0.5
    if "can't attack" in effect or "can't use" in effect:
        value *= 0.6
    if "discard all" in effect and "energy" in effect:
        value *= 0.7
    elif "discard" in effect and "energy" in effect and "this pok" in effect:
        value *= 0.85
    if "damage to itself" in effect or "to this pok" in effect and "damage" in effect:
        value *= 0.8
    return round(value)


def tag_mask(texts):
    mask = 0
    joined = " ".join(t for t in texts if t)
    for _name, bit, pattern in TAGS:
        if pattern.search(joined):
            mask |= bit
    return mask


def has_rule_box(name):
    return bool(re.search(r"(\bex|\bEX|-EX|\bGX|-GX|\bV|\bVMAX|\bVSTAR|\bV-UNION|\bLV\.X|\bPrime)$", name or ""))


BASIC_ENERGY_NAMES = {
    f"{kind}energy" for kind in ("grass", "fire", "water", "lightning", "psychic", "fighting", "darkness", "metal", "fairy")
}


def is_basic_energy(card):
    # Treba oboje: Team Rocket's Energy ma v datach chybne Normal a stare Special Energy sa volaju aj "Metal Energy".
    return (
        card.get("category") == "Energy"
        and card.get("energyType") != "Special"
        and name_key(card.get("name")) in BASIC_ENERGY_NAMES
    )


def functional_key(card):
    category = card.get("category")
    name = name_key(card.get("name"))
    if is_basic_energy(card):
        return f"E|{name}"
    if category != "Pokemon":
        return f"{category}|{name}|{text_key(card.get('effect'))}"
    attacks = [
        (text_key(a.get("name")), "".join(a.get("cost") or []), str(a.get("damage") or ""), text_key(a.get("effect")))
        for a in card.get("attacks") or []
    ]
    abilities = [(text_key(a.get("name")), text_key(a.get("effect"))) for a in card.get("abilities") or []]
    # Slabost v kluci nie je: promo karty ju v datach casto nemaju a skupina by sa zbytocne rozpadla.
    return "P|" + json.dumps(
        [name, card.get("hp"), card.get("types"), card.get("retreat"), attacks, abilities],
        sort_keys=True,
    )


def legal_from(release):
    """Druhy piatok po vydani setu (Handbook, par. 4.1.2)."""
    day = datetime.date.fromisoformat(release)
    to_friday = (4 - day.weekday() - 1) % 7 + 1
    return day + datetime.timedelta(days=to_friday + 7)


def best_price(card):
    """Orientacna cena: stredna hodnota z trendu a priemerov za 7 a 30 dni, lacnejsi z variantov.

    Samotny trend obcas ustreli (jedna draha ponuka), stredna hodnota z troch cisel to vyrovna.
    """
    market = (card.get("pricing") or {}).get("cardmarket") or {}

    def number(key):
        value = market.get(key)
        return value if isinstance(value, (int, float)) and value > 0 else None

    def estimate(suffix):
        values = sorted(v for v in (number("trend" + suffix), number("avg7" + suffix), number("avg30" + suffix)) if v)
        if len(values) == 3:
            return values[1]
        return values[0] if values else number("low" + suffix)

    options = [value for value in (estimate(""), estimate("-holo")) if value]
    return round(min(options), 2) if options else None


def build_demo(cards_raw, set_by_id):
    """Vzdy rovnaky ukazkovy bulk: bezne karty z par novsich setov a trochu starsich."""
    rng = random.Random(151)
    common = [c for c in cards_raw if c.get("rarity") in ("Common", "Uncommon")]
    by_set = collections.defaultdict(list)
    for card in common:
        by_set[card["set"]["id"]].append(card)

    def release(set_id):
        return set_by_id[set_id].get("releaseDate") or ""

    def released(set_id):
        return bool(release(set_id)) and legal_from(release(set_id)) <= BUILD_DATE

    recent_sets = sorted(
        (
            s for s, rows in by_set.items()
            if len(rows) >= 40 and released(s) and all(c.get("regulationMark") in STANDARD_MARKS for c in rows)
        ),
        key=release,
    )[-5:]
    older_sets = sorted(
        (s for s, rows in by_set.items() if len(rows) >= 40 and all(c.get("regulationMark") in {"E", "F", "G"} for c in rows)),
        key=release,
    )[-6:]

    def take(set_ids, how_many):
        rows = []
        for set_id in set_ids:
            sample = rng.sample(by_set[set_id], min(how_many, len(by_set[set_id])))
            rows += [[c["id"], rng.choices([1, 2, 3, 4], weights=[55, 27, 12, 6])[0]] for c in sample]
        return rows

    return take(recent_sets, 34) + take(older_sets, 12)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sets_raw = json.loads((RAW / "sets.json").read_text(encoding="utf-8"))
    sets_raw = [s for s in sets_raw if (s.get("serie") or {}).get("id") not in EXCLUDED_SERIES]
    set_by_id = {s["id"]: s for s in sets_raw}
    cards_raw = [c for c in read_jsonl(RAW / "cards.jsonl") if (c.get("set") or {}).get("id") in set_by_id]
    print(f"karty: {len(cards_raw)}, sety: {len(sets_raw)}")

    # --- novy set bez regulacnych znaciek: prevezmeme znacku z predosleho setu tej istej serie
    cards_by_set = collections.defaultdict(list)
    for card in cards_raw:
        cards_by_set[card["set"]["id"]].append(card)
    for s in sets_raw:
        rows = cards_by_set.get(s["id"]) or []
        release = s.get("releaseDate") or ""
        if not rows or not release or any(c.get("regulationMark") for c in rows):
            continue
        if (BUILD_DATE - datetime.date.fromisoformat(release)).days > NEW_SET_DAYS:
            continue
        series = (s.get("serie") or {}).get("id")
        earlier = sorted(
            (
                o for o in sets_raw
                if (o.get("serie") or {}).get("id") == series and (o.get("releaseDate") or "") < release
                and any(c.get("regulationMark") for c in cards_by_set.get(o["id"]) or [])
            ),
            key=lambda o: o.get("releaseDate") or "",
        )
        if not earlier:
            continue
        marks = collections.Counter(c.get("regulationMark") for c in cards_by_set[earlier[-1]["id"]] if c.get("regulationMark"))
        mark = marks.most_common(1)[0][0]
        for card in rows:
            card["regulationMark"] = mark
            card["_mark_assumed"] = True
        print(f"  POZOR: {s['id']} {s.get('name')} nema v datach znacky, predpokladam {mark} podla {earlier[-1]['id']}")

    # --- sety, ktore este nie su legalne
    pending_sets = {}
    for s in sets_raw:
        if s.get("releaseDate") and legal_from(s["releaseDate"]) > BUILD_DATE:
            pending_sets[s["id"]] = legal_from(s["releaseDate"]).isoformat()
    print("sety pred datumom legality:", pending_sets)

    # --- ceny: jeden produkt Cardmarketu priradeny roznym kartam je chyba v datach
    product_names = collections.defaultdict(set)
    for card in cards_raw:
        product = ((card.get("pricing") or {}).get("cardmarket") or {}).get("idProduct")
        if product:
            product_names[product].add(name_key(card["name"]))
    shared_products = {product for product, names in product_names.items() if len(names) > 1}
    dropped_prices = 0
    for card in cards_raw:
        product = ((card.get("pricing") or {}).get("cardmarket") or {}).get("idProduct")
        if product in shared_products:
            card["_no_price"] = True
            dropped_prices += 1
    print(f"ceny: {dropped_prices} kariet bez ceny, lebo zdielaju produkt s inou kartou")

    # --- funkcne skupiny: rovnake meno a text = ta ista karta pre ucely decku
    card_by_id = {c["id"]: c for c in cards_raw}
    reprints_cfg = json.loads((ROOT / "data" / "functional_reprints.json").read_text(encoding="utf-8"))
    key_alias = {}
    for entry in reprints_cfg["reprints"]:
        target = card_by_id.get(entry.get("into")) if entry.get("into") else next(
            (
                c for c in cards_raw
                if name_key(c["name"]) == name_key(entry["name"]) and c.get("regulationMark") in STANDARD_MARKS
            ),
            None,
        )
        if target is None:
            print(f"  POZOR: pre {entry['name']} nemam cielovy vytlacok")
            continue
        for print_id in entry["prints"]:
            old = card_by_id.get(print_id)
            if old is None or name_key(old["name"]) != name_key(entry["name"]):
                print(f"  POZOR: vytlacok {print_id} nesedi k {entry['name']}")
                continue
            key_alias[functional_key(old)] = functional_key(target)

    # Novy Trainer alebo Special Energy bez textu v databaze je medzera v datach, nie ina karta.
    for card in cards_raw:
        fillable = card.get("category") in ("Trainer", "Energy") and not is_basic_energy(card)
        if fillable and not card.get("effect") and card.get("regulationMark") in STANDARD_MARKS:
            twin = next(
                (
                    c for c in cards_raw
                    if name_key(c["name"]) == name_key(card["name"]) and c.get("effect") and c.get("regulationMark") in STANDARD_MARKS
                ),
                None,
            )
            if twin:
                key_alias[functional_key(card)] = functional_key(twin)

    group_ids = {}
    for card in cards_raw:
        key = functional_key(card)
        card["_g"] = group_ids.setdefault(key_alias.get(key, key), len(group_ids))
    print(f"funkcne skupiny: {len(group_ids)}")

    by_group = collections.defaultdict(list)
    for card in cards_raw:
        by_group[card["_g"]].append(card)

    # --- zakazane karty v Expanded
    banned_cfg = json.loads((ROOT / "data" / "banned_expanded.json").read_text(encoding="utf-8"))
    banned_trainer_names = {name_key(n) for n in banned_cfg["trainers"]}
    banned_groups = set()
    for entry in banned_cfg["pokemon"]:
        for set_name, number in entry["prints"]:
            hits = [
                c for c in cards_raw
                if name_key(c["name"]) == name_key(entry["name"])
                and c["set"].get("name") == set_name
                and number_key(c.get("localId")) == number_key(number)
            ]
            if not hits:
                print(f"  POZOR: zakazany vytlacok nenajdeny: {entry['name']} {set_name} {number}")
            banned_groups.update(c["_g"] for c in hits)

    # --- legalita
    officially_banned = banned_trainer_names | {name_key(e["name"]) for e in banned_cfg["pokemon"]}
    flag_mismatch = collections.Counter()
    for card in cards_raw:
        mark = card.get("regulationMark")
        standard = mark in STANDARD_MARKS
        # TCGdex ma v Expanded aj karty, ktore uz na oficialnom zozname zakazanych nie su.
        series = (set_by_id[card["set"]["id"]].get("serie") or {}).get("id")
        expanded = bool((card.get("legal") or {}).get("expanded")) or (
            series in EXPANDED_SERIES and name_key(card["name"]) not in officially_banned
        )
        if standard != bool((card.get("legal") or {}).get("standard")) and not card.get("_mark_assumed"):
            flag_mismatch[f"{card.get('category')}/{mark}"] += 1
        card["_std"], card["_exp"] = standard, expanded
        # Vlastna legalita vytlacku pred prevzatim od inych vytlackov tej istej karty.
        basic = is_basic_energy(card)
        card["_std_own"], card["_exp_own"] = standard or basic, expanded or basic

    for prints in by_group.values():
        sample = prints[0]
        category = sample.get("category")
        if is_basic_energy(sample):
            for card in prints:
                card["_std"] = card["_exp"] = True
        elif category != "Pokemon":
            std = any(c["_std"] for c in prints)
            exp = any(c["_exp"] for c in prints)
            for card in prints:
                card["_std"], card["_exp"] = std, exp
    print("rozdiely znacka vs. TCGdex legal.standard:", dict(flag_mismatch))

    # Rovnake meno ako legalna karta, ale iny text: hracovi to povieme, do decku to neratame.
    # Zakladna energia sa nerata: stara Special "Metal Energy" nie je jej verzia.
    def maybe_source(card):
        return card.get("category") != "Pokemon" and not is_basic_energy(card)

    std_names = {name_key(c["name"]) for c in cards_raw if c["_std"] and maybe_source(c)}
    exp_names = {name_key(c["name"]) for c in cards_raw if c["_exp"] and maybe_source(c)}

    # --- kompaktne karty pre appku
    pending_groups = {card["_g"] for card in cards_raw if card["set"]["id"] in pending_sets}
    compact = []
    card_index = {}
    for card in cards_raw:
        legal = LEGAL_UNLIMITED
        if card["_std"]:
            legal |= LEGAL_STANDARD
        banned = card["_g"] in banned_groups or (
            card.get("category") == "Trainer" and name_key(card["name"]) in banned_trainer_names
        )
        if card["_exp"] and not banned:
            legal |= LEGAL_EXPANDED

        own = LEGAL_UNLIMITED
        if card["_std_own"]:
            own |= LEGAL_STANDARD
        if card["_exp_own"] and not banned:
            own |= LEGAL_EXPANDED

        image = card.get("image") or ""
        record = {
            "id": card["id"],
            "n": card["name"],
            "s": card["set"]["id"],
            "l": card.get("localId"),
            "c": {"Pokemon": "P", "Trainer": "T", "Energy": "E"}.get(card.get("category"), "?"),
            "g": card["_g"],
            "lg": legal,
        }
        if image:
            record["im"] = image.replace("https://assets.tcgdex.net/en/", "")
        if card["_g"] in pending_groups:
            record["lo"] = own
        if card.get("regulationMark"):
            record["rm"] = card["regulationMark"]
        if card.get("_mark_assumed"):
            record["rma"] = 1
        price = None if card.get("_no_price") else best_price(card)
        if price is not None:
            record["p"] = price
        maybe = 0
        if card.get("category") != "Pokemon" and not banned:
            key = name_key(card["name"])
            if not card["_std"] and key in std_names:
                maybe |= LEGAL_STANDARD
            if not card["_exp"] and key in exp_names:
                maybe |= LEGAL_EXPANDED
        if maybe:
            record["mb"] = maybe

        rarity = card.get("rarity") or ""
        series = (set_by_id[card["set"]["id"]].get("serie") or {}).get("id")
        if "ACE SPEC" in rarity.upper() or (series == "bw" and card["name"] in OLD_ACE_SPECS):
            record["ace"] = 1
        if card["name"].startswith("Radiant "):
            record["rad"] = 1
        if "◇" in card["name"] or "Prism Star" in rarity:
            record["pri"] = 1

        if record["c"] == "P":
            record["st"] = card.get("stage") or "Basic"
            if card.get("evolveFrom"):
                record["ef"] = card["evolveFrom"]
            if card.get("hp"):
                record["hp"] = card["hp"]
            record["ty"] = "".join(ENERGY_LETTER.get(t, "C") for t in card.get("types") or [])
            attacks = [
                [
                    a.get("name"),
                    "".join(ENERGY_LETTER.get(c, "C") for c in a.get("cost") or []),
                    effective_damage(a),
                    str(a.get("damage") or ""),
                ]
                for a in card.get("attacks") or []
            ]
            if attacks:
                record["at"] = attacks
            abilities = card.get("abilities") or []
            if abilities:
                record["ab"] = [a.get("name") for a in abilities]
                mask = tag_mask(a.get("effect") for a in abilities)
                if mask:
                    record["fx"] = mask
            if has_rule_box(card["name"]):
                record["rb"] = 1
        elif record["c"] == "T":
            record["tt"] = card.get("trainerType") or "Item"
            mask = tag_mask([card.get("effect")])
            if mask:
                record["fx"] = mask
        elif record["c"] == "E":
            record["et"] = "B" if is_basic_energy(card) else "S"
            types = card.get("types") or []
            if types:
                record["ty"] = "".join(ENERGY_LETTER.get(t, "C") for t in types)
            elif record["et"] == "B":
                word = name_key(card["name"]).replace("energy", "")
                record["ty"] = ENERGY_LETTER.get(word.capitalize(), "C")
        compact.append(record)
        card_index[card["id"]] = record

    sets_out = {}
    for s in sets_raw:
        abbreviation = (s.get("abbreviation") or {}).get("official") or s.get("tcgOnline")
        sets_out[s["id"]] = {"a": abbreviation, "n": s.get("name"), "d": s.get("releaseDate")}
        official_count = (s.get("cardCount") or {}).get("official")
        if official_count:
            sets_out[s["id"]]["t"] = official_count
        if s["id"] in pending_sets:
            sets_out[s["id"]]["lf"] = pending_sets[s["id"]]
        other = s.get("tcgOnline") or EXTRA_SET_CODES.get(s["id"])
        if other and other != abbreviation:
            sets_out[s["id"]]["o"] = other

    (OUT / "cards.json").write_text(
        json.dumps(
            {"built": BUILD_DATE.isoformat(), "sets": sets_out, "cards": compact, "standardMarks": sorted(STANDARD_MARKS)},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    # --- turnajove decky
    # Dva sety mozu mat rovnaku skratku (30th a 30th Classic Collection su oba "30C"),
    # preto je pod jednym klucom zoznam a rozhoduje meno karty.
    by_code_number = collections.defaultdict(list)
    by_code_name = collections.defaultdict(list)
    by_name = collections.defaultdict(list)
    for card in cards_raw:
        code = sets_out[card["set"]["id"]]["a"]
        if code:
            by_code_number[(code.upper(), number_key(card.get("localId")))].append(card)
            by_code_name[(code.upper(), name_key(card["name"]))].append(card)
        by_code_number[(card["set"]["id"].upper(), number_key(card.get("localId")))].append(card)
        by_name[name_key(card["name"])].append(card)
    for code, (set_id, prefix) in PROMO_CODES.items():
        for card in cards_raw:
            local = number_key(card.get("localId"))
            if card["set"]["id"] == set_id and local.startswith(prefix):
                by_code_number[(code, local[len(prefix):])].append(card)

    stats = collections.Counter()
    unresolved = collections.Counter()
    illegal_played = collections.Counter()
    tournaments = read_jsonl(RAW / "tournaments.jsonl")
    newest_standard = max((t.get("date") or "" for t in tournaments if t.get("format") == "STANDARD"), default="")
    standard_from = ""
    if newest_standard:
        newest_day = datetime.date.fromisoformat(newest_standard[:10])
        standard_from = (newest_day - datetime.timedelta(days=STANDARD_WINDOW_DAYS)).isoformat()
    decks = {"standard": [], "expanded": []}

    def resolve(entry, format_key):
        code = str(entry.get("set")).upper()
        # Set a cislo su jednoznacne. Mena sa lisia len v dovetkoch ("Battle Compressor Team Flare Gear").
        for card in by_code_number.get((code, number_key(entry.get("number"))), []):
            if same_card_name(card["name"], entry.get("name")):
                stats["presne"] += 1
                return card
        # Cislo nesedi (Classic Collection cisluje TCGdex inak), ale v sete je karta s tym menom iba raz.
        in_set = by_code_name.get((code, name_key(entry.get("name"))), [])
        if len(in_set) == 1:
            stats["podla mena v sete"] += 1
            return in_set[0]
        # Vytlacok sa nenasiel. Pri Trainer/Energy na vytlacku nezalezi, ak meno jednoznacne urcuje text.
        candidates = by_name.get(name_key(entry.get("name")), [])
        groups = {c["_g"] for c in candidates}
        if candidates and (len(groups) == 1 or candidates[0].get("category") != "Pokemon"):
            legal_flag = "_std" if format_key == "standard" else "_exp"
            preferred = [c for c in candidates if c[legal_flag]] or candidates
            stats["podla mena"] += 1
            return sorted(preferred, key=lambda c: set_by_id[c["set"]["id"]].get("releaseDate") or "")[-1]
        stats["nevyriesene"] += 1
        unresolved[f"{entry.get('name')} {entry.get('set')} {entry.get('number')}"] += 1
        return None

    for tournament in tournaments:
        format_key = (tournament.get("format") or "").lower()
        if format_key not in decks:
            continue
        if format_key == "expanded" and (tournament.get("date") or "") < EXPANDED_LISTS_FROM:
            continue
        if format_key == "standard" and (tournament.get("date") or "") < standard_from:
            continue
        for row in tournament.get("standings") or []:
            decklist = row.get("decklist") or {}
            cards = []
            complete = True
            legal_list = True
            for section in ("pokemon", "trainer", "energy"):
                for entry in decklist.get(section) or []:
                    card = resolve(entry, format_key)
                    if card is None:
                        complete = False
                        continue
                    if not card_index[card["id"]]["lg"] & (LEGAL_STANDARD if format_key == "standard" else LEGAL_EXPANDED):
                        legal_list = False
                        illegal_played[f"{format_key}: {card['name']} {card['id']} ({card.get('regulationMark')})"] += 1
                    cards.append([card["id"], int(entry.get("count") or 0)])
            total = sum(c[1] for c in cards)
            if not complete or total != 60:
                stats["vyradene listy: neuplne"] += 1
                continue
            if not legal_list:
                stats["vyradene listy: nelegalne"] += 1
                continue
            deck = row.get("deck") or {}
            decks[format_key].append(
                {
                    "arch": deck.get("id") or "other",
                    "name": deck.get("name") or "Iný deck",
                    "icons": deck.get("icons") or [],
                    "placing": row.get("placing"),
                    "record": row.get("record"),
                    "tournament": tournament.get("name"),
                    "date": (tournament.get("date") or "")[:10],
                    "players": tournament.get("players"),
                    "cards": cards,
                }
            )

    print("priradenie kariet z deckov:", dict(stats))
    print("nevyriesene (top 25):", unresolved.most_common(25))
    print("hrane, ale podla nas nelegalne (top 30):", illegal_played.most_common(30))

    output = {}
    for format_key, lists in decks.items():
        usage = collections.Counter()
        copies = collections.Counter()
        for deck in lists:
            seen = collections.Counter()
            for card_id, count in deck["cards"]:
                seen[card_index[card_id]["g"]] += count
            for group, count in seen.items():
                usage[group] += 1
                copies[group] += count
        total_lists = max(1, len(lists))
        usage_rows = [
            [group, round(count / total_lists, 3), round(copies[group] / count, 1)]
            for group, count in usage.most_common()
            if count >= 2
        ]

        grouped = collections.defaultdict(list)
        for deck in lists:
            grouped[deck["arch"]].append(deck)
        archetypes = []
        for arch, members in grouped.items():
            if arch == "other" or len(members) < 2:
                continue
            members.sort(key=lambda d: ((d["placing"] or 999), -(d["players"] or 0), d["date"]))
            unique, seen_keys = [], set()
            for deck in members:
                key = tuple(sorted(map(tuple, deck["cards"])))
                if key not in seen_keys:
                    seen_keys.add(key)
                    unique.append(deck)
            wins = sum(1 for d in members if d["placing"] == 1)
            archetypes.append(
                {
                    "id": arch,
                    "name": members[0]["name"],
                    "icons": members[0]["icons"],
                    "share": round(len(members) / total_lists, 3),
                    "lists_total": len(members),
                    "wins": wins,
                    "lists": [
                        {k: d[k] for k in ("placing", "record", "tournament", "date", "players", "cards")}
                        for d in unique[:12]
                    ],
                }
            )
        archetypes.sort(key=lambda a: -a["lists_total"])
        dates = sorted(d["date"] for d in lists if d["date"])
        output[format_key] = {
            "lists": len(lists),
            "from": dates[0] if dates else None,
            "to": dates[-1] if dates else None,
            "tournaments": len({d["tournament"] for d in lists}),
            "usage": usage_rows,
            "archetypes": archetypes[:60],
        }
        print(f"{format_key}: {len(lists)} listov, {len(archetypes)} archetypov, {dates[:1]}..{dates[-1:]}")

    (OUT / "decks.json").write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (OUT / "demo.json").write_text(json.dumps(build_demo(cards_raw, set_by_id)), encoding="utf-8")
    for name in ("cards.json", "decks.json", "demo.json"):
        print(name, round((OUT / name).stat().st_size / 1_000_000, 1), "MB")


if __name__ == "__main__":
    main()
