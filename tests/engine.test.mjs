// Spustenie: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addToCollection,
  applyUpgrades,
  buildFromCollection,
  collectionValue,
  createDb,
  deckStats,
  isBasicEnergy,
  isLegal,
  matchMetaDecks,
  mulliganChance,
  nameKey,
  needsLegalityCheck,
  ownedGroups,
  parseCollectionText,
  parseLine,
  summarizeMissing,
  validateDeck,
} from "../app/engine.js";

const dataFile = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../app/data/${name}`, import.meta.url)), "utf8"));
// Pevny datum, aby testy nezaviseli od dna spustenia: vsetky sety su uz legalne.
const cardsData = dataFile("cards.json");
const db = createDb(cardsData, { today: "2099-01-01" });
const decks = dataFile("decks.json");
const demo = dataFile("demo.json");

const find = (predicate, label) => {
  const card = db.cards.find(predicate);
  assert.ok(card, `V dátach chýba: ${label}`);
  return card;
};

const standardBasic = find((c) => c.c === "P" && c.st === "Basic" && !c.rb && !c.rad && !c.ace && isLegal(c, "standard"), "Basic Pokémon");
const standardTrainers = db.cards.filter((c) => c.c === "T" && !c.ace && isLegal(c, "standard"));
const fireEnergy = find((c) => isBasicEnergy(c) && nameKey(c.n) === "fireenergy", "Fire Energy");

function validDeck() {
  // 4 Basic Pokemoni, 10 roznych Trainerov po 4, 16 energie = 60
  const names = new Set();
  const trainers = [];
  for (const card of standardTrainers) {
    if (names.has(nameKey(card.n))) continue;
    names.add(nameKey(card.n));
    trainers.push(card);
    if (trainers.length === 10) break;
  }
  return [
    { id: standardBasic.id, count: 4 },
    ...trainers.map((c) => ({ id: c.id, count: 4 })),
    { id: fireEnergy.id, count: 16 },
  ];
}

test("rulebook: platný deck prejde", () => {
  const result = validateDeck(db, validDeck(), "standard");
  assert.deepEqual(result.errors, []);
  assert.equal(result.total, 60);
});

test("rulebook: 59 a 61 kariet neprejde", () => {
  for (const delta of [-1, 1]) {
    const deck = validDeck();
    deck.at(-1).count += delta;
    const codes = validateDeck(db, deck, "standard").errors.map((e) => e.code);
    assert.ok(codes.includes("size"), `chýba chyba veľkosti pri ${60 + delta}`);
  }
});

test("rulebook: limit 4 platí na meno aj naprieč výtlačkami", () => {
  const prints = db.groups.get(standardTrainers[0].g).prints;
  const legalPrints = prints.filter((c) => isLegal(c, "standard"));
  const first = legalPrints[0];
  const second = legalPrints[1] ?? legalPrints[0];
  const deck = [
    { id: standardBasic.id, count: 4 },
    { id: first.id, count: 3 },
    { id: second.id, count: 2 },
    { id: fireEnergy.id, count: 51 },
  ];
  const codes = validateDeck(db, deck, "standard").errors.map((e) => e.code);
  assert.ok(codes.includes("copies"));
});

test("rulebook: základná energia limit nemá", () => {
  const deck = [
    { id: standardBasic.id, count: 4 },
    { id: fireEnergy.id, count: 56 },
  ];
  assert.deepEqual(validateDeck(db, deck, "standard").errors, []);
});

test("rulebook: deck bez Basic Pokémona neprejde", () => {
  const deck = validDeck().filter((e) => e.id !== standardBasic.id);
  deck.at(-1).count += 4;
  const codes = validateDeck(db, deck, "standard").errors.map((e) => e.code);
  assert.ok(codes.includes("basic"));
});

test("legalita: Pokémon so značkou G neprejde v Standarde, v Expanded áno", () => {
  const rotated = find((c) => c.c === "P" && c.rm === "G" && c.st === "Basic" && !c.rad, "Pokémon so značkou G");
  const deck = validDeck();
  deck[0] = { id: rotated.id, count: 4 };
  assert.ok(validateDeck(db, deck, "standard").errors.some((e) => e.code === "illegal"));
  assert.equal(isLegal(rotated, "expanded"), true);
});

test("legalita: starý Trainer s legálnym reprintom je legálny (§ 4.1.3)", () => {
  const oldBall = find((c) => c.c === "T" && c.n === "Ultra Ball" && c.rm === "G", "Ultra Ball G");
  assert.equal(isLegal(oldBall, "standard"), true);
});

test("legalita: Handbook § 4.1.3, príklad Copycat je tá istá karta", () => {
  const modern = db.byId.get("sm7-127");
  const old = db.byId.get("ex7-83");
  assert.equal(old.g, modern.g);
  assert.equal(isLegal(old, "expanded"), true);
});

test("legalita: Handbook § 4.1.3, príklad Rainbow Energy nie je tá istá karta", () => {
  const modern = db.byId.get("sm7-151");
  const old = db.byId.get("base5-17");
  assert.notEqual(old.g, modern.g);
  assert.equal(isLegal(old, "expanded"), false);
  assert.equal(needsLegalityCheck(old, "expanded"), true);
});

test("legalita: staré znenia rovnakého efektu sú legálne", () => {
  for (const id of ["sm1-135", "bw5-102", "bw2-95", "sm1-126", "bw2-92", "xy8-143", "swshp-SWSH251", "swsh1-156"]) {
    const card = db.byId.get(id);
    assert.ok(card, id);
    assert.equal(isLegal(card, "standard"), true, `${id} ${card.n} má byť legálna`);
    assert.equal(needsLegalityCheck(card, "standard"), false);
  }
});

test("legalita: skutočne iný efekt nie je legálny, ale hráč sa to dozvie", () => {
  // "Put 2" nie je "Put up to 2", "Shuffle 5" nie je "Shuffle up to 5".
  for (const id of ["bw1-92", "xy7-72", "xy2-96"]) {
    const card = db.byId.get(id);
    assert.ok(card, id);
    assert.equal(isLegal(card, "standard"), false, `${id} ${card.n} nemá byť legálna`);
    assert.equal(needsLegalityCheck(card, "standard"), true);
  }
});

test("dáta: rovnaká legálna karta nie je rozdelená na viac skupín", () => {
  const split = [];
  for (const groupIds of db.byName.values()) {
    const groups = [...groupIds].map((g) => db.groups.get(g));
    if (groups[0].cat === "P") continue;
    const legal = groups.filter((g) => g.prints.some((c) => isLegal(c, "standard")));
    if (legal.length > 1) split.push(groups[0].name);
  }
  assert.deepEqual(split, []);
});

test("dáta: stará Special Energy s menom základnej energie nie je základná", () => {
  const old = db.byId.get("ex13-95");
  assert.equal(nameKey(old.n), "metalenergy");
  assert.equal(isBasicEnergy(old), false);
  assert.equal(isLegal(old, "standard"), false);
  assert.equal(isLegal(old, "expanded"), false);
  assert.equal(isLegal(old, "unlimited"), true);
  assert.equal(needsLegalityCheck(old, "standard"), false);
});

test("dáta: limit kópií neobchádza Special Energy chybne vedená ako základná", () => {
  const energy = db.byId.get("me02.5-217");
  assert.equal(isBasicEnergy(energy), false);
  const allBasic = db.cards.filter(isBasicEnergy).map((c) => nameKey(c.n));
  assert.deepEqual(
    [...new Set(allBasic)].sort(),
    ["darknessenergy", "fairyenergy", "fightingenergy", "fireenergy", "grassenergy", "lightningenergy", "metalenergy", "psychicenergy", "waterenergy"],
  );
});

test("legalita: zakázaná karta neprejde v Expanded, v Unlimited áno", () => {
  const banned = find((c) => c.c === "T" && c.n === "Puzzle of Time", "Puzzle of Time");
  assert.equal(isLegal(banned, "expanded"), false);
  assert.equal(isLegal(banned, "unlimited"), true);
});

test("limit: druhá ACE SPEC karta neprejde", () => {
  const aces = db.cards.filter((c) => c.ace && isLegal(c, "standard"));
  const distinct = [...new Map(aces.map((c) => [nameKey(c.n), c])).values()];
  assert.ok(distinct.length >= 2, "v dátach musia byť aspoň 2 ACE SPEC karty");
  const deck = [
    { id: standardBasic.id, count: 4 },
    { id: distinct[0].id, count: 1 },
    { id: distinct[1].id, count: 1 },
    { id: fireEnergy.id, count: 54 },
  ];
  assert.ok(validateDeck(db, deck, "standard").errors.some((e) => e.code === "ace"));
});

function pendingFixture() {
  return {
    sets: { old: { a: "OLD", d: "2026-01-01" }, fresh: { a: "NEW", d: "2026-11-06", lf: "2026-11-20" } },
    cards: [
      { id: "old-1", n: "Stary Pokemon", s: "old", l: "1", c: "P", g: 1, lg: 7 },
      { id: "fresh-1", n: "Novy Pokemon", s: "fresh", l: "1", c: "P", g: 2, lg: 7, lo: 7 },
      { id: "old-2", n: "Reprint Pokemon", s: "old", l: "2", c: "P", g: 3, lg: 7, lo: 7 },
      { id: "fresh-2", n: "Reprint Pokemon", s: "fresh", l: "2", c: "P", g: 3, lg: 7, lo: 7 },
      // Rotovany Trainer: v Standarde je legalny len vdaka novemu vytlacku.
      { id: "old-3", n: "Stary Trainer", s: "old", l: "3", c: "T", g: 4, lg: 7, lo: 6 },
      { id: "fresh-3", n: "Stary Trainer", s: "fresh", l: "3", c: "T", g: 4, lg: 7, lo: 7 },
      { id: "fresh-4", n: "Novy Trainer", s: "fresh", l: "4", c: "T", g: 5, lg: 7, lo: 7 },
      { id: "fresh-5", n: "Fire Energy", s: "fresh", l: "5", c: "E", et: "B", g: 6, lg: 7, lo: 7 },
    ],
  };
}

test("nový set: pred dátumom legality sú legálne iba reprinty (§ 4.1.2 a 4.1.3)", () => {
  const before = createDb(pendingFixture(), { today: "2026-11-19" });
  const lg = (id) => before.byId.get(id).lg;
  assert.equal(lg("old-1"), 7);
  assert.equal(lg("fresh-1"), 0, "nový Pokémon ešte nie je legálny nikde");
  assert.equal(before.byId.get("fresh-1").lf, "2026-11-20");
  assert.equal(lg("fresh-2"), 7, "nový výtlačok hrateľnej karty je legálny hneď");
  assert.equal(lg("old-3"), 6, "starý Trainer ešte nemá legálny výtlačok v Standarde");
  assert.equal(lg("fresh-3"), 6);
  assert.equal(lg("fresh-4"), 0);
  assert.equal(lg("fresh-5"), 7, "základná energia je legálna vždy");
});

test("nový set: v deň legality je všetko legálne", () => {
  const after = createDb(pendingFixture(), { today: "2026-11-20" });
  for (const card of after.cards) {
    assert.equal(card.lg, 7, card.id);
    assert.equal(card.lf, undefined);
  }
});

test("nový set: turnajový deck s ešte nelegálnou kartou sa neponúka", () => {
  const before = createDb(pendingFixture(), { today: "2026-11-19" });
  const formatDecks = {
    archetypes: [
      { id: "a", name: "S novou kartou", share: 0.5, wins: 1, lists_total: 1, lists: [{ cards: [["fresh-1", 4], ["fresh-5", 56]] }] },
      { id: "b", name: "Bez novej karty", share: 0.5, wins: 1, lists_total: 1, lists: [{ cards: [["old-1", 4], ["fresh-5", 56]] }] },
    ],
  };
  const results = matchMetaDecks(before, formatDecks, new Map(), { format: "standard" });
  assert.deepEqual(results.map((r) => r.id), ["b"]);
});

test("dáta: sety pred dátumom legality majú pri kartách vlastnú legalitu", () => {
  const pending = Object.keys(cardsData.sets).filter((id) => cardsData.sets[id].lf);
  for (const setId of pending) {
    const cards = cardsData.cards.filter((c) => c.s === setId);
    assert.ok(cards.length > 0);
    assert.ok(cards.every((c) => typeof c.lo === "number"), `${setId}: chýba lo`);
    const day = new Date(`${cardsData.sets[setId].lf}T12:00:00Z`).getUTCDay();
    assert.equal(day, 5, `${setId}: dátum legality má byť piatok`);
    assert.ok(cardsData.sets[setId].lf > cardsData.sets[setId].d);
  }
});

test("dáta: dva sety s rovnakou skratkou sa nebijú o čísla kariet", () => {
  const main = parseCollectionText(db, "Greninja ex 30C 21", "standard").items[0];
  assert.equal(main.card.id, "30th-021");
  // Decklisty cisluju Classic Collection inak nez databaza, rozhodne meno v ramci setu.
  const classic = parseCollectionText(db, "Zacian V 30C CC26", "standard").items[0];
  assert.equal(classic.card.id, "30th-c-028");
  assert.equal(classic.ambiguous, false);
});

test("ceny: karty so spoločným produktom na Cardmarkete cenu nemajú", () => {
  // Tieto štyri promo karty mali v dátach rovnakú cenu 5 550 €.
  for (const id of ["xyp-XY101", "xyp-XY107", "xyp-XY125", "xyp-XY192"]) {
    assert.equal(db.byId.get(id).p, undefined, id);
  }
});

test("hodnota zbierky: súčty, neznáme ceny a karty na predaj", () => {
  const priced = db.cards.filter((c) => typeof c.p === "number");
  const cheap = priced.find((c) => c.p < 1);
  const pricey = priced.find((c) => c.p >= 5 && c.p < 50);
  const kept = priced.find((c) => c.p >= 5 && c.p < 50 && c.g !== pricey.g);
  const unpriced = db.cards.find((c) => typeof c.p !== "number");
  const collection = new Map([[cheap.id, 3], [pricey.id, 2], [kept.id, 1], [unpriced.id, 4]]);
  const value = collectionValue(db, collection, { keepGroups: new Set([kept.g]) });
  assert.ok(Math.abs(value.total - (cheap.p * 3 + pricey.p * 2 + kept.p)) < 0.011);
  assert.equal(value.unknown, 4);
  assert.equal(value.singlesCount, 3);
  assert.equal(value.bulkCount, 3);
  assert.ok(Math.abs(value.singlesValue + value.bulkValue - value.total) < 0.011);
  assert.deepEqual(value.rows.filter((r) => r.sell).map((r) => r.card.id), [pricey.id]);
  assert.equal(value.sellCount, 2);
  assert.equal(value.rows.find((r) => r.card.id === kept.id).inDeck, true);
  // Karta, ktora sa hra na turnajoch, na predaj nejde.
  const played = collectionValue(db, collection, { usage: new Map([[pricey.g, { rate: 0.4, avg: 2 }]]) });
  assert.equal(played.rows.find((r) => r.card.id === pricey.id).sell, false);
});

test("mulligan: známa hodnota pre 10 Basic Pokémonov", () => {
  assert.ok(Math.abs(mulliganChance(10) - 0.2573) < 0.01);
  assert.equal(mulliganChance(0), 1);
});

test("zadanie: rôzne zápisy riadku", () => {
  assert.equal(parseLine("4 Ultra Ball").qty, 4);
  assert.equal(parseLine("Ultra Ball x3").qty, 3);
  assert.equal(parseLine("3x Ultra Ball").qty, 3);
  const numbered = parseLine("2 Pikachu SVI 57");
  assert.deepEqual([numbered.qty, numbered.name, numbered.code, numbered.number], [2, "Pikachu", "SVI", "57"]);
  const printed = parseLine("Charmander 26/165");
  assert.deepEqual([printed.name, printed.number], ["Charmander", "26"]);
});

test("zadanie: 4/165 vyberie set podľa počtu kariet", () => {
  const { items } = parseCollectionText(db, "Charmander 4/165", "standard");
  assert.equal(items.length, 1);
  assert.equal(items[0].card.s, "sv03.5");
  assert.equal(items[0].ambiguous, false);
});

test("zadanie: trainer so starou verziou sa zbytočne nepýta", () => {
  const { items } = parseCollectionText(db, "4 Ultra Ball", "standard");
  assert.equal(items[0].ambiguous, false);
  const pikachu = parseCollectionText(db, "Pikachu", "standard").items[0];
  assert.equal(pikachu.ambiguous, true);
});

test("zadanie: zoznam s preklepom a neznámym riadkom", () => {
  const { items, problems } = parseCollectionText(
    db,
    "Pokémon: 2\n4 Ultra Ball\n1 Ultra Bal\n2 Toto neexistuje vobec",
    "standard",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].card.n, "Ultra Ball");
  assert.equal(problems.length, 2);
  assert.ok(problems[0].suggestions.includes("Ultra Ball"));
});

test("zadanie: meno, ktoré končí slovom a číslom, nepadne na zlý set", () => {
  const { items } = parseCollectionText(db, "1 Fire Energy", "standard");
  assert.equal(nameKey(items[0].card.n), "fireenergy");
});

test("porovnanie: skutočné turnajové decky spĺňajú naše pravidlá", () => {
  for (const format of ["standard", "expanded"]) {
    let checked = 0;
    const failures = [];
    for (const archetype of decks[format].archetypes) {
      for (const list of archetype.lists) {
        checked += 1;
        const result = validateDeck(db, list.cards.map(([id, count]) => ({ id, count })), format);
        const hard = result.errors.filter((e) => e.code !== "illegal");
        if (hard.length) failures.push(`${archetype.name}: ${hard.map((e) => e.message).join("; ")}`);
      }
    }
    assert.ok(checked > 0, `${format}: žiadne decky`);
    assert.deepEqual(failures, [], `${format}: ${failures.length}/${checked} deckov porušilo pravidlá`);
  }
});

test("porovnanie: deck, ktorý celý vlastním, stojí 0 €", () => {
  const archetype = decks.standard.archetypes[0];
  const list = archetype.lists[0];
  const collection = new Map();
  for (const [id, count] of list.cards) {
    addToCollection(collection, db.byId.get(id), count);
  }
  const results = matchMetaDecks(db, decks.standard, collection, { format: "standard" });
  const match = results.find((r) => r.id === archetype.id);
  assert.equal(match.ownedCount, 60);
  assert.equal(match.cost, 0);
  assert.equal(match.missing.length, 0);
});

test("porovnanie: rotovaný výtlačok Pokémona sa ako vlastnený neráta", () => {
  // Skupina s legálnym aj nelegálnym výtlačkom.
  const group = [...db.groups.values()].find(
    (g) => g.cat === "P" && g.prints.some((c) => isLegal(c, "standard")) && g.prints.some((c) => !isLegal(c, "standard")),
  );
  if (!group) return;
  const rotated = group.prints.find((c) => !isLegal(c, "standard"));
  const collection = new Map([[rotated.id, 4]]);
  const owned = ownedGroups(db, collection, "standard");
  assert.equal(owned.get(group.g).qty, 4);
  assert.equal(owned.get(group.g).legalQty, 0);
});

// Jednoduchy generator, aby test dopadol pri kazdom behu rovnako.
function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

function randomBulk(random, format, size) {
  const pool = db.cards.filter((c) => isLegal(c, format) && c.im);
  const collection = new Map();
  for (let i = 0; i < size; i++) {
    const card = pool[Math.floor(random() * pool.length)];
    collection.set(card.id, 1 + Math.floor(random() * 4));
  }
  return collection;
}

function assertDeckIsSound(deck, collection, format, label) {
  const entries = deck.cards.map((e) => ({ id: e.card.id, count: e.count }));
  assert.ok(deck.stats.energy > 0, `${label}: deck bez energie`);
  const result = validateDeck(db, entries, format);
  assert.deepEqual(result.errors, [], `${label}: porušené pravidlá`);
  assert.deepEqual(result.warnings, [], `${label}: evolúcia bez predchodcu`);
  const owned = ownedGroups(db, collection, format);
  for (const entry of deck.cards) {
    assert.ok(entry.owned <= entry.count, `${label}: ${entry.card.n} owned > count`);
    if (!isBasicEnergy(entry.card)) {
      assert.ok(
        entry.owned <= (owned.get(entry.g)?.legalQty ?? 0),
        `${label}: ${entry.card.n} sľubuje viac kusov, než hráč má`,
      );
    }
  }
}

test("zostavenie: ukážkový bulk dá legálne decky v každom formáte", () => {
  const collection = new Map(demo);
  for (const format of ["standard", "expanded", "unlimited"]) {
    const formatDecks = format === "unlimited" ? decks.standard : decks[format];
    const { decks: built } = buildFromCollection(db, formatDecks, collection, { format });
    assert.ok(built.length >= 1, `${format}: žiadny deck`);
    built.forEach((deck, index) => assertDeckIsSound(deck, collection, format, `${format} #${index}`));
  }
});

