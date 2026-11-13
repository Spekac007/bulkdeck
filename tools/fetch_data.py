#!/usr/bin/env python3
"""Stiahne surove data do data/raw: karty z TCGdex a turnajove decky z Limitless.

  fetch_data.py            stiahne iba to, co chyba
  fetch_data.py --refresh  nanovo stiahne sety a karty (nove ceny a nove sety) a doplni nove turnaje

Pri --refresh sa karty stahuju do cards.new.jsonl a povodny subor sa nahradi az po uspesnom
dokonceni, takze prerusenie nic nepokazi a da sa v nom pokracovat.
"""
import datetime
import json
import os
import pathlib
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
TCGDEX = "https://api.tcgdex.net/v2/en"
LIMITLESS = "https://play.limitlesstcg.com/api"
USER_AGENT = "BulkDeck-prototype/0.1"

# Od akej velkosti turnaje brat, kolko najviac a ako daleko do minulosti pri prvom stiahnuti.
MIN_PLAYERS = {"STANDARD": 32, "EXPANDED": 8}
MAX_NEW_TOURNAMENTS = {"STANDARD": 220, "EXPANDED": 40}
FIRST_RUN_DAYS = {"STANDARD": 35, "EXPANDED": 600}
MAX_LIST_PAGES = 8
# Limitless povoluje 50 poziadaviek za 5 minut (hlavicka RateLimit), preto jedna za 6,2 s.
LIMITLESS_PAUSE = 6.2

print_lock = threading.Lock()


def log(message, error=False):
    with print_lock:
        print(message, file=sys.stderr if error else sys.stdout, flush=True)


def get_json(url, tries=6):
    delay = 1.0
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code not in (429, 500, 502, 503, 504) or attempt == tries - 1:
                raise
            retry_after = error.headers.get("Retry-After")
            if error.code == 429:
                delay = max(delay, float(retry_after) if (retry_after or "").isdigit() else 60.0)
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            if attempt == tries - 1:
                raise
        time.sleep(delay)
        delay *= 2
    return None


def limitless_json(path):
    time.sleep(LIMITLESS_PAUSE)
    return get_json(f"{LIMITLESS}{path}", tries=4)


def read_jsonl(path):
    if not path.exists():
        return []
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # neuplny posledny riadok po preruseni
    return rows


def fetch_many(label, items, worker, output, workers):
    """Spusti worker pre kazdu polozku a vysledky pripisuje do JSONL. Vrati zoznam zlyhanych poloziek."""
    lock = threading.Lock()
    done = {"count": 0}
    failed = []
    started = time.time()

    def run(item):
        try:
            row = worker(item)
        except Exception as error:  # jedna chybna polozka nesmie zastavit cele stahovanie
            with lock:
                failed.append(item)
            log(f"  chyba {label} {str(item)[:80]}: {error}", error=True)
            return
        with lock:
            if row is not None:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            done["count"] += 1
            if done["count"] % 2000 == 0 or (workers == 1 and done["count"] % 10 == 0):
                handle.flush()
                log(f"  {label}: {done['count']}/{len(items)} ({time.time() - started:.0f} s)")

    with output.open("a", encoding="utf-8") as handle:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(run, items))
    log(f"{label}: hotovo {done['count']}, chyby {len(failed)}")
    return failed


def fetch_sets(refresh):
    path = RAW / "sets.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    listing = get_json(f"{TCGDEX}/sets")
    with ThreadPoolExecutor(max_workers=8) as pool:
        details = list(pool.map(lambda s: get_json(f"{TCGDEX}/sets/{s['id']}"), listing))
    details = [d for d in details if d]
    path.write_text(json.dumps(details, ensure_ascii=False), encoding="utf-8")
    log(f"sety: {len(details)}")
    return details


def fetch_cards(sets, refresh):
    current = RAW / "cards.jsonl"
    wanted = list(dict.fromkeys(card["id"] for s in sets for card in s.get("cards", [])))
    target = RAW / "cards.new.jsonl" if refresh else current
    have = {row["id"] for row in read_jsonl(target)}
    missing = [card_id for card_id in wanted if card_id not in have]
    log(f"karty: {len(wanted)} spolu, stiahnem {len(missing)}")
    failed = fetch_many("karty", missing, lambda i: get_json(f"{TCGDEX}/cards/{i}"), target, workers=12)
    if not refresh:
        return
    if len(failed) > len(wanted) * 0.02:
        log(f"karty: zlyhalo {len(failed)}, povodny subor nechavam. Spusti --refresh znova.", error=True)
        return
    if failed:
        # Par zlyhanych kariet doplnime zo starych dat, lepsia stara cena nez ziadna karta.
        old = {row["id"]: row for row in read_jsonl(current)}
        with target.open("a", encoding="utf-8") as handle:
            for card_id in failed:
                if card_id in old:
                    handle.write(json.dumps(old[card_id], ensure_ascii=False) + "\n")
    os.replace(target, current)
    log("karty: novy subor je na mieste")


def new_tournaments(game_format, existing):
    """Turnaje z Limitless, ktore este nemame a su novsie nez nase najnovsie."""
    have = {row["id"] for row in existing}
    dates = [row.get("date") or "" for row in existing if row.get("format") == game_format]
    if dates:
        cutoff = max(dates)
    else:
        first = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=FIRST_RUN_DAYS[game_format])
        cutoff = first.isoformat()
    found = []
    for page in range(1, MAX_LIST_PAGES + 1):
        batch = limitless_json(f"/tournaments?game=PTCG&format={game_format}&limit=100&page={page}")
        if not batch:
            break
        found += [t for t in batch if (t.get("date") or "") > cutoff]
        if min((t.get("date") or "") for t in batch) <= cutoff:
            break
    wanted = [t for t in found if t["id"] not in have and (t.get("players") or 0) >= MIN_PLAYERS[game_format]]
    return wanted[: MAX_NEW_TOURNAMENTS[game_format]]


def fetch_tournaments():
    path = RAW / "tournaments.jsonl"
    existing = read_jsonl(path)

    def worker(tournament):
        standings = limitless_json(f"/tournaments/{tournament['id']}/standings") or []
        # Stacia najlepsie umiestnenia, slabsie decky by len robili sum.
        cut = max(8, tournament["players"] // 8)
        kept = [
            {
                "placing": row.get("placing"),
                "record": row.get("record"),
                "deck": row.get("deck"),
                "decklist": row.get("decklist"),
            }
            for row in standings
            if row.get("decklist") and (row.get("placing") or 10**6) <= cut
        ]
        return {
            "id": tournament["id"],
            "name": tournament.get("name"),
            "format": tournament.get("format"),
            "date": tournament.get("date"),
            "players": tournament.get("players"),
            "standings": kept,
        }

    for game_format in MIN_PLAYERS:
        listing = new_tournaments(game_format, existing)
        log(f"turnaje {game_format}: novych {len(listing)}")
        fetch_many(f"turnaje {game_format}", listing, worker, path, workers=1)


def main():
    refresh = "--refresh" in sys.argv[1:]
    RAW.mkdir(parents=True, exist_ok=True)
    # Limitless ide pomaly kvoli limitu, preto bezi popri kartach vo vlastnom vlakne.
    tournaments = threading.Thread(target=fetch_tournaments)
    tournaments.start()
    try:
        fetch_cards(fetch_sets(refresh), refresh)
    finally:
        tournaments.join()
    log("HOTOVO")


if __name__ == "__main__":
    main()
