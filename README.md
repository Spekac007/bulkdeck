# BulkDeck

Prototyp: hráč naskenuje alebo zadá svoje Pokémon TCG karty a appka z nich zloží deck podľa oficiálnych pravidiel. Potom poradí, čo sa oplatí dokúpiť, a odhadne hodnotu zbierky.

**Naživo:** https://spekac007.github.io/bulkdeck/

Neoficiálny fanúšikovský projekt bez reklám a zárobku. Nie je spojený s The Pokémon Company, Nintendo, Game Freak ani Creatures.

## Spustenie na počítači

Appka je statická stránka v `app/`, stačí ju servírovať. Príkaz spusti v priečinku `BulkDeck`, inak server stránku nenájde a vráti 404:

```bash
python -m http.server 8771 --directory app
```

Potom otvor http://localhost:8771. Skener potrebuje kameru alebo fotky:

- **Živá kamera** funguje iba na `localhost` alebo cez HTTPS, tak to vyžadujú prehliadače. Na mobile preto použi zverejnenú adresu.
- **Odfotiť a Nahrať fotky** fungujú aj bez HTTPS.

## Zverejnenie

Každý push do vetvy `main` spustí `.github/workflows/pages.yml`: prebehnú testy a priečinok `app/` sa nasadí na GitHub Pages. Stránka má `noindex`, aby ju vyhľadávače zatiaľ neindexovali.

## Obnova dát

```bash
python tools/fetch_data.py --refresh
python tools/build_data.py
python tools/build_scan_index.py
```

- `fetch_data.py --refresh` nanovo stiahne sety a karty (nové ceny a nové sety) a doplní turnaje novšie než tie, ktoré už máme. Bez `--refresh` stiahne iba to, čo chýba.
- `build_data.py` z toho vyrobí `app/data/cards.json`, `decks.json` a `demo.json`. Standard decky berie z posledných 35 dní.
- `build_scan_index.py` dopočíta odtlačky iba pre nové karty.

Stiahnutie všetkých kariet robí okolo 24 000 požiadaviek na TCGdex a trvá asi 10 minút, takže to nespúšťaj zbytočne. Limitless povoľuje 50 požiadaviek za 5 minút, preto sa turnaje sťahujú po jednom s pauzou.

Po obnove si prečítaj výpis `build_data.py`. Upozorní, keď nový set nemá v dátach regulačné značky, keď sa nejaká karta z decklistov nepodarila priradiť alebo keď turnajový deck obsahuje podľa nás nelegálnu kartu.

## Testy

```bash
node --test tests/engine.test.mjs tests/scan.test.mjs
```

Testy bežia na skutočných dátach v `app/data`. Skontrolujú aj to, že reálne turnajové decky prejdú našou kontrolou pravidiel.

## Skener

Beží celý v zariadení (`app/scan.js` vo web workeri `app/scan-worker.js`), fotky nikam neodchádzajú.

1. Nájde obrys karty: farebné hrany, Houghova transformácia, až 4 možné štvoruholníky.
2. Kartu vyrovná a z ilustrácie spočíta 256-bitový odtlačok (DCT, ako pHash). Text sa nepoužíva, takže funguje aj na iných jazykoch.
3. Odtlačok porovná s databázou. Spomedzi možných obrysov vyhrá ten s najlepšou zhodou.
4. Istú zhodu pridá do zoznamu, neistú a viac výtlačkov s rovnakým obrázkom necháva potvrdiť hráča.

Po pridaní nových kariet treba odtlačky prepočítať:

```bash
python tools/build_scan_index.py
```

Bez argumentu si obrázky stiahne a neukladá ich. Vypočet musí presne sedieť s `app/scan.js`, kontroluje to `tests/scan.test.mjs`.

Meranie na simulovaných fotkách:

```bash
python tools/scan_scenes.py <priečinok s high.webp> <sample.json> <výstup>
node tools/scan_benchmark.mjs <výstup> foto
```

Výsledok k 2026-11-05 v režime fotiek, 360 simulovaných fotiek v troch úrovniach: rovnaká karta na prvom mieste v 95 až 97,5 %, 343 zhôd označených ako isté, z toho 0 zlých. Pri 30 prázdnych záberoch 3 skončili ako neistá zhoda, ktorú musí hráč potvrdiť. Na skutočných fotkách to ešte nie je zmerané.

## Pravidlá a ich zdroje

