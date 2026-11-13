import {
  FORMATS,
  addToCollection,
  applyUpgrades,
  buildFromCollection,
  collectionSummary,
  collectionValue,
  usageByGroup,
  deckStats,
  deckWarnings,
  exportDeckText,
  exportShoppingText,
  isBasicEnergy,
  isLegal,
  matchMetaDecks,
  nameKey,
  needsLegalityCheck,
  createDb,
  parseCollectionText,
  releaseDate,
  setCode,
  summarizeMissing,
  validateDeck,
  versionsOfName,
} from "./engine.js";
import { h, imageUrl, thumb } from "./dom.js";
import { createScanner } from "./scan-ui.js";

const STORAGE_KEY = "bulkdeck:v1";
const BUDGETS = [10, 25, 50, 100, Infinity];
const MAX_SUGGESTIONS = 12;
const FORMAT_WORDS = {
  standard: { inside: "v Standarde", outside: "mimo Standardu" },
  expanded: { inside: "v Expanded", outside: "mimo Expanded" },
  unlimited: { inside: "v Unlimited", outside: "mimo Unlimited" },
};

const state = {
  db: null,
  decks: null,
  demo: [],
  standardMarks: [],
  format: "standard",
  collection: new Map(),
  assumeBasicEnergy: true,
  tab: "bulk",
  budget: 25,
  deckIndex: 0,
  useUpgrades: false,
  openArchetype: null,
  problems: [],
  ambiguous: [],
  confirmClear: false,
  version: 0,
};

const memo = { bulkKey: null, bulk: null, metaKey: null, meta: null, valueKey: null, value: null };
let scanner = null;

const euro = new Intl.NumberFormat("sk-SK", { style: "currency", currency: "EUR" });

/* ---------- Pomocne funkcie ---------- */

function energyDot(letter) {
  const code = letter || "C";
  return h("span", { class: "energy", style: `background: var(--e-${code})`, "aria-hidden": "true" }, code);
}

