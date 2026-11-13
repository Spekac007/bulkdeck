// Logika appky bez DOM, aby sa dala testovat v Node.

export const FORMATS = {
  standard: { bit: 1, label: "Standard" },
  expanded: { bit: 2, label: "Expanded" },
  unlimited: { bit: 4, label: "Unlimited" },
};

export const DECK_SIZE = 60;
export const MAX_COPIES = 4;

const CATEGORY_ORDER = { P: 0, T: 1, E: 2 };
const TAG = { draw: 1, search: 2, switch: 4, gust: 8, heal: 16, recover: 32, accel: 64 };

export function nameKey(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/’/g, "'")
    .replace(/◇/g, " prism star")
    .toLowerCase()
    .replace(/^basic (?=\w+ energy$)/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function numberKey(number) {
  const value = String(number ?? "").trim().toUpperCase();
  const match = value.match(/^([A-Z]*)0*(\d+)$/);
  return match ? match[1] + match[2] : value;
}

export function isBasicEnergy(card) {
  return card.c === "E" && card.et === "B";
}

export function localIsoDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Karty zo setov pred datumom legality (Handbook, par. 4.1.2) este nie su legalne.
 * Novy vytlacok karty, ktora sa uz hrat da, je legalny hned (par. 4.1.3).
 * Build pocita legalitu tak, akoby boli legalne vsetky sety, a pre dotknute karty pribali
 * vlastnu legalitu vytlacku v "lo". Tu sa z nej legalita prepocita k dnesnemu dnu.
 */
function applyPendingSets(sets, groups, today) {
  const pending = new Set(Object.keys(sets).filter((id) => sets[id].lf && sets[id].lf > today));
  if (!pending.size) return;
  for (const group of groups.values()) {
    const waiting = group.prints.filter((card) => pending.has(card.s));
    if (!waiting.length) continue;
    const sample = group.prints[0];
    if (sample.c === "E" && sample.et === "B") continue;
    let base = 0;
    for (const card of group.prints) {
      if (!pending.has(card.s)) base |= card.lo ?? card.lg;
    }
    for (const card of group.prints) {
      const isWaiting = pending.has(card.s);
      // Trainer a Special Energy zdielaju legalitu v ramci karty, Pokemon ma kazdy vytlacok vlastnu.
      const next = sample.c === "P" ? (isWaiting ? (card.lo ?? card.lg) & base : card.lo ?? card.lg) : base;
      if (next !== card.lg) {
        card.lg = next;
        if (isWaiting) card.lf = sets[card.s].lf;
      }
    }
  }
}

export function createDb({ sets, cards }, { today = localIsoDate() } = {}) {
  const byId = new Map();
  const groups = new Map();
  const byName = new Map();
  // Dva sety mozu mat rovnaku skratku, preto je pod jednym klucom zoznam.
  const byCode = new Map();
  const byCodeName = new Map();
  const push = (map, key, card) => {
    const list = map.get(key);
    if (!list) map.set(key, [card]);
    else if (!list.includes(card)) list.push(card);
  };
  for (const card of cards) {
    byId.set(card.id, card);
    let group = groups.get(card.g);
    if (!group) {
      group = { g: card.g, name: card.n, cat: card.c, prints: [] };
      groups.set(card.g, group);
    }
    group.prints.push(card);
    const key = nameKey(card.n);
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key).add(card.g);
    const code = sets[card.s]?.a;
    if (code) {
      push(byCode, `${code.toUpperCase()}|${numberKey(card.l)}`, card);
      push(byCodeName, `${code.toUpperCase()}|${key}`, card);
    }
    push(byCode, `${card.s.toUpperCase()}|${numberKey(card.l)}`, card);
    const other = sets[card.s]?.o;
    if (other) {
      push(byCode, `${other.toUpperCase()}|${numberKey(card.l)}`, card);
      push(byCodeName, `${other.toUpperCase()}|${key}`, card);
      // Promo karty maju v cisle predponu: "PR-SW 154" je karta SWSH154.
      const digits = numberKey(card.l).replace(/^[A-Z]+/, "");
      if (digits !== numberKey(card.l)) push(byCode, `${other.toUpperCase()}|${digits}`, card);
    }
  }
  applyPendingSets(sets, groups, today);
  return { sets, cards, byId, groups, byName, byCode, byCodeName, cache: new Map() };
}

export function releaseDate(db, card) {
  return db.sets[card.s]?.d ?? "";
}

export function setCode(db, card) {
  return db.sets[card.s]?.a ?? card.s.toUpperCase();
}

export function isLegal(card, format) {
  return Boolean(card.lg & FORMATS[format].bit);
}

/** Karta nie je legalna, ale ma rovnake meno ako legalna karta s inym textom. Rozhodnut to musi clovek. */
export function needsLegalityCheck(card, format) {
  return Boolean((card.mb ?? 0) & FORMATS[format].bit);
}

// Najlacnejsi legalny vytlacok skupiny, podla neho sa rata cena dokupenia.
export function cheapestPrint(db, g, format) {
  const key = `cheap|${g}|${format}`;
  if (db.cache.has(key)) return db.cache.get(key);
  const prints = db.groups.get(g)?.prints ?? [];
  const legal = prints.filter((c) => isLegal(c, format));
  const pool = legal.length ? legal : prints;
  const priced = pool.filter((c) => typeof c.p === "number");
  const best = priced.length
    ? priced.reduce((a, b) => (b.p < a.p ? b : a))
    : newestOf(db, pool);
  db.cache.set(key, best ?? null);
  return best ?? null;
}

function newestOf(db, cards) {
  let best = null;
  for (const card of cards) {
    if (!best || releaseDate(db, card) > releaseDate(db, best)) best = card;
  }
  return best;
}

/** Vytlacok na zobrazenie: najlacnejsi s obrazkom, aby deck nemal prazdne miesta. */
export function displayPrint(db, g, format) {
  const key = `show|${g}|${format}`;
  if (db.cache.has(key)) return db.cache.get(key);
  const prints = db.groups.get(g)?.prints ?? [];
  const legal = prints.filter((c) => isLegal(c, format) && c.im);
  const pool = legal.length ? legal : prints.filter((c) => c.im);
  const priced = pool.filter((c) => typeof c.p === "number");
  const best = priced.length
    ? priced.reduce((a, b) => (b.p < a.p ? b : a))
    : (newestOf(db, pool) ?? cheapestPrint(db, g, format));
  db.cache.set(key, best ?? null);
  return best ?? null;
}