| Pravidlo | Zdroj |
| --- | --- |
| Presne 60 kariet, najviac 4 s rovnakým menom okrem základnej energie | Play! Pokémon TCG Tournament Handbook, revízia 1. 9. 2026, kap. 4 |
| Standard: značky H, I, J | Community letter z 19. 3. 2026, sedí s dátami TCGdex |
| Starší výtlačok s rovnakým menom a textom | Handbook § 4.1.3 |
| Pokémon s rotovanou značkou sa nedá použiť namiesto legálneho výtlačku | Bulbapedia, Standard format. Handbook to takto výslovne nerozlišuje, overené na turnajových deckoch |
| Zakázané karty v Expanded | [Banned Card List](https://www.pokemon.com/us/play-pokemon/about/pokemon-tcg-banned-card-list), v `data/banned_expanded.json` |
| ACE SPEC a Radiant najviac 1, Prism Star 1 s rovnakým menom | Text na kartách |
| Aspoň 1 Basic Pokémon | Pravidlá hry. Oficiálny rulebook PDF sa nedal stiahnuť strojovo, pravidlo vychádza z mulligan pravidiel v Handbooku |
| Nový set je legálny od druhého piatka po vydaní, nový výtlačok už hrateľnej karty hneď | Handbook § 4.1.2 a 4.1.3. Dátum je v dátach ako `lf` a appka ho vyhodnocuje podľa dnešného dňa |

Pri `Standard` a značkách treba po každej rotácii upraviť `STANDARD_MARKS` v `tools/build_data.py`.

## Známe obmedzenia

- Stará karta s rovnakým menom ako legálna karta sa počíta ako legálna, iba ak je text po zjednotení bežných preformulovaní rovnaký (`REWORDINGS` v `tools/build_data.py`) alebo je v ručne posúdenom zozname `data/functional_reprints.json`. Ostatné appka do decku neberie a hráčovi napíše „over legalitu“. Tento zoznam posudzoval model, nie rozhodca, takže ho treba pred ostrým použitím prejsť.
- Skóre deckov z vlastných kariet je jednoduchá heuristika, nesimuluje hru.
- Skener je zmeraný iba na simulovaných fotkách. Holo a reverse holo povrch, obaly a opotrebované karty môžu presnosť znížiť. Vyskúšaný nebol ani na skutočnom mobile a skutočnej kamere.
- Skener nepozná 1 631 z 21 290 kariet, ktoré v TCGdex nemajú obrázok. Zo Standardu je to 172 z 3 419 kariet bez základnej energie, hlavne promo karty MEP a SVP. Obrázky by sa dali doplniť z Limitless.
- Skener číta iba obrázok, nie číslo karty. Rovnaký obrázok vo viacerých výtlačkoch preto rozlíši hráč.
- Binder s viacerými kartami na jednej fotke nie je podporovaný, skenuje sa po jednej karte.
- Turnajové decky sú z online turnajov na Limitless, nie z oficiálnych turnajov. Online turnaje púšťajú nový set skôr, takže decky s ešte nelegálnymi kartami appka do dátumu legality neponúka.
- Ceny sú orientačné: stredná hodnota z trendu a priemerov za 7 a 30 dní z Cardmarketu cez TCGdex, pre lacnejší z variantov karty, bez poštovného. Karty, ktoré majú v TCGdex priradený rovnaký produkt Cardmarketu ako iná karta, cenu nemajú, lebo sa nedá zistiť, ktorej patrí.
- TCGdex pri čerstvom sete pár dní nemá regulačné značky ani texty Trainerov. Značka sa vtedy preberie z predošlého setu série a v appke je označená ako odhad.
- Hodnota zbierky je dolný odhad. Nevie, či má hráč holo verziu ani v akom stave karta je.

## Zdroje a licencie

- **Karty, obrázky a ceny:** [TCGdex](https://tcgdex.dev). Databáza je pod licenciou MIT, Copyright (c) 2021 TCGdex. Obrázky sa načítavajú priamo z `assets.tcgdex.net`. Ceny pochádzajú z Cardmarketu.
- **Turnajové decky:** [Limitless](https://limitlesstcg.com), verejné API. V dátach nie sú mená hráčov.
- **Pravidlá:** Play! Pokémon TCG Tournament Handbook a zoznam zakázaných kariet na pokemon.com.
- Názvy, texty a obrázky kariet sú chránené autorským právom The Pokémon Company, Nintendo, Game Freak a Creatures. TCGdex ani Limitless nedávajú výslovné povolenie na ich ďalšie použitie. Ak by o to vlastník práv požiadal, stránku treba stiahnuť.