test("zostavenie: hlavný útok sa dá zaplatiť energiou v decku", () => {
  const random = seeded(99);
  const collections = [new Map(demo), randomBulk(random, "standard", 300), randomBulk(random, "standard", 120)];
  let checked = 0;
  for (const collection of collections) {
    const { decks: built } = buildFromCollection(db, decks.standard, collection, { format: "standard" });
    for (const deck of built) {
      const energy = new Set(deck.cards.filter((e) => e.card.c === "E").map((e) => e.card.ty));
      const attack = deck.attacker.at.find(([name]) => name === deck.reasons[0].attack);
      const colors = [...attack[1]].filter((letter) => letter !== "C");
      for (const letter of colors) {
        assert.ok(energy.has(letter), `${deck.attacker.n}: ${attack[0]} potrebuje ${letter}, deck má ${[...energy]}`);
      }
      assert.ok(energy.size >= 1, "deck bez energie");
      checked += 1;
    }
  }
  assert.ok(checked > 0);
});

test("zostavenie: náhodné zbierky nikdy neporušia pravidlá", () => {
  const random = seeded(2026);
  for (let run = 0; run < 40; run++) {
    const format = ["standard", "expanded", "unlimited"][run % 3];
    const size = 20 + Math.floor(random() * 500);
    const collection = randomBulk(random, format, size);
    const formatDecks = format === "unlimited" ? decks.standard : decks[format];
    const { decks: built } = buildFromCollection(db, formatDecks, collection, { format });
    built.forEach((deck, index) => assertDeckIsSound(deck, collection, format, `run ${run} ${format} #${index}`));
  }
});