function printLabel(card) {
  return `${setCode(state.db, card)} ${card.l}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function dateSk(iso) {
  const [year, month, day] = String(iso ?? "").split("-");
  return day ? `${Number(day)}. ${Number(month)}. ${year}` : "";
}

function plural(count, one, few, many) {
  if (count === 1) return `${count} ${one}`;
  return `${count} ${count >= 2 && count <= 4 ? few : many}`;
}

function cardsWord(count) {
  return plural(count, "karta", "karty", "kariet");
}

function money(value) {
  return euro.format(value);
}

function percent(value) {
  const rounded = Math.round(value * 100);
  return value > 0 && rounded === 0 ? "menej ako 1 %" : `${rounded} %`;
}

let toastTimer;
function toast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2200);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    const area = h("textarea", { style: "position:fixed;opacity:0" }, text);
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    toast(copied ? message : "Kopírovanie sa nepodarilo.");
  }
}

/* ---------- Ulozenie ---------- */

function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        collection: [...state.collection],
        format: state.format,
        assumeBasicEnergy: state.assumeBasicEnergy,
        budget: Number.isFinite(state.budget) ? state.budget : null,
      }),
    );
  } catch {
    // Bez ulozenia appka funguje dalej, zbierka len neprezije zatvorenie stranky.
  }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved) return;
    if (Array.isArray(saved.collection)) {
      for (const row of saved.collection) {
        if (Array.isArray(row) && state.db.byId.has(row[0]) && Number.isInteger(row[1]) && row[1] > 0) {
          state.collection.set(row[0], row[1]);
        }
      }
    }
    if (FORMATS[saved.format]) state.format = saved.format;
    if (typeof saved.assumeBasicEnergy === "boolean") state.assumeBasicEnergy = saved.assumeBasicEnergy;
    state.budget = saved.budget === null ? Infinity : BUDGETS.includes(saved.budget) ? saved.budget : 25;
  } catch {
    // Poskodene ulozene data ignorujeme a zacneme odznova.
  }
}

/* ---------- Zmeny stavu ---------- */

function collectionChanged() {
  state.version += 1;
  state.deckIndex = 0;
  state.useUpgrades = false;
  state.openArchetype = null;
  state.confirmClear = false;
  save();
  renderCollection();
  scheduleResults();
}

function changeQty(card, delta) {
  addToCollection(state.collection, card, delta);
  collectionChanged();
}

function addCard(card, qty = 1) {
  changeQty(card, qty);
  toast(`Pridané: ${qty} × ${card.n}`);
}

function addFromText(text) {
  const { items, problems } = parseCollectionText(state.db, text, state.format);
  let added = 0;
  const ambiguous = [];
  for (const item of items) {
    addToCollection(state.collection, item.card, item.qty);
    added += item.qty;
    if (item.ambiguous) ambiguous.push({ card: item.card, qty: item.qty });
  }
  state.problems = [...state.problems, ...problems];
  state.ambiguous = [...state.ambiguous, ...ambiguous];
  collectionChanged();
  const addedText = `Pridané: ${cardsWord(added)}.`;
  toast(problems.length ? `${addedText} Nenašiel som ${plural(problems.length, "riadok", "riadky", "riadkov")}.` : addedText);
}

function formatDecks() {
  return state.format === "unlimited" ? state.decks.standard : state.decks[state.format];
}

function bulkResult() {
  const key = `${state.version}|${state.format}|${state.assumeBasicEnergy}`;
  if (memo.bulkKey !== key) {
    memo.bulkKey = key;
    memo.bulk = buildFromCollection(state.db, formatDecks(), state.collection, {
      format: state.format,
      assumeBasicEnergy: state.assumeBasicEnergy,
    });
  }
  return memo.bulk;
}

function metaResult() {
  const key = `${state.version}|${state.format}|${state.assumeBasicEnergy}`;
  if (memo.metaKey !== key) {
    memo.metaKey = key;
    memo.meta = matchMetaDecks(state.db, formatDecks(), state.collection, {
      format: state.format,
      assumeBasicEnergy: state.assumeBasicEnergy,
    });
  }
  return memo.meta;
}

function valueResult() {
  const key = `${state.version}|${state.format}|${state.assumeBasicEnergy}`;
  if (memo.valueKey !== key) {
    memo.valueKey = key;
    // Karty z navrhnutych deckov si hrac necha, tie na predaj neodporucame.
    const keepGroups = new Set();
    for (const deck of bulkResult().decks) {
      for (const entry of deck.cards) if (entry.owned > 0) keepGroups.add(entry.g);
    }
    memo.value = collectionValue(state.db, state.collection, { usage: usageByGroup(formatDecks()), keepGroups });
  }
  return memo.value;
}

let resultsTimer;
function scheduleResults() {
  clearTimeout(resultsTimer);
  resultsTimer = setTimeout(renderResults, 60);
}

/* ---------- Format ---------- */

function renderFormat() {
  const root = document.getElementById("format");
  root.replaceChildren(
    ...Object.entries(FORMATS).map(([key, format]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(state.format === key),
          onclick: () => {
            if (state.format === key) return;
            state.format = key;
            state.deckIndex = 0;
            state.useUpgrades = false;
            state.openArchetype = null;
            save();
            render();
          },
        },
        format.label,
      ),
    ),
  );
}

/* ---------- Zbierka ---------- */

function searchCards(query) {
  const key = nameKey(query);
  if (key.length < 2) return [];
  const found = [];
  if (/\d$/.test(query.trim())) {
    const direct = parseCollectionText(state.db, query, state.format).items[0];
    if (direct && !direct.ambiguous) found.push(direct.card);
  }
  const names = [];
  for (const [name, groupIds] of state.db.byName) {
    if (!name.includes(key)) continue;
    names.push({ name: state.db.groups.get([...groupIds][0]).name, starts: name.startsWith(key), length: name.length });
  }
  names.sort((a, b) => Number(b.starts) - Number(a.starts) || a.length - b.length);
  for (const { name } of names.slice(0, 30)) {
    found.push(...versionsOfName(state.db, name, state.format));
    if (found.length >= MAX_SUGGESTIONS * 3) break;
  }
  return found
    .filter((card, index) => found.indexOf(card) === index)
    .sort((a, b) => Number(isLegal(b, state.format)) - Number(isLegal(a, state.format)))
    .slice(0, MAX_SUGGESTIONS);
}

function legalityTag(card) {
  if (card.lf) return `legálna od ${dateSk(card.lf)}`;
  return needsLegalityCheck(card, state.format) ? "over legalitu" : FORMAT_WORDS[state.format].outside;
}

function cardSubtitle(card) {
  const parts = [printLabel(card)];
  if (card.at?.[0]) parts.push(card.at[0][0]);
  else if (card.tt) parts.push(card.tt);
  if (!isLegal(card, state.format)) parts.push(legalityTag(card));
  return parts.join(" · ");
}

function buildSearch() {
  const list = h("ul", { class: "suggest", id: "suggest", role: "listbox", hidden: true });
  let results = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    results = [];
    active = -1;
  };

  const pick = (card) => {
    // Prekreslenie zbierky si berie hodnotu z pola, preto ho treba vycistit pred pridanim.
    input.value = "";
    close();
    addCard(card);
  };

  const draw = () => {
    list.replaceChildren(
      ...results.map((card, index) =>
        h(
          "li",
          { class: index === active ? "active" : null, role: "option", "aria-selected": String(index === active) },
          h(
            "button",
            { type: "button", tabindex: -1, onmousedown: (event) => event.preventDefault(), onclick: () => pick(card) },
            thumb(card),
            h("span", null, h("span", { class: "row-name" }, card.n), h("br"), h("span", { class: "row-sub" }, cardSubtitle(card))),
            h("span", { class: "price" }, typeof card.p === "number" ? money(card.p) : ""),
          ),
        ),
      ),
    );
    list.hidden = results.length === 0;
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };

  const input = h("input", {
    type: "search",
    id: "search-input",
    placeholder: "Pridaj kartu: Pikachu, Ultra Ball, SVI 57…",
    "aria-label": "Pridať kartu podľa mena alebo čísla",
    autocomplete: "off",
    role: "combobox",
    "aria-expanded": "false",
    "aria-controls": "suggest",
    oninput: () => {
      results = searchCards(input.value);
      active = results.length ? 0 : -1;
      draw();
      input.setAttribute("aria-expanded", String(results.length > 0));
    },
    onkeydown: (event) => {
      if (event.key === "ArrowDown" && results.length) {
        event.preventDefault();
        active = (active + 1) % results.length;
        draw();
      } else if (event.key === "ArrowUp" && results.length) {
        event.preventDefault();
        active = (active - 1 + results.length) % results.length;
        draw();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (results[active]) pick(results[active]);
      } else if (event.key === "Escape") {
        close();
      }
    },
    onblur: () => setTimeout(close, 120),
  });
  return h("div", { class: "search" }, input, list);
}

function buildPaste() {
  const area = h("textarea", {
    "aria-label": "Zoznam kariet, každá na vlastnom riadku",
    placeholder: "4 Ultra Ball\n2 Wugtrio SVI 57\nCharmander 4/165\nFunguje aj export z Pokémon TCG Live.",
  });
  return h(
    "details",
    { class: "paste" },
    h("summary", null, "Vložiť celý zoznam"),
    area,
    h(
      "button",
      {
        class: "btn primary",
        type: "button",
        onclick: () => {
          if (!area.value.trim()) return;
          addFromText(area.value);
          area.value = "";
        },
      },
      "Pridať do zbierky",
    ),
  );
}

function renderProblems() {
  const blocks = [];
  if (state.problems.length) {
    blocks.push(
      h(
        "div",
        { class: "problems" },
        h(
          "div",
          { class: "row-head" },
          `Nenašiel som ${plural(state.problems.length, "riadok", "riadky", "riadkov")}`,
          h("button", { class: "link", type: "button", onclick: () => { state.problems = []; renderCollection(); } }, "Zavrieť"),
        ),
        state.problems.slice(0, 40).map((problem, index) =>
          h(
            "div",
            null,
            h("span", null, problem.line),
            problem.suggestions.length ? " · Myslel si " : " · Nič podobné nepoznám.",
            problem.suggestions.map((name, nameIndex) => [
              nameIndex ? ", " : "",
              h(
                "button",
                {
                  class: "link",
                  type: "button",
                  onclick: () => {
                    const version = versionsOfName(state.db, name, state.format)[0];
                    if (!version) return;
                    state.problems.splice(index, 1);
                    addCard(version, problem.qty);
                  },
                },
                name,
              ),
            ]),
            problem.suggestions.length ? "?" : "",
          ),
        ),
      ),
    );
  }
  if (state.ambiguous.length) {
    blocks.push(
      h(
        "div",
        { class: "problems" },
        h(
          "div",
          { class: "row-head" },
          "Karty s viacerými verziami",
          h("button", { class: "link", type: "button", onclick: () => { state.ambiguous = []; renderCollection(); } }, "Zavrieť"),
        ),
        h("p", { class: "hint" }, "Vybral som najnovšiu legálnu verziu. Skontroluj, či máš tú istú."),
        state.ambiguous.slice(0, 40).map((item, index) =>
          h(
            "div",
            null,
            `${item.qty} × ${item.card.n} (${printLabel(item.card)}) · `,
            h("button", { class: "link", type: "button", onclick: () => openVersions(item, index) }, "Zmeniť"),
          ),
        ),
      ),
    );
  }
  return blocks;
}

function renderCollection() {
  const root = document.getElementById("collection");
  const previousList = root.querySelector(".card-list");
  const scrollTop = previousList?.scrollTop ?? 0;
  const activeFocus = document.activeElement?.dataset?.focus;
  const searchValue = root.querySelector("#search-input")?.value ?? "";
  const pasteOpen = root.querySelector(".paste")?.open ?? false;
  const hadSearchFocus = document.activeElement?.id === "search-input";

  const { total, legal } = collectionSummary(state.db, state.collection, state.format);
  const rows = [...state.collection]
    .map(([id, qty]) => ({ card: state.db.byId.get(id), qty }))
    .filter((row) => row.card)
    .sort((a, b) => {
      const order = { P: 0, T: 1, E: 2 };
      return order[a.card.c] - order[b.card.c] || a.card.n.localeCompare(b.card.n);
    });

  const search = buildSearch();
  const paste = buildPaste();
  paste.open = pasteOpen;

  const tools = h(
    "div",
    { class: "tools" },
    h("button", { class: "btn", type: "button", onclick: addDemo }, "Skúsiť ukážkový bulk"),
    total > 0
      ? h(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => {
              const text = rows.map((r) => `${r.qty} ${r.card.n} ${printLabel(r.card)}`).join("\n");
              copyText(text, "Zbierka je skopírovaná.");
            },
          },
          "Kopírovať",
        )
      : null,
    total > 0
      ? h(
          "button",
          {
            class: "btn danger",
            type: "button",
            onclick: () => {
              if (!state.confirmClear) {
                state.confirmClear = true;
                renderCollection();
                return;
              }
              state.collection.clear();
              state.problems = [];
              state.ambiguous = [];
              collectionChanged();
              toast("Zbierka je vymazaná.");
            },
          },
          state.confirmClear ? "Naozaj vymazať?" : "Vymazať",
        )
      : null,
  );

  const list = rows.length
    ? h(
        "ul",
        { class: "card-list" },
        rows.map(({ card, qty }) =>
          h(
            "li",
            { class: "card-row" },
            h("button", { class: "open", type: "button", "aria-label": `Detail: ${card.n}`, onclick: () => openCard(card) }, thumb(card)),
            h(
              "div",
              { class: "text" },
              h("div", { class: "row-name" }, card.n),
              h(
                "div",
                { class: "row-sub" },
                printLabel(card),
                !isLegal(card, state.format)
                  ? [" · ", h("span", { class: "tag-out" }, legalityTag(card))]
                  : null,
              ),
            ),
            h(
              "div",
              { class: "stepper" },
              h("button", { type: "button", "aria-label": `Ubrať ${card.n}`, "data-focus": `-${card.id}`, onclick: () => changeQty(card, -1) }, "−"),
              h("output", null, qty),
              h("button", { type: "button", "aria-label": `Pridať ${card.n}`, "data-focus": `+${card.id}`, onclick: () => changeQty(card, 1) }, "+"),
            ),
          ),
        ),
      )
    : h(
        "div",
        { class: "empty" },
        h("strong", null, "Zbierka je prázdna"),
        "Pridaj prvé karty hore alebo vlož celý zoznam.",
      );

  root.replaceChildren(
    h(
      "div",
      { class: "head-row" },
      h("h2", null, "Moja zbierka"),
      h(
        "span",
        { class: "count" },
        h("strong", null, total),
        total === 1 ? " karta" : total >= 2 && total <= 4 ? " karty" : " kariet",
        total ? ` · ${legal} ${FORMAT_WORDS[state.format].inside}` : "",
      ),
    ),
    h("button", { class: "btn primary scan-open", type: "button", onclick: () => scanner.open() }, "Skenovať karty"),
    search,
    paste,
    tools,
    ...renderProblems(),
    list,
  );

  const input = root.querySelector("#search-input");
  input.value = searchValue;
  if (hadSearchFocus) input.focus();
  const newList = root.querySelector(".card-list");
  if (newList) newList.scrollTop = scrollTop;
  if (activeFocus) root.querySelector(`[data-focus="${CSS.escape(activeFocus)}"]`)?.focus();
}

function addScanned(rows) {
  let total = 0;
  for (const { card, qty } of rows) {
    addToCollection(state.collection, card, qty);
    total += qty;
  }
  collectionChanged();
  toast(`Pridané: ${cardsWord(total)}.`);
}

function addDemo() {
  for (const [id, qty] of state.demo) {
    const card = state.db.byId.get(id);
    if (card) addToCollection(state.collection, card, qty);
  }
  collectionChanged();
  toast("Ukážkový bulk je v zbierke.");
}

/* ---------- Spolocne zobrazenie decku ---------- */

function rulesList(validation, format) {
  const codes = new Set(validation.errors.map((e) => e.code));
  const rule = (ok, text) => h("li", { class: ok ? "pass" : "fail" }, text);
  return h(
    "ul",
    { class: "rules", "aria-label": "Kontrola oficiálnych pravidiel" },
    rule(!codes.has("size"), `Presne 60 kariet`),
    rule(!codes.has("copies") && !codes.has("prism"), "Najviac 4 s rovnakým menom"),
    rule(!codes.has("basic"), "Aspoň 1 Basic Pokémon"),
    rule(!codes.has("illegal"), `Legálne ${FORMAT_WORDS[format].inside}`),
    rule(!codes.has("ace") && !codes.has("radiant"), "Limity ACE SPEC a Radiant"),
  );
}

function statsRow(stats) {
  const stat = (value, label) => h("div", { class: "stat" }, h("b", null, value), h("span", null, label));
  return h(
    "div",
    { class: "stat-row" },
    stat(stats.pokemon, "Pokémon"),
    stat(stats.trainer, "Trainer"),
    stat(stats.energy, "Energia"),
    stat(`${Math.round(stats.mulligan * 100)} %`, "riziko mulliganu"),
    stat(stats.draw + stats.search, "ťahanie a hľadanie"),
  );
}

function tile(entry) {
  const { card, count, owned } = entry;
  const lacking = count - owned;
  const url = imageUrl(card);
  const label = `${count} × ${card.n}${lacking > 0 ? `, chýba ${lacking}` : ""}`;
  return h(
    "button",
    { class: `tile${lacking > 0 ? " lacking" : ""}`, type: "button", "aria-label": label, title: card.n, onclick: () => openCard(card) },
    url ? h("img", { src: url, alt: "", loading: "lazy", width: 245, height: 337 }) : h("span", { class: "noimg" }, card.n),
    h("span", { class: "qty" }, count),
    lacking > 0 ? h("span", { class: "need" }, owned > 0 ? `Dokúpiť ${lacking} z ${count}` : `Dokúpiť ${lacking}`) : null,
  );
}

function deckGrids(cards) {
  const sections = [
    ["Pokémon", "P"],
    ["Trainer", "T"],
    ["Energia", "E"],
  ];
  return sections.map(([label, category]) => {
    const rows = cards.filter((entry) => entry.card.c === category);
    if (!rows.length) return null;
    const total = rows.reduce((sum, entry) => sum + entry.count, 0);
    return [h("h3", { class: "section-title" }, `${label} (${total})`), h("div", { class: "grid" }, rows.map(tile))];
  });
}

function buyPanel(missing, cost, unknownPrices) {
  if (!missing.length) return null;
  return [
    h("h3", { class: "section-title" }, "Čo chýba do tohto decku"),
    h(
      "div",
      { class: "buy" },
      h(
        "ul",
        { class: "buy-list" },
        missing.map(({ card, count, unit }) =>
          h(
            "li",
            null,
            h("button", { class: "open", type: "button", "aria-label": `Detail: ${card.n}`, onclick: () => openCard(card) }, thumb(card)),
            h("div", null, h("div", { class: "row-name" }, `${count} × ${card.n}`), h("div", { class: "row-sub" }, printLabel(card))),
            h("span", { class: "price" }, unit === null ? "cena neznáma" : money(unit * count)),
          ),
        ),
      ),
      h("div", { class: "total" }, h("span", null, "Spolu asi"), h("span", null, money(cost))),
      h(
        "p",
        { class: "hint", style: "margin-top:6px" },
        "Najlacnejší legálny výtlačok, orientačná cena z Cardmarketu, bez poštovného.",
        unknownPrices ? ` ${unknownPrices} kariet bez ceny nie je započítaných.` : "",
      ),
    ),
  ];
}

function deckActions(cards, missing, hasUpgrades = false) {
  return h(
    "div",
    { class: "actions" },
    hasUpgrades
      ? h(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => document.getElementById("upgrades")?.scrollIntoView({ behavior: "smooth", block: "start" }),
          },
          "Čo sa oplatí dokúpiť",
        )
      : null,
    h("button", { class: "btn primary", type: "button", onclick: () => copyText(exportDeckText(state.db, cards), "Deck je skopírovaný.") }, "Kopírovať deck"),
    missing.length
      ? h("button", { class: "btn", type: "button", onclick: () => copyText(exportShoppingText(state.db, missing), "Nákupný zoznam je skopírovaný.") }, "Kopírovať nákup")
      : null,
  );
}

/* ---------- Karta: deck z vlastnych kariet ---------- */

function attackSentence(reason) {
  if (!reason.attack) return `Hlavný Pokémon: ${reason.name}.`;
  const energies = reason.cost === 1 ? "1 energiu" : reason.cost >= 2 && reason.cost <= 4 ? `${reason.cost} energie` : `${reason.cost} energií`;
  return `Hlavný útočník: ${reason.name}. ${reason.attack} dáva ${reason.damage} poškodenia za ${energies}.`;
}

function renderBulkTab(container) {
  const { total, legal } = collectionSummary(state.db, state.collection, state.format);
  if (total === 0) {
    container.append(
      h(
        "div",
        { class: "empty" },
        h("strong", null, "Najprv potrebujem tvoje karty"),
        "Naskenuj ich alebo zadaj ručne. Z bulku potom zložím legálny deck a poviem ti, čo sa oplatí dokúpiť.",
        h("br"),
        h("button", { class: "btn primary", type: "button", onclick: () => scanner.open() }, "Skenovať karty"),
        " ",
        h("button", { class: "btn", type: "button", onclick: addDemo }, "Skúsiť ukážkový bulk"),
      ),
    );
    return;
  }

  const { decks, gaps } = bulkResult();
  if (!decks.length) {
    const others = Object.keys(FORMATS)
      .filter((key) => key !== state.format)
      .map((key) => ({ key, legal: collectionSummary(state.db, state.collection, key).legal }))
      .filter((row) => row.legal > legal)
      .sort((a, b) => b.legal - a.legal);
    container.append(
      h(
        "div",
        { class: "empty" },
        h("strong", null, `${capitalize(FORMAT_WORDS[state.format].inside)} sa z toho deck nedá zložiť`),
        legal === 0
          ? `Žiadna z tvojich kariet (${total}) nie je v tomto formáte legálna.`
          : `Legálne kusy: ${legal} z ${total}, ale chýba Pokémon, ktorý vie útočiť.`,
        others.length
          ? [
              h("br"),
              h(
                "button",
                {
                  class: "btn primary",
                  type: "button",
                  onclick: () => {
                    state.format = others[0].key;
                    save();
                    render();
                  },
                },
                `Skúsiť ${FORMATS[others[0].key].label} (${cardsWord(others[0].legal)})`,
              ),
            ]
          : null,
      ),
    );
    if (gaps.length) container.append(gapsPanel(gaps));
    return;
  }

  const deck = decks[Math.min(state.deckIndex, decks.length - 1)];
  const upgrades = deck.upgrades ?? [];
  const useUpgrades = state.useUpgrades && upgrades.length > 0;
  const cards = useUpgrades ? applyUpgrades(deck, upgrades) : deck.cards;
  const stats = useUpgrades ? deckStats(cards) : deck.stats;
  const validation = useUpgrades
    ? validateDeck(state.db, cards.map((e) => ({ id: e.card.id, count: e.count })), state.format)
    : deck.validation;
  const { missing, cost, unknownPrices } = useUpgrades
    ? summarizeMissing(state.db, cards, state.format)
    : deck;
  const ownedCount = cards.reduce((sum, e) => sum + Math.min(e.count, e.owned), 0);
  const warnings = useUpgrades ? deckWarnings(stats) : deck.warnings;

  const blocks = [
    h(
      "div",
      { class: "chips", role: "group", "aria-label": "Návrhy deckov" },
      decks.map((option, index) => {
        const optionOwned = option.cards.reduce((sum, e) => sum + Math.min(e.count, e.owned), 0);
        return h(
          "button",
          {
            class: "chip",
            type: "button",
            "aria-pressed": String(index === state.deckIndex),
            onclick: () => {
              state.deckIndex = index;
              state.useUpgrades = false;
              renderResults();
            },
          },
          energyDot(option.color),
          option.attacker.n,
          h("small", null, optionOwned === 60 ? "máš všetko" : `máš ${optionOwned}/60`),
        );
      }),
    ),
    h(
      "div",
      { class: "deck-head" },
      h("h2", { class: "deck-title" }, `${deck.attacker.n} deck`),
      deck.reasons[0] ? h("p", { class: "deck-why" }, attackSentence(deck.reasons[0])) : null,
      statsRow(stats),
      rulesList(validation, state.format),
      warnings.length ? h("ul", { class: "warnings" }, warnings.map((warning) => h("li", null, warning))) : null,
      h(
        "p",
        { class: "hint", style: "margin-top:12px" },
        ownedCount === 60
          ? "Tento deck vieš zahrať hneď, všetky karty máš."
          : `Máš ${ownedCount} zo 60 kariet, zvyšok stojí asi ${money(cost)}.`,
        state.assumeBasicEnergy ? " Základnú energiu rátam ako tvoju." : "",
      ),
      deckActions(cards, missing, upgrades.length > 0),
    ),
    deckGrids(cards),
    upgradesPanel(upgrades, useUpgrades),
    buyPanel(missing, cost, unknownPrices),
    gaps.length ? gapsPanel(gaps) : null,
  ];
  // Element.append by polia premenil na text, preto ich najprv rozbalime.
  container.append(...blocks.flat(Infinity).filter(Boolean));
}

function upgradesPanel(upgrades, active) {
  if (!upgrades.length) return [];
  const totalCost = upgrades.reduce((sum, upgrade) => sum + upgrade.cost, 0);
  // Nacitany rozsah karty sa nemeni, pri prepnuti ostane hrac na tom istom mieste.
  return [
    h("h3", { class: "section-title", id: "upgrades" }, "Čo sa oplatí dokúpiť"),
    h(
      "div",
      { class: "buy" },
      h(
        "ul",
        { class: "buy-list" },
        upgrades.map((upgrade) =>
          h(
            "li",
            null,
            h("button", { class: "open", type: "button", "aria-label": `Detail: ${upgrade.card.n}`, onclick: () => openCard(upgrade.card) }, thumb(upgrade.card)),
            h(
              "div",
              null,
              h("div", { class: "row-name" }, `${upgrade.count} × ${upgrade.card.n}`),
              h(
                "div",
                { class: "row-sub" },
                `Hrá ho ${percent(upgrade.rate)} turnajových deckov. Nahradí: `,
                upgrade.replaces.map((r) => `${r.count} × ${r.card.n}`).join(", "),
                ".",
              ),
            ),
            h("span", { class: "price" }, upgrade.toBuy === 0 ? "máš" : money(upgrade.cost)),
          ),
        ),
      ),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: active ? "btn" : "btn primary",
            type: "button",
            "aria-pressed": String(active),
            onclick: () => {
              state.useUpgrades = !state.useUpgrades;
              renderResults();
            },
          },
          active ? "Zobraziť deck bez vylepšení" : `Zobraziť deck s vylepšeniami (asi ${money(totalCost)})`,
        ),
      ),
    ),
  ];
}

function gapsPanel(gaps) {
  return h(
    "div",
    null,
    h("h3", { class: "section-title" }, "Pokémoni, ktorí čakajú na evolúciu"),
    h(
      "div",
      { class: "buy" },
      h(
        "ul",
        { class: "buy-list" },
        gaps.map((gap) =>
          h(
            "li",
            null,
            h("button", { class: "open", type: "button", "aria-label": `Detail: ${gap.needs.n}`, onclick: () => openCard(gap.needs) }, thumb(gap.needs)),
            h(
              "div",
              null,
              h("div", { class: "row-name" }, gap.needs.n),
              h("div", { class: "row-sub" }, `Máš ${gap.have_qty} × ${gap.have.n}, bez tejto karty ho nezahráš.`),
            ),
            h("span", { class: "price" }, money(gap.needs.p)),
          ),
        ),
      ),
    ),
  );
}

/* ---------- Karta: turnajove decky ---------- */

function archetypeCover(result) {
  const pokemon = result.cards.filter((entry) => entry.card.c === "P");
  return pokemon.find((entry) => entry.card.rb)?.card ?? pokemon[0]?.card ?? result.cards[0]?.card;
}

function renderMetaTab(container) {
  const data = formatDecks();
  const results = metaResult();
  const within = results.filter((r) => r.cost <= state.budget).sort((a, b) => b.share - a.share);
  const above = results.filter((r) => r.cost > state.budget).sort((a, b) => a.cost - b.cost);

  container.append(
    h(
      "p",
      { class: "source-note" },
      `Porovnávam tvoju zbierku s ${data.lists} top deckami z ${data.tournaments} online turnajov na Limitless (${dateSk(data.from)} až ${dateSk(data.to)}).`,
      state.format === "unlimited" ? " Pre Unlimited používam decky zo Standardu." : "",
    ),
    h(
      "div",
      { class: "chips", role: "group", "aria-label": "Rozpočet na dokúpenie" },
      BUDGETS.map((budget) =>
        h(
          "button",
          {
            class: "chip",
            type: "button",
            "aria-pressed": String(state.budget === budget),
            onclick: () => {
              state.budget = budget;
              save();
              renderResults();
            },
          },
          Number.isFinite(budget) ? `do ${budget} €` : "Bez limitu",
        ),
      ),
    ),
  );

  if (!results.length) {
    container.append(h("div", { class: "empty" }, h("strong", null, "Pre tento formát nemám turnajové decky")));
    return;
  }
  if (!within.length) {
    container.append(
      h("p", { class: "source-note" }, `Do ${state.budget} € sa žiadny deck nedá doplniť. Nižšie sú tie najlacnejšie.`),
    );
  }

  const row = (result, over) => {
    const cover = archetypeCover(result);
    const expanded = state.openArchetype === result.id;
    return h(
      "li",
      null,
      h(
        "button",
        {
          class: `meta-row${over ? " over-budget" : ""}`,
          type: "button",
          "aria-expanded": String(expanded),
          onclick: () => {
            state.openArchetype = expanded ? null : result.id;
            renderResults();
          },
        },
        cover ? thumb(cover) : h("span", { class: "thumb" }),
        h(
          "div",
          null,
          h("div", { class: "meta-name" }, result.name),
          h(
            "div",
            { class: "row-sub" },
            `V top umiestneniach ${percent(result.share)}`,
            result.wins ? ` · ${result.wins} ${result.wins === 1 ? "výhra" : result.wins <= 4 ? "výhry" : "výhier"}` : "",
          ),
        ),
        h(
          "div",
          { class: "meta-progress" },
          h("div", { class: "bar" }, h("i", { style: `width:${(result.ownedCount / 60) * 100}%` })),
          h("div", { class: "bar-label" }, `máš ${result.ownedCount}/60`),
        ),
        h(
          "div",
          { class: "meta-cost" },
          result.cost === 0 && !result.unknownPrices ? "Máš všetko" : money(result.cost),
          result.unknownPrices ? h("small", null, `+ ${result.unknownPrices} bez ceny`) : null,
        ),
      ),
      expanded ? metaDetail(result) : null,
    );
  };

  container.append(
    h(
      "ul",
      { class: "meta-list" },
      within.slice(0, 40).map((result) => row(result, false)),
      above.slice(0, within.length ? 12 : 25).map((result) => row(result, true)),
    ),
  );
}

function metaDetail(result) {
  const { list } = result;
  const stats = deckStats(result.cards);
  const validation = validateDeck(
    state.db,
    result.cards.map((entry) => ({ id: entry.card.id, count: entry.count })),
    state.format,
  );
  return h(
    "div",
    { class: "meta-detail" },
    h(
      "div",
      { class: "deck-head" },
      h(
        "p",
        { class: "deck-why", style: "margin-top:0" },
        `${list.placing}. miesto z ${list.players} hráčov, ${list.tournament}, ${dateSk(list.date)}. Z ${result.listsChecked} najlepších verzií tohto decku je táto najlacnejšia na doplnenie.`,
      ),
      statsRow(stats),
      rulesList(validation, state.format),
      deckActions(result.cards, result.missing),
    ),
    buyPanel(result.missing, result.cost, result.unknownPrices) ?? [],
    deckGrids(result.cards).flat().filter(Boolean),
  );
}

/* ---------- Karta: hodnota zbierky ---------- */

function valueTag(row) {
  if (row.inDeck) return { text: "v tvojom decku", tone: "" };
  if (row.played >= 0.05) return { text: `hrá sa v ${percent(row.played)} turnajových deckov`, tone: "" };
  if (row.sell) return { text: "na predaj", tone: "tag-sell" };
  return null;
}

function renderValueTab(container) {
  if (state.collection.size === 0) {
    container.append(
      h(
        "div",
        { class: "empty" },
        h("strong", null, "Najprv potrebujem tvoje karty"),
        "Naskenuj ich alebo zadaj ručne. Potom uvidíš, akú hodnotu má tvoj bulk a ktoré karty sa oplatí predať.",
        h("br"),
        h("button", { class: "btn primary", type: "button", onclick: () => scanner.open() }, "Skenovať karty"),
        " ",
        h("button", { class: "btn", type: "button", onclick: addDemo }, "Skúsiť ukážkový bulk"),
      ),
    );
    return;
  }

  const value = valueResult();
  const stat = (number, label) => h("div", { class: "stat" }, h("b", null, number), h("span", null, label));
  const sellRows = value.rows.filter((row) => row.sell);
  const shown = value.rows.slice(0, 40);

  container.append(
    h(
      "div",
      { class: "deck-head" },
      h("h2", { class: "deck-title" }, `Zbierka má hodnotu asi ${money(value.total)}`),
      h(
        "div",
        { class: "stat-row" },
        stat(money(value.singlesValue), `${cardsWord(value.singlesCount)} nad 1 €`),
        stat(money(value.bulkValue), `${cardsWord(value.bulkCount)} pod 1 €`),
        stat(money(value.sellValue), `na predaj (${cardsWord(value.sellCount)})`),
        value.unknown ? stat(value.unknown, "bez známej ceny") : null,
      ),
      h(
        "p",
        { class: "hint", style: "margin-top:12px" },
        "Orientačné ceny z Cardmarketu pre najlacnejší variant karty. Holo verzie môžu stáť viac, poškodené karty menej. Pri predaji rátaj s poplatkami a poštovným, karty pod 1 € sa po jednej predávajú ťažko.",
      ),
      h(
        "p",
        { class: "hint", style: "margin-top:6px" },
        "Na predaj označujem karty nad 1 €, ktoré nie sú v navrhnutých deckoch a na turnajoch sa takmer nehrajú.",
      ),
      sellRows.length
        ? h(
            "div",
            { class: "actions" },
            h(
              "button",
              {
                class: "btn primary",
                type: "button",
                onclick: () =>
                  copyText(
                    sellRows.map((row) => `${row.qty}x ${row.card.n} ${printLabel(row.card)} (asi ${money(row.unit)} za kus)`).join("\n"),
                    "Zoznam na predaj je skopírovaný.",
                  ),
              },
              "Kopírovať zoznam na predaj",
            ),
          )
        : null,
    ),
    h("h3", { class: "section-title" }, "Najcennejšie karty"),
    h(
      "div",
      { class: "buy" },
      h(
        "ul",
        { class: "buy-list" },
        shown.map((row) => {
          const tag = valueTag(row);
          return h(
            "li",
            null,
            h("button", { class: "open", type: "button", "aria-label": `Detail: ${row.card.n}`, onclick: () => openCard(row.card) }, thumb(row.card)),
            h(
              "div",
              null,
              h("div", { class: "row-name" }, row.qty > 1 ? `${row.qty} × ${row.card.n}` : row.card.n),
              h("div", { class: "row-sub" }, printLabel(row.card), tag ? [" · ", h("span", { class: tag.tone || null }, tag.text)] : null),
            ),
            h(
              "span",
              { class: "price" },
              money(row.value),
              row.qty > 1 ? h("small", null, `${money(row.unit)} za kus`) : null,
            ),
          );
        }),
      ),
      value.rows.length > shown.length
        ? h("p", { class: "hint", style: "margin-top:8px" }, `A ďalších ${value.rows.length - shown.length} lacnejších výtlačkov.`)
        : null,
    ),
  );
}

/* ---------- Vysledky ---------- */

function renderResults() {
  const root = document.getElementById("results");
  const tabButton = (key, label) =>
    h(
      "button",
      {
        type: "button",
        role: "tab",
        "aria-selected": String(state.tab === key),
        onclick: () => {
          state.tab = key;
          renderResults();
        },
      },
      label,
    );
  const content = h("div", { role: "tabpanel" });
  root.replaceChildren(
    h(
      "div",
      { class: "tabs", role: "tablist" },
      tabButton("bulk", "Deck z mojich kariet"),
      tabButton("meta", "Turnajové decky"),
      tabButton("value", "Hodnota zbierky"),
      h(
        "label",
        { class: "switch" },
        h("input", {
          type: "checkbox",
          checked: state.assumeBasicEnergy,
          onchange: (event) => {
            state.assumeBasicEnergy = event.target.checked;
            save();
            renderResults();
          },
        }),
        "Základnú energiu mám",
      ),
    ),
    content,
  );
  if (state.tab === "bulk") renderBulkTab(content);
  else if (state.tab === "meta") renderMetaTab(content);
  else renderValueTab(content);
}

/* ---------- Dialogy ---------- */

function legalityText(card, format) {
  if (isLegal(card, format)) {
    if (format === "standard" && !isBasicEnergy(card) && !state.standardMarks.includes(card.rm)) {
      return { ok: true, text: "Áno, rovnaká karta má legálny novší výtlačok." };
    }
    return { ok: true, text: "Áno" };
  }
  if (card.lf) {
    return { ok: false, text: `Zatiaľ nie. Nový set je legálny od ${dateSk(card.lf)}.` };
  }
  if (needsLegalityCheck(card, format)) {
    return { ok: false, text: "Over si to. Má rovnaké meno ako legálna karta, ale iný text, do decku ju preto neberiem." };
  }
  if (format === "standard") {
    return {
      ok: false,
      text: card.rm
        ? `Nie, značka ${card.rm}. V Standarde sú legálne ${state.standardMarks.join(", ")}.`
        : `Nie, bez regulačnej značky. V Standarde sú legálne ${state.standardMarks.join(", ")}.`,
    };
  }
  return { ok: false, text: "Nie, starší set alebo zakázaná karta." };
}

function openCard(card) {
  const dialog = document.getElementById("card-dialog");
  const url = imageUrl(card, "high");
  dialog.replaceChildren(
    h(
      "div",
      { class: "modal-head" },
      h(
        "div",
        null,
        h("h2", null, card.n),
        h("div", { class: "row-sub" }, `${state.db.sets[card.s]?.n ?? card.s} · ${printLabel(card)}${card.rm ? ` · značka ${card.rm}${card.rma ? " (odhad, v dátach zatiaľ chýba)" : ""}` : ""}`),
      ),
      h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Zavrieť"),
    ),
    h(
      "div",
      { class: "card-detail" },
      url ? h("img", { src: url, alt: card.n, width: 600, height: 825 }) : h("span", { class: "noimg" }, card.n),
      h(
        "div",
        null,
        h(
          "ul",
          { class: "legal-list" },
          Object.entries(FORMATS).map(([key, format]) => {
            const { ok, text } = legalityText(card, key);
            return h("li", null, h("b", null, format.label), h("span", { class: ok ? "legal-yes" : "legal-no" }, text));
          }),
        ),
        h("p", null, typeof card.p === "number" ? `Cena asi ${money(card.p)} (Cardmarket)` : "Cena nie je známa."),
        h("p", null, `V zbierke: ${state.collection.get(card.id) ?? 0}`),
        h(
          "div",
          { class: "actions" },
          h(
            "button",
            {
              class: "btn primary",
              type: "button",
              onclick: () => {
                addCard(card);
                dialog.close();
              },
            },
            "Pridať do zbierky",
          ),
        ),
      ),
    ),
  );
  dialog.showModal();
}

function openVersions(item, index) {
  const dialog = document.getElementById("version-dialog");
  const versions = versionsOfName(state.db, item.card.n, state.format);
  dialog.replaceChildren(
    h(
      "div",
      { class: "modal-head" },
      h("div", null, h("h2", null, item.card.n), h("div", { class: "row-sub" }, "Vyber verziu, ktorú máš.")),
      h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Zavrieť"),
    ),
    h(
      "div",
      { class: "grid" },
      versions.map((version) =>
        h(
          "button",
          {
            class: "tile",
            type: "button",
            "aria-label": `${version.n}, ${printLabel(version)}`,
            title: printLabel(version),
            onclick: () => {
              addToCollection(state.collection, item.card, -item.qty);
              addToCollection(state.collection, version, item.qty);
              state.ambiguous.splice(index, 1);
              dialog.close();
              collectionChanged();
            },
          },
          imageUrl(version)
            ? h("img", { src: imageUrl(version), alt: "", loading: "lazy", width: 245, height: 337 })
            : h("span", { class: "noimg" }, printLabel(version)),
        ),
      ),
    ),
  );
  dialog.showModal();
}

function closeOnBackdrop(event) {
  if (event.target === event.currentTarget) event.currentTarget.close();
}

/* ---------- Start ---------- */

function renderFooter() {
  const data = state.decks.standard;
  const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
  document.getElementById("foot").replaceChildren(
    h(
      "p",
      null,
      "Neoficiálny fanúšikovský projekt bez reklám a zárobku. Nie je spojený s The Pokémon Company, Nintendo, Game Freak ani Creatures, ktorým patria názvy a obrázky kariet.",
    ),
    h(
      "p",
      null,
      "Karty a obrázky: ",
      link("https://tcgdex.dev", "TCGdex"),
      `. Ceny: Cardmarket cez TCGdex, stav k ${dateSk(state.built)}. Decky: `,
      link("https://limitlesstcg.com", "Limitless"),
      `, naposledy ${dateSk(data.to)}. Pravidlá: Play! Pokémon TCG Tournament Handbook, revízia 1. 9. 2026. Pred turnajom si deck over u organizátora.`,
    ),
    h("p", null, "Zbierka sa ukladá iba v tvojom prehliadači a fotky pri skenovaní neopúšťajú zariadenie."),
  );
}

function render() {
  renderFormat();
  renderCollection();
  renderResults();
}

async function start() {
  const results = document.getElementById("results");
  results.append(h("div", { class: "loading" }, "Načítavam databázu kariet…"));
  try {
    const [cards, decks, demo] = await Promise.all(
      ["data/cards.json", "data/decks.json", "data/demo.json"].map(async (path) => {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        return response.json();
      }),
    );
    state.db = createDb(cards);
    state.standardMarks = cards.standardMarks;
    state.built = cards.built;
    state.decks = decks;
    state.demo = demo;
  } catch (error) {
    console.error(error);
    results.replaceChildren(h("div", { class: "empty" }, h("strong", null, "Dáta sa nepodarilo načítať"), "Skús obnoviť stránku."));
    return;
  }
  load();
  for (const id of ["card-dialog", "version-dialog"]) {
    document.getElementById(id).addEventListener("click", closeOnBackdrop);
  }
  document.addEventListener(
    "error",
    (event) => {
      if (event.target?.tagName === "IMG") event.target.style.visibility = "hidden";
    },
    true,
  );
  scanner = createScanner({
    getDb: () => state.db,
    getFormat: () => state.format,
    legalityTag,
    money,
    onAdd: addScanned,
  });
  renderFooter();
  render();
}

start();