export function newestPrint(db, g, format) {
  const prints = db.groups.get(g)?.prints ?? [];
  const legal = prints.filter((c) => isLegal(c, format));
  const pool = legal.length ? legal : prints;
  const withImage = pool.filter((c) => c.im);
  return newestOf(db, withImage.length ? withImage : pool);
}

/* ---------- Zadanie zbierky ---------- */

const HEADER_LINE = /^(pok[eé]mon|trainer|trainers|energy|total cards|spolu|###?.*)\s*:?\s*\d*\s*$/i;

function levenshtein(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let smallest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      smallest = Math.min(smallest, current[j]);
    }
    if (smallest > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

export function suggestNames(db, text, limit = 3) {
  const key = nameKey(text);
  if (key.length < 3) return [];
  const tolerance = Math.max(2, Math.floor(key.length / 4));
  const scored = [];
  for (const [candidate, groupIds] of db.byName) {
    const distance = candidate.includes(key) ? 0 : levenshtein(key, candidate, tolerance);
    if (distance <= tolerance) {
      const group = db.groups.get([...groupIds][0]);
      scored.push({ name: group.name, distance, length: candidate.length });
    }
  }
  scored.sort((a, b) => a.distance - b.distance || a.length - b.length);
  return scored.slice(0, limit).map((s) => s.name);
}

export function parseLine(line) {
  let rest = line.trim().replace(/^[-*•]\s*/, "");
  let qty = 1;
  let match = rest.match(/^(\d{1,3})\s*[x×]?\s+(.+)$/i);
  if (match) {
    qty = Number(match[1]);
    rest = match[2];
  } else {
    match = rest.match(/^(.+?)\s+[x×]\s*(\d{1,3})$/i) || rest.match(/^(.+?)\s+(\d{1,3})\s*[x×]$/i);
    if (match) {
      qty = Number(match[2]);
      rest = match[1];
    }
  }
  rest = rest.replace(/\s*\(([^)]*)\)\s*$/, " $1").trim();

  let name = rest;
  let code = null;
  let number = null;
  let total = null;
  // "Pikachu 57/198" alebo samotne "57/198"
  match = rest.match(/^(.*?)\s*#?([A-Za-z]{0,4}\d+[a-z]?)\s*\/\s*([A-Za-z]{0,4})(\d+)$/);
  if (match) {
    name = match[1].trim();
    number = match[2];
    // Pri "TG02/TG30" nie je cislo za lomkou velkost setu.
    total = match[3] ? null : Number(match[4]);
  } else {
    // "Pikachu SVI 57", "SVI 57", "sv01-057"
    match = rest.match(/^(?:(.*?)\s+)?([A-Za-z0-9.-]{2,8}?)[\s-]+#?([A-Za-z]{0,4}\d+[a-z]?)$/);
    if (match && /[A-Za-z]/.test(match[2])) {
      name = (match[1] ?? "").trim();
      code = match[2];
      number = match[3];
    }
  }
  return { qty, name, code, number, total, text: rest };
}

// Zo vsetkych verzii karty s rovnakym menom vyberie tie, ktore sa v hre lisia.
export function versionsOfName(db, name, format) {
  const groupIds = db.byName.get(nameKey(name));
  if (!groupIds) return [];
  return [...groupIds]
    .map((g) => newestPrint(db, g, format))
    .filter(Boolean)
    .sort((a, b) => {
      const legal = Number(isLegal(b, format)) - Number(isLegal(a, format));
      return legal || (releaseDate(db, b) > releaseDate(db, a) ? 1 : -1);
    });
}

/** Vytlacok podla skratky setu a cisla. Ked cislo nesedi, pomoze meno, ak je v sete iba raz. */
export function findPrint(db, code, number, name) {
  const prefix = String(code).toUpperCase();
  const list = db.byCode.get(`${prefix}|${numberKey(number)}`) ?? [];
  if (!name) return list[0] ?? null;
  const wanted = nameKey(name);
  const exact = list.find((card) => nameKey(card.n) === wanted);
  if (exact) return exact;
  const named = db.byCodeName.get(`${prefix}|${wanted}`) ?? [];
  return named.length === 1 ? named[0] : null;
}

export function parseCollectionText(db, text, format = "standard") {
  const items = [];
  const problems = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || HEADER_LINE.test(line)) continue;
    const parsed = parseLine(line);
    if (parsed.qty <= 0) continue;

    let card = null;
    if (parsed.code && parsed.number) {
      card = findPrint(db, parsed.code, parsed.number, parsed.name);
    }
    if (!card && parsed.number && !parsed.code && parsed.name) {
      const groupIds = db.byName.get(nameKey(parsed.name));
      if (groupIds) {
        const prints = [...groupIds]
          .flatMap((g) => db.groups.get(g).prints)
          .filter((c) => numberKey(c.l) === numberKey(parsed.number));
        // Velkost setu z "26/165" vyberie spravny set, inak by mohla vyjst zla legalita.
        const inSet = parsed.total ? prints.filter((c) => db.sets[c.s]?.t === parsed.total) : prints;
        card = newestOf(db, inSet);
      }
    }
    if (card) {
      items.push({ card, qty: parsed.qty, line, ambiguous: false });
      continue;
    }

    // Cislo vytlacku sa nenaslo, skusime este cele meno. "Team Rocket's Mewtwo ex" nesmie skoncit ako set.
    const nameCandidates = [parsed.text, parsed.name].filter(Boolean);
    let versions = [];
    for (const candidate of nameCandidates) {
      versions = versionsOfName(db, candidate, format);
      if (versions.length) break;
    }
    if (versions.length) {
      // Pytat sa treba, len ak je na vyber viac kariet, ktore sa daju v tomto formate hrat.
      const playable = versions.filter((version) => isLegal(version, format)).length;
      items.push({ card: versions[0], qty: parsed.qty, line, ambiguous: playable > 1 || (playable === 0 && versions.length > 1) });
      continue;
    }
    problems.push({ line, qty: parsed.qty, suggestions: suggestNames(db, parsed.name || parsed.text) });
  }
  return { items, problems };
}

export function addToCollection(collection, card, qty = 1) {
  const next = (collection.get(card.id) ?? 0) + qty;
  if (next <= 0) collection.delete(card.id);
  else collection.set(card.id, next);
  return collection;
}

/** Kolko kusov z kazdej funkcnej skupiny hrac vlastni a kolko z nich je legalnych. */
export function ownedGroups(db, collection, format) {
  const owned = new Map();
  for (const [id, qty] of collection) {
    const card = db.byId.get(id);
    if (!card || qty <= 0) continue;
    let entry = owned.get(card.g);
    if (!entry) {
      entry = { g: card.g, qty: 0, legalQty: 0, prints: [] };
      owned.set(card.g, entry);
    }
    entry.qty += qty;
    if (isLegal(card, format)) {
      entry.legalQty += qty;
      entry.prints.push(card);
    }
  }
  return owned;
}

export function collectionSummary(db, collection, format) {
  let total = 0;
  let legal = 0;
  for (const [id, qty] of collection) {
    const card = db.byId.get(id);
    if (!card) continue;
    total += qty;
    if (isLegal(card, format)) legal += qty;
  }
  return { total, legal };
}

/**
 * Orientacna hodnota zbierky. Ceny su pre najlacnejsi variant karty, takze je to skor dolny odhad.
 * keepGroups: karty, ktore hrac pouziva vo svojich deckoch. usage: ako casto sa karta hra na turnajoch.
 */
export function collectionValue(db, collection, { usage = new Map(), keepGroups = new Set(), singleFrom = 1 } = {}) {
  const rows = [];
  let total = 0;
  let unknown = 0;
  let singlesValue = 0;
  let singlesCount = 0;
  let bulkCount = 0;
  for (const [id, qty] of collection) {
    const card = db.byId.get(id);
    if (!card || qty <= 0) continue;
    if (typeof card.p !== "number") {
      unknown += qty;
      continue;
    }
    const value = card.p * qty;
    total += value;
    if (card.p >= singleFrom) {
      singlesValue += value;
      singlesCount += qty;
    } else {
      bulkCount += qty;
    }
    const played = usage.get(card.g)?.rate ?? 0;
    const inDeck = keepGroups.has(card.g);
    rows.push({
      card,
      qty,
      unit: card.p,
      value: round2(value),
      played,
      inDeck,
      // Na predaj: stoji za to predavat ju samostatne, nehras ju a nehra sa ani na turnajoch.
      sell: card.p >= singleFrom && !inDeck && played < 0.05,
    });
  }
  rows.sort((a, b) => b.unit - a.unit || b.value - a.value || a.card.n.localeCompare(b.card.n));
  const sell = rows.filter((row) => row.sell);
  return {
    total: round2(total),
    unknown,
    singlesValue: round2(singlesValue),
    singlesCount,
    bulkValue: round2(total - singlesValue),
    bulkCount,
    sellValue: round2(sell.reduce((sum, row) => sum + row.value, 0)),
    sellCount: sell.reduce((sum, row) => sum + row.qty, 0),
    rows,
  };
}

export function usageByGroup(formatDecks) {
  return usageMap(formatDecks);
}

/* ---------- Pravidla decku ---------- */

// Pravdepodobnost, ze v prvych 7 kartach nebude ziadny Basic Pokemon.
export function mulliganChance(basics, deckSize = DECK_SIZE, hand = 7) {
  if (basics <= 0) return 1;
  let chance = 1;
  for (let i = 0; i < hand; i++) chance *= (deckSize - basics - i) / (deckSize - i);
  return Math.max(0, chance);
}

/**
 * Oficialne pravidla z TCG Tournament Handbook, kap. 4, a limity vytlacene na kartach.
 * entries: [{ id, count }]
 */
export function validateDeck(db, entries, format) {
  const errors = [];
  const warnings = [];
  const nameCounts = new Map();
  let total = 0;
  let basics = 0;
  let aces = 0;
  let radiants = 0;
  const namesInDeck = new Set();
  const evolvers = [];

  for (const { id, count } of entries) {
    const card = db.byId.get(id);
    if (!card) {
      errors.push({ code: "unknown", message: `Neznáma karta: ${id}` });
      continue;
    }
    total += count;
    if (!isLegal(card, format)) {
      errors.push({
        code: "illegal",
        message: `${card.n} (${setCode(db, card)} ${card.l}) nie je legálna vo formáte ${FORMATS[format].label}.`,
      });
    }
    if (card.c === "P") {
      namesInDeck.add(nameKey(card.n));
      if (card.st === "Basic") basics += count;
      if (card.ef) evolvers.push(card);
    }
    if (!isBasicEnergy(card)) {
      const key = nameKey(card.n);
      const entry = nameCounts.get(key) ?? { name: card.n, count: 0, prism: false };
      entry.count += count;
      entry.prism = entry.prism || Boolean(card.pri);
      nameCounts.set(key, entry);
    }
    if (card.ace) aces += count;
    if (card.rad) radiants += count;
  }

  if (total !== DECK_SIZE) {
    errors.push({ code: "size", message: `Deck musí mať presne ${DECK_SIZE} kariet, má ${total}.` });
  }
  for (const entry of nameCounts.values()) {
    if (entry.count > MAX_COPIES) {
      errors.push({
        code: "copies",
        message: `${entry.name}: ${entry.count} kusy, povolené sú najviac ${MAX_COPIES} s rovnakým menom.`,
      });
    }
    if (entry.prism && entry.count > 1) {
      errors.push({ code: "prism", message: `${entry.name}: Prism Star môže byť v decku iba raz.` });
    }
  }
  if (basics < 1) errors.push({ code: "basic", message: "Deck musí mať aspoň 1 Basic Pokémona." });
  if (aces > 1) errors.push({ code: "ace", message: "V decku môže byť iba 1 ACE SPEC karta." });
  if (radiants > 1) errors.push({ code: "radiant", message: "V decku môže byť iba 1 Radiant Pokémon." });

  for (const card of evolvers) {
    if (!namesInDeck.has(nameKey(card.ef))) {
      warnings.push({ code: "evolution", message: `${card.n} sa vyvíja z ${card.ef}, ten v decku nie je.` });
    }
  }
  return { ok: errors.length === 0, errors, warnings, total, basics };
}

/* ---------- Porovnanie s turnajovymi deckmi ---------- */

function evaluateList(db, list, owned, format, assumeBasicEnergy) {
  const needs = new Map();
  for (const [id, count] of list.cards) {
    const card = db.byId.get(id);
    if (!card) continue;
    const entry = needs.get(card.g) ?? { g: card.g, card, count: 0 };
    entry.count += count;
    needs.set(card.g, entry);
  }

  const cards = [];
  const missing = [];
  let ownedCount = 0;
  let cost = 0;
  let unknownPrices = 0;
  for (const need of needs.values()) {
    const basic = isBasicEnergy(need.card);
    const have = basic && assumeBasicEnergy
      ? need.count
      : Math.min(owned.get(need.g)?.legalQty ?? 0, need.count);
    ownedCount += have;
    const lacking = need.count - have;
    const shown = owned.get(need.g)?.prints[0] ?? displayPrint(db, need.g, format) ?? need.card;
    cards.push({ g: need.g, card: shown, count: need.count, owned: have });
    if (lacking > 0) {
      const print = cheapestPrint(db, need.g, format) ?? need.card;
      const unit = typeof print.p === "number" ? print.p : null;
      if (unit === null) unknownPrices += lacking;
      else cost += unit * lacking;
      missing.push({ g: need.g, card: print, count: lacking, unit });
    }
  }
  sortEntries(cards);
  missing.sort((a, b) => (b.unit ?? 0) - (a.unit ?? 0));
  return { list, cards, missing, ownedCount, cost: round2(cost), unknownPrices };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export function sortEntries(entries) {
  entries.sort((a, b) => {
    const category = CATEGORY_ORDER[a.card.c] - CATEGORY_ORDER[b.card.c];
    if (category) return category;
    return b.count - a.count || a.card.n.localeCompare(b.card.n);
  });
  return entries;
}

export function matchMetaDecks(db, formatDecks, collection, { format, assumeBasicEnergy = true }) {
  const owned = ownedGroups(db, collection, format);
  const results = [];
  for (const archetype of formatDecks?.archetypes ?? []) {
    let best = null;
    for (const list of archetype.lists) {
      // Online turnaje pustaju novy set skor. Deck s kartou, ktora este nie je legalna, neponukame.
      if (!list.cards.every(([id]) => db.byId.has(id) && isLegal(db.byId.get(id), format))) continue;
      const evaluated = evaluateList(db, list, owned, format, assumeBasicEnergy);
      if (
        !best ||
        evaluated.cost < best.cost ||
        (evaluated.cost === best.cost && evaluated.ownedCount > best.ownedCount)
      ) {
        best = evaluated;
      }
    }
    if (best) {
      results.push({
        id: archetype.id,
        name: archetype.name,
        share: archetype.share,
        wins: archetype.wins,
        listsTotal: archetype.lists_total,
        listsChecked: archetype.lists.length,
        ...best,
      });
    }
  }
  return results;
}

/* ---------- Deck z vlastnych kariet ---------- */

const COST_FACTOR = [1.1, 1.05, 1, 0.85, 0.7, 0.55, 0.45];

function usageMap(formatDecks) {
  const map = new Map();
  for (const [g, rate, avg] of formatDecks?.usage ?? []) map.set(g, { rate, avg });
  return map;
}

// Najlepsi utok, ktory sa da zaplatit energiami v allowed (bez allowed lubovolny).
function bestAttack(card, allowed) {
  let best = null;
  for (const [name, cost, damage, printed] of card.at ?? []) {
    const colors = new Set([...cost].filter((letter) => letter !== "C"));
    // Deck hra jednou farbou energie, dvojfarebny utok by sa nedal zaplatit.
    if (colors.size > 1) continue;
    if (allowed && [...colors].some((letter) => !allowed.has(letter))) continue;
    const value = damage * (COST_FACTOR[Math.min(cost.length, 6)] ?? 0.45);
    if (!best || value > best.value) best = { name, cost, damage, printed, value };
  }
  return best;
}

function pokemonScore(card, usage, allowed) {
  const attack = bestAttack(card, allowed);
  let score = attack ? attack.value : 0;
  score += (card.hp ?? 0) * 0.12;
  if (card.st === "Stage1") score *= 0.97;
  if (card.st === "Stage2") score *= 0.92;
  if (card.rb) score *= 0.92;
  if (card.ab?.length) score += 8;
  if (card.fx & (TAG.draw | TAG.search | TAG.accel)) score += 14;
  score += (usage.get(card.g)?.rate ?? 0) * 60;
  return score;
}

function ownedPokemonIndex(db, owned) {
  const byName = new Map();
  for (const entry of owned.values()) {
    if (entry.legalQty <= 0) continue;
    const card = entry.prints[0];
    if (card.c !== "P") continue;
    const key = nameKey(card.n);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }
  return byName;
}

/** Evolucna linia od zakladu po kartu. Vrati chybajuce mena, ak sa neda postavit. */
function evolutionChain(card, byName) {
  const chain = [card];
  const missing = [];
  let current = card;
  for (let depth = 0; depth < 4 && current.ef; depth++) {
    const options = byName.get(nameKey(current.ef));
    if (!options?.length) {
      missing.push(current.ef);
      break;
    }
    const pick = options.reduce((a, b) => (b.legalQty > a.legalQty ? b : a));
    current = pick.prints[0];
    chain.unshift(current);
  }
  const startsAtBasic = chain[0].st === "Basic" || !chain[0].ef;
  const restored = chain[0].st === "Restored" || chain[0].st === "V-UNION";
  return { chain, missing, playable: missing.length === 0 && startsAtBasic && !restored };
}

const BASIC_ENERGY_LETTERS = ["G", "R", "W", "L", "P", "F", "D", "M", "Y"];

/** Bezfarebny utocnik moze hrat s hocijakou energiou, vyberieme tu s najlepsimi partnermi. */
function bestCompanionColor(owned, usage) {
  const totals = new Map();
  for (const letter of BASIC_ENERGY_LETTERS) {
    const allowed = new Set([letter]);
    const scores = [];
    for (const entry of owned.values()) {
      if (entry.legalQty <= 0) continue;
      const card = entry.prints[0];
      if (card.c !== "P" || !card.at?.some(([, cost]) => cost.includes(letter))) continue;
      scores.push(pokemonScore(card, usage, allowed));
    }
    scores.sort((a, b) => b - a);
    totals.set(letter, scores.slice(0, 4).reduce((sum, value) => sum + value, 0));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function mainColor(card, attack, companionColor) {
  const colored = [...(attack?.cost ?? "")].find((letter) => letter !== "C");
  if (colored) return colored;
  const own = card.ty?.[0];
  return own && BASIC_ENERGY_LETTERS.includes(own) ? own : companionColor;
}

class DeckDraft {
  constructor(db, owned, format) {
    this.db = db;
    this.owned = owned;
    this.format = format;
    this.entries = new Map();
    this.names = new Map();
    this.total = 0;
    this.aceUsed = false;
    this.radiantUsed = false;
  }

  room(card, wanted) {
    let allowed = Math.min(wanted, DECK_SIZE - this.total);
    if (isBasicEnergy(card)) return Math.max(0, allowed);
    allowed = Math.min(allowed, MAX_COPIES - (this.names.get(nameKey(card.n)) ?? 0));
    if (card.ace) allowed = this.aceUsed ? 0 : Math.min(allowed, 1);
    if (card.rad) allowed = this.radiantUsed ? 0 : Math.min(allowed, 1);
    if (card.pri) allowed = Math.min(allowed, 1 - (this.names.get(nameKey(card.n)) ?? 0));
    return Math.max(0, allowed);
  }

  countOf(g) {
    return this.entries.get(g)?.count ?? 0;
  }

  // Kolko kusov skupiny este mame k dispozicii z vlastnej zbierky.
  available(g) {
    return (this.owned.get(g)?.legalQty ?? 0) - (this.entries.get(g)?.owned ?? 0);
  }

  add(card, wanted, { role, priority, purchased = false }) {
    const count = this.room(card, wanted);
    if (count <= 0) return 0;
    let entry = this.entries.get(card.g);
    if (!entry) {
      entry = { g: card.g, card, count: 0, owned: 0, role, priority };
      this.entries.set(card.g, entry);
    }
    entry.count += count;
    if (!purchased) entry.owned += count;
    this.total += count;
    if (!isBasicEnergy(card)) {
      const key = nameKey(card.n);
      this.names.set(key, (this.names.get(key) ?? 0) + count);
    }
    if (card.ace) this.aceUsed = true;
    if (card.rad) this.radiantUsed = true;
    return count;
  }

  addOwned(card, wanted, options) {
    return this.add(card, Math.min(wanted, this.available(card.g)), options);
  }

  count(category) {
    let total = 0;
    for (const entry of this.entries.values()) if (entry.card.c === category) total += entry.count;
    return total;
  }
}

function addLine(draft, chain, role, priority) {
  let previous = MAX_COPIES;
  chain.forEach((card, index) => {
    const limit = index === 0 ? MAX_COPIES : Math.min(previous, chain.length > 2 ? 3 : MAX_COPIES);
    const added = draft.addOwned(card, limit - draft.countOf(card.g), { role, priority });
    previous = Math.max(1, draft.countOf(card.g) || added);
  });
}

function basicEnergyCard(db, letter, format) {
  const names = {
    G: "Grass Energy", R: "Fire Energy", W: "Water Energy", L: "Lightning Energy", P: "Psychic Energy",
    F: "Fighting Energy", D: "Darkness Energy", M: "Metal Energy", Y: "Fairy Energy",
  };
  const groupIds = db.byName.get(nameKey(names[letter] ?? ""));
  for (const g of groupIds ?? []) {
    const group = db.groups.get(g);
    if (group.cat === "E" && isBasicEnergy(group.prints[0])) {
      return displayPrint(db, g, format) ?? group.prints[0];
    }
  }
  return null;
}

const MIN_BASICS = 8;
const MIN_POKEMON = 12;
const MAX_TRAINERS_FROM_SHOP = 36;

/** Lacni Basic Pokemoni danej energie pre zbierky, kde vlastnych nie je dost. */
function affordableBasics(db, format, color, usage, maxPrice) {
  const key = `basics|${format}|${color}`;
  if (db.cache.has(key)) return db.cache.get(key);
  const allowed = new Set([color]);
  const rows = [];
  for (const group of db.groups.values()) {
    const sample = group.prints[0];
    if (group.cat !== "P" || sample.st !== "Basic" || sample.rb || sample.rad) continue;
    const price = cheapestPrint(db, group.g, format);
    if (!price || !isLegal(price, format) || typeof price.p !== "number" || price.p > maxPrice) continue;
    const attack = bestAttack(price, allowed);
    if (!attack || attack.damage <= 0) continue;
    // Bezfarebny utok by sedel do kazdeho decku, radsej Pokemon danej energie.
    if (!attack.cost.includes(color)) continue;
    rows.push({ card: displayPrint(db, group.g, format) ?? price, score: pokemonScore(price, usage, allowed) });
  }
  rows.sort((a, b) => b.score - a.score);
  const best = rows.slice(0, 30);
  db.cache.set(key, best);
  return best;
}

function countBasics(draft) {
  let total = 0;
  for (const entry of draft.entries.values()) if (entry.card.c === "P" && entry.card.st === "Basic") total += entry.count;
  return total;
}

function trainerPriority(card, usage) {
  let score = (usage.get(card.g)?.rate ?? 0) * 100;
  if (card.fx & TAG.draw) score += 18;
  if (card.fx & TAG.search) score += 16;
  if (card.fx & TAG.gust) score += 9;
  if (card.fx & TAG.switch) score += 8;
  if (card.fx & TAG.recover) score += 4;
  if (card.fx & TAG.heal) score += 3;
  if (card.fx & TAG.accel) score += 3;
  return score;
}

function buildOne(db, formatDecks, owned, format, attacker, byName, usage, opts) {
  const firstAttack = bestAttack(attacker);
  const color = mainColor(attacker, firstAttack, opts.companionColor);
  const allowed = new Set([color]);
  const draft = new DeckDraft(db, owned, format);
  const reasons = [];

  const main = evolutionChain(attacker, byName);
  addLine(draft, main.chain, "main", 100);
  reasons.push({
    kind: "attack",
    name: attacker.n,
    attack: firstAttack?.name,
    damage: firstAttack?.printed,
    cost: firstAttack?.cost?.length ?? 0,
  });

  // Dalsi Pokemoni, ktorych utoky zaplatime rovnakou energiou.
  const partners = [];
  for (const entry of owned.values()) {
    if (entry.legalQty <= 0) continue;
    const card = entry.prints[0];
    if (card.c !== "P" || draft.countOf(card.g)) continue;
    const attack = bestAttack(card, allowed);
    if (!attack && !card.ab?.length) continue;
    const line = evolutionChain(card, byName);
    if (!line.playable) continue;
    partners.push({ card, line, score: pokemonScore(card, usage, allowed) });
  }
  partners.sort((a, b) => b.score - a.score);

  const POKEMON_TARGET = 16;
  let partnerIndex = 0;
  for (; partnerIndex < partners.length && draft.count("P") < POKEMON_TARGET; partnerIndex++) {
    const { line, card } = partners[partnerIndex];
    if (draft.countOf(card.g)) continue;
    const before = draft.count("P");
    addLine(draft, line.chain, "support", 70 - partnerIndex);
    if (partnerIndex === 0 && draft.count("P") > before) {
      reasons.push({ kind: "partner", name: card.n });
    }
  }

  // Bez dostatku Pokemonov deck nehra, tych treba dokupit ako prvych.
  for (const { card } of affordableBasics(db, format, color, usage, opts.maxFillerPrice)) {
    if (countBasics(draft) >= MIN_BASICS && draft.count("P") >= MIN_POKEMON) break;
    draft.add(card, 3 - draft.countOf(card.g), { role: "buy", priority: 60, purchased: true });
  }

  // Energia podla ceny utokov.
  const attackers = [...draft.entries.values()].filter((e) => e.card.c === "P");
  const costs = attackers
    .map((e) => bestAttack(e.card, allowed)?.cost.length ?? 0)
    .filter((c) => c > 0);
  const averageCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 2;
  const energyTarget = Math.max(8, Math.min(14, Math.round(7 + averageCost * 2)));
  const energyCard = basicEnergyCard(db, color, format);

  const addEnergy = (wanted, { buyMissing }) => {
    if (!energyCard || wanted <= 0) return 0;
    const free = opts.assumeBasicEnergy ? wanted : Math.min(wanted, Math.max(0, draft.available(energyCard.g)));
    const added = draft.add(energyCard, free, { role: "energy", priority: 90 });
    // Deck bez energie nehra, takze chybajucu energiu treba kupit, nie vynechat.
    return buyMissing ? added + draft.add(energyCard, wanted - free, { role: "energy", priority: 90, purchased: true }) : added;
  };
  addEnergy(energyTarget, { buyMissing: true });

  // Trainery podla pouzivanosti v turnajoch a podla toho, co robia.
  const trainers = [];
  for (const entry of owned.values()) {
    if (entry.legalQty <= 0) continue;
    const card = entry.prints[0];
    if (card.c !== "T") continue;
    trainers.push({ card, score: trainerPriority(card, usage), avg: usage.get(card.g)?.avg ?? 0 });
  }
  trainers.sort((a, b) => b.score - a.score);

  const typeLimit = { Supporter: 12, Stadium: 3, Tool: 5 };
  const typeCount = { Supporter: 0, Stadium: 0, Tool: 0 };
  const addTrainer = (item, wanted) => {
    const type = item.card.tt;
    const limit = typeLimit[type];
    const capped = limit === undefined ? wanted : Math.min(wanted, limit - typeCount[type]);
    if (capped <= 0) return;
    const added = draft.addOwned(item.card, capped, {
      role: item.score >= 8 ? "trainer" : "filler",
      priority: Math.min(85, 20 + item.score),
    });
    if (limit !== undefined) typeCount[type] += added;
  };
  for (const item of trainers.filter((t) => t.score >= 8)) {
    addTrainer(item, Math.max(2, Math.round(item.avg) || MAX_COPIES));
  }

  // Zvysne miesta: ostatni Pokemoni, slabsie trainery, nakoniec energia.
  for (; partnerIndex < partners.length && draft.total < DECK_SIZE && draft.count("P") < 28; partnerIndex++) {
    const { line, card } = partners[partnerIndex];
    if (draft.countOf(card.g)) continue;
    addLine(draft, line.chain, "filler", 15);
  }
  for (const item of trainers) {
    if (draft.total >= DECK_SIZE) break;
    addTrainer(item, MAX_COPIES - draft.countOf(item.card.g));
  }
  addEnergy(Math.min(18, energyTarget + 4) - draft.countOf(energyCard?.g), { buyMissing: false });
  for (const item of trainers) {
    if (draft.total >= DECK_SIZE) break;
    const type = item.card.tt;
    if (typeLimit[type] !== undefined) typeLimit[type] += 4;
    addTrainer(item, MAX_COPIES - draft.countOf(item.card.g));
  }

  // Co stale chyba do 60, navrhne na kupu: najpouzivanejsie lacne trainery, potom energia.
  if (draft.total < DECK_SIZE) {
    for (const row of formatDecks?.usage ?? []) {
      if (draft.total >= DECK_SIZE || draft.count("T") >= MAX_TRAINERS_FROM_SHOP) break;
      const [g, rate, avg] = row;
      const group = db.groups.get(g);
      if (group?.cat !== "T" || rate < 0.05) continue;
      const print = cheapestPrint(db, g, format);
      if (!print || !isLegal(print, format) || (print.p ?? 99) > opts.maxFillerPrice) continue;
      const shown = displayPrint(db, g, format) ?? print;
      draft.add(shown, Math.max(1, Math.round(avg)), { role: "buy", priority: 60, purchased: true });
    }
  }
  if (draft.total < DECK_SIZE && energyCard) {
    draft.add(energyCard, DECK_SIZE - draft.total, { role: "energy", priority: 30, purchased: !opts.assumeBasicEnergy });
  }

  return { draft, color, reasons, energyTarget, main };
}

function finishDeck(db, formatDecks, format, built, usage, opts) {
  const { draft, color, reasons } = built;
  const cards = sortEntries([...draft.entries.values()]);
  const missing = [];
  let cost = 0;
  let unknownPrices = 0;
  for (const entry of cards) {
    const assumedEnergy = isBasicEnergy(entry.card) && opts.assumeBasicEnergy;
    const lacking = assumedEnergy ? 0 : entry.count - entry.owned;
    if (assumedEnergy) entry.owned = entry.count;
    if (lacking > 0) {
      const print = cheapestPrint(db, entry.g, format) ?? entry.card;
      const unit = typeof print.p === "number" ? print.p : null;
      if (unit === null) unknownPrices += lacking;
      else cost += unit * lacking;
      missing.push({ g: entry.g, card: print, count: lacking, unit });
    }
  }
  const validation = validateDeck(db, cards.map((e) => ({ id: e.card.id, count: e.count })), format);
  const stats = deckStats(cards);
  const warnings = deckWarnings(stats);
  return {
    attacker: built.main.chain.at(-1),
    color,
    cards,
    missing,
    cost: round2(cost),
    unknownPrices,
    reasons,
    validation,
    stats,
    warnings,
  };
}

export function deckStats(cards) {
  const stats = { pokemon: 0, trainer: 0, energy: 0, basics: 0, draw: 0, search: 0, switching: 0, gust: 0 };
  for (const { card, count } of cards) {
    if (card.c === "P") {
      stats.pokemon += count;
      if (card.st === "Basic") stats.basics += count;
    } else if (card.c === "T") {
      stats.trainer += count;
      if (card.fx & TAG.switch) stats.switching += count;
      if (card.fx & TAG.gust) stats.gust += count;
    } else if (card.c === "E") {
      stats.energy += count;
    }
    if (card.c !== "E" && card.fx & TAG.draw) stats.draw += count;
    if (card.c !== "E" && card.fx & TAG.search) stats.search += count;
  }
  stats.mulligan = mulliganChance(stats.basics);
  return stats;
}

export function deckWarnings(stats) {
  const warnings = [];
  if (stats.mulligan > 0.25) {
    warnings.push(`Málo Basic Pokémonov: v ${Math.round(stats.mulligan * 100)} % hier nebudeš mať žiadneho v prvej ruke.`);
  }
  if (stats.draw + stats.search < 8) {
    warnings.push(`Málo kariet na ťahanie a hľadanie (${stats.draw + stats.search}). Deck sa môže často zaseknúť.`);
  }
  if (stats.switching === 0) warnings.push("Žiadna karta na výmenu aktívneho Pokémona.");
  return warnings;
}

function deckScore(deck, attackerScore, usage) {
  const { stats } = deck;
  let score = attackerScore;
  score += Math.min(stats.draw + stats.search, 16) * 2.5;
  score -= stats.mulligan * 60;
  score -= deck.missing.reduce((sum, m) => sum + m.count, 0) * 1.5;
  for (const { g, count } of deck.cards) score += (usage.get(g)?.rate ?? 0) * count * 2;
  return score;
}

/** Zostavi az `limit` roznych deckov z vlastnych kariet. */
export function buildFromCollection(db, formatDecks, collection, options) {
  const opts = { limit: 3, assumeBasicEnergy: true, maxFillerPrice: 1.5, ...options };
  const { format } = opts;
  const owned = ownedGroups(db, collection, format);
  const usage = usageMap(formatDecks);
  const byName = ownedPokemonIndex(db, owned);
  opts.companionColor = bestCompanionColor(owned, usage);

  const candidates = [];
  for (const entry of owned.values()) {
    if (entry.legalQty <= 0) continue;
    const card = entry.prints[0];
    if (card.c !== "P" || !(bestAttack(card)?.damage > 0)) continue;
    const line = evolutionChain(card, byName);
    if (!line.playable) continue;
    const topCount = Math.min(entry.legalQty, MAX_COPIES);
    const baseEntry = owned.get(line.chain[0].g);
    const baseCount = Math.min(baseEntry?.legalQty ?? 1, MAX_COPIES);
    const reliability = (0.55 + 0.45 * Math.min(1, topCount / 3)) * (0.6 + 0.4 * Math.min(1, baseCount / 3));
    candidates.push({ card, score: pokemonScore(card, usage) * reliability });
  }
  candidates.sort((a, b) => b.score - a.score);

  const decks = [];
  for (const candidate of candidates.slice(0, 30)) {
    const built = buildOne(db, formatDecks, owned, format, candidate.card, byName, usage, opts);
    const deck = finishDeck(db, formatDecks, format, built, usage, opts);
    if (!deck.validation.ok) continue;
    deck.score = deckScore(deck, candidate.score, usage);
    decks.push(deck);
  }
  decks.sort((a, b) => b.score - a.score);

  // Radsej rozne energie a hlavni Pokemoni nez tri takmer rovnake decky.
  const picked = [];
  const colors = new Set();
  for (const deck of decks) {
    if (picked.length >= opts.limit) break;
    if (!colors.has(deck.color)) {
      picked.push(deck);
      colors.add(deck.color);
    }
  }
  for (const deck of decks) {
    if (picked.length >= opts.limit) break;
    if (!picked.includes(deck) && !picked.some((p) => nameKey(p.attacker.n) === nameKey(deck.attacker.n))) {
      picked.push(deck);
    }
  }
  for (const deck of picked) deck.upgrades = suggestUpgrades(db, formatDecks, deck, owned, format);
  return { decks: picked, gaps: evolutionGaps(db, owned, format), candidates: candidates.length };
}

/** Pokemoni, ktori sa nedaju hrat, lebo hracovi chyba predchadzajuci stupen. */
export function evolutionGaps(db, owned, format, limit = 6) {
  const byName = ownedPokemonIndex(db, owned);
  const gaps = [];
  const seen = new Set();
  for (const entry of owned.values()) {
    if (entry.legalQty <= 0) continue;
    const card = entry.prints[0];
    if (card.c !== "P" || !card.ef) continue;
    const { missing } = evolutionChain(card, byName);
    if (!missing.length) continue;
    const missingName = missing[0];
    if (seen.has(nameKey(missingName))) continue;
    seen.add(nameKey(missingName));
    const groupIds = db.byName.get(nameKey(missingName));
    if (!groupIds) continue;
    const prints = [...groupIds]
      .map((g) => cheapestPrint(db, g, format))
      .filter((p) => p && isLegal(p, format) && typeof p.p === "number")
      .sort((a, b) => a.p - b.p);
    if (!prints.length) continue;
    gaps.push({ have: card, have_qty: entry.legalQty, needs: prints[0], g: prints[0].g });
  }
  gaps.sort((a, b) => (b.have.hp ?? 0) - (a.have.hp ?? 0));
  return gaps.slice(0, limit);
}

/** Lacne casto hrane Trainery, ktore v decku nahradia najslabsie karty. */
export function suggestUpgrades(db, formatDecks, deck, owned, format, limit = 8, maxUnitPrice = 3) {
  const inDeck = new Map(deck.cards.map((e) => [e.g, e.count]));
  const nameCounts = new Map();
  let aceInDeck = false;
  for (const { card, count } of deck.cards) {
    if (!isBasicEnergy(card)) nameCounts.set(nameKey(card.n), (nameCounts.get(nameKey(card.n)) ?? 0) + count);
    if (card.ace) aceInDeck = true;
  }

  const fillers = [...deck.cards]
    .filter((e) => e.role === "filler" || (e.role === "support" && e.priority < 60))
    .sort((a, b) => a.priority - b.priority)
    .map((e) => ({ entry: e, left: e.count }));
  const basicsInDeck = deck.stats.basics;
  let basicsRemoved = 0;

  const upgrades = [];
  for (const [g, rate, avg] of formatDecks?.usage ?? []) {
    if (upgrades.length >= limit) break;
    if (rate < 0.25) break;
    const group = db.groups.get(g);
    if (group?.cat !== "T" || inDeck.has(g)) continue;
    const print = cheapestPrint(db, g, format);
    if (!print || !isLegal(print, format) || typeof print.p !== "number") continue;
    if (print.p > maxUnitPrice) continue;
    if (print.ace && aceInDeck) continue;
    const room = MAX_COPIES - (nameCounts.get(nameKey(print.n)) ?? 0);
    const ownedQty = owned.get(g)?.legalQty ?? 0;
    const wanted = Math.min(room, Math.max(1, Math.round(avg)));
    if (wanted <= 0) continue;

    const replaces = [];
    let remaining = wanted;
    for (const filler of fillers) {
      while (remaining > 0 && filler.left > 0) {
        const isBasic = filler.entry.card.st === "Basic";
        if (isBasic && basicsInDeck - basicsRemoved <= 8) break;
        filler.left -= 1;
        remaining -= 1;
        if (isBasic) basicsRemoved += 1;
        const row = replaces.find((r) => r.g === filler.entry.g);
        if (row) row.count += 1;
        else replaces.push({ g: filler.entry.g, card: filler.entry.card, count: 1 });
      }
      if (remaining === 0) break;
    }
    const count = wanted - remaining;
    if (count === 0) continue;
    const toBuy = Math.max(0, count - ownedQty);
    upgrades.push({
      g,
      card: print,
      count,
      toBuy,
      rate,
      cost: round2(toBuy * print.p),
      replaces,
    });
    nameCounts.set(nameKey(print.n), (nameCounts.get(nameKey(print.n)) ?? 0) + count);
    if (print.ace) aceInDeck = true;
  }
  return upgrades;
}

/** Deck po pouziti vylepseni. Vzdy zostane presne 60 kariet. */
export function applyUpgrades(deck, upgrades) {
  const map = new Map(deck.cards.map((e) => [e.g, { ...e }]));
  for (const upgrade of upgrades) {
    for (const { g, count } of upgrade.replaces) {
      const entry = map.get(g);
      if (!entry) continue;
      entry.count -= count;
      entry.owned = Math.min(entry.owned, entry.count);
      if (entry.count <= 0) map.delete(g);
    }
    map.set(upgrade.g, {
      g: upgrade.g,
      card: upgrade.card,
      count: upgrade.count,
      owned: upgrade.count - upgrade.toBuy,
      role: "upgrade",
      priority: 80,
    });
  }
  return sortEntries([...map.values()]);
}

/** Co z kariet v decku treba dokupit a za kolko. */
export function summarizeMissing(db, cards, format) {
  const missing = [];
  let cost = 0;
  let unknownPrices = 0;
  for (const entry of cards) {
    const lacking = entry.count - entry.owned;
    if (lacking <= 0) continue;
    const print = cheapestPrint(db, entry.g, format) ?? entry.card;
    const unit = typeof print.p === "number" ? print.p : null;
    if (unit === null) unknownPrices += lacking;
    else cost += unit * lacking;
    missing.push({ g: entry.g, card: print, count: lacking, unit });
  }
  missing.sort((a, b) => (b.unit ?? 0) - (a.unit ?? 0));
  return { missing, cost: round2(cost), unknownPrices };
}

/* ---------- Export ---------- */

export function exportDeckText(db, cards) {
  const sections = [
    ["Pokémon", "P"],
    ["Trainer", "T"],
    ["Energy", "E"],
  ];
  const lines = [];
  for (const [label, category] of sections) {
    const rows = cards.filter((e) => e.card.c === category);
    const total = rows.reduce((sum, e) => sum + e.count, 0);
    lines.push(`${label}: ${total}`);
    for (const { card, count } of rows) lines.push(`${count} ${card.n} ${setCode(db, card)} ${card.l}`);
    lines.push("");
  }
  lines.push(`Total Cards: ${cards.reduce((sum, e) => sum + e.count, 0)}`);
  return lines.join("\n");
}

export function exportShoppingText(db, missing) {
  return missing
    .map(({ card, count, unit }) => {
      const price = unit === null || unit === undefined ? "" : ` (asi ${unit.toFixed(2)} € za kus)`;
      return `${count}x ${card.n} ${setCode(db, card)} ${card.l}${price}`;
    })
    .join("\n");
}