test("zostavenie: z jedného Pokémona vznikne deck s rozumným počtom Basic Pokémonov", () => {
  const pikachu = find((c) => c.n === "Pikachu" && isLegal(c, "standard") && c.at?.length, "Pikachu");
  const collection = new Map([[pikachu.id, 1]]);
  const { decks: built } = buildFromCollection(db, decks.standard, collection, { format: "standard" });
  assert.ok(built.length >= 1);
  for (const deck of built) {
    assertDeckIsSound(deck, collection, "standard", "jeden Pokémon");
    assert.ok(deck.stats.basics >= 8, `iba ${deck.stats.basics} Basic Pokémonov`);
    assert.ok(deck.stats.mulligan < 0.35, `mulligan ${deck.stats.mulligan}`);
    assert.ok(deck.missing.length > 0, "musí navrhnúť nákup");
    assert.ok(deck.cost > 0);
  }
});

test("zostavenie: bez základnej energie je energia v nákupe, nie zadarmo", () => {
  const collection = new Map(demo);
  const { decks: built } = buildFromCollection(db, decks.standard, collection, {
    format: "standard",
    assumeBasicEnergy: false,
  });
  assert.ok(built.length >= 1);
  for (const deck of built) {
    assertDeckIsSound(deck, collection, "standard", "bez energie");
    assert.ok(deck.stats.energy >= 8, `iba ${deck.stats.energy} energie`);
    // Ukazkovy bulk ziadnu zakladnu energiu nema, takze musi byt v nakupe.
    assert.ok(deck.missing.some((m) => isBasicEnergy(m.card)), "energia musí byť v nákupnom zozname");
    for (const entry of deck.cards) {
      if (!isBasicEnergy(entry.card)) continue;
      const have = ownedGroups(db, collection, "standard").get(entry.g)?.legalQty ?? 0;
      assert.ok(entry.owned <= have, "energia, ktorú hráč nemá, nesmie byť vedená ako vlastnená");
    }
  }
});

test("vylepšenia: deck po nich má stále 60 kariet a spĺňa pravidlá", () => {
  const random = seeded(77);
  const collections = [new Map(demo), randomBulk(random, "standard", 200), randomBulk(random, "standard", 60)];
  let applied = 0;
  for (const collection of collections) {
    const { decks: built } = buildFromCollection(db, decks.standard, collection, { format: "standard" });
    for (const deck of built) {
      if (!deck.upgrades.length) continue;
      applied += 1;
      const cards = applyUpgrades(deck, deck.upgrades);
      const result = validateDeck(db, cards.map((e) => ({ id: e.card.id, count: e.count })), "standard");
      assert.deepEqual(result.errors, []);
      assert.equal(deckStats(cards).pokemon + deckStats(cards).trainer + deckStats(cards).energy, 60);
      const summary = summarizeMissing(db, cards, "standard");
      assert.ok(summary.cost >= 0);
    }
  }
  assert.ok(applied > 0, "test musí aspoň raz naozaj použiť vylepšenia");
});
