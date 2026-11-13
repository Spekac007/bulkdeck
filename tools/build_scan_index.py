#!/usr/bin/env python3
"""Spocita odtlacky ilustracii vsetkych kariet pre skener v appke.

Pouzitie: build_scan_index.py [priecinok s low.webp] [--all]

Bez priecinka sa obrazky stiahnu z TCGdex, spracuju v pamati a neukladaju sa.
Pocitaju sa iba karty, ktore v indexe este nie su. S --all sa prepocita vsetko.
Vystup: app/data/scan.bin (odtlacky) a app/data/scan.json (poradie kariet a nastavenia).
Vypocet musi presne sediet s app/scan.js, kontroluje to tests/scan.test.mjs.
"""
import json
import math
import pathlib
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "data"
BASE = "https://assets.tcgdex.net/en/"
USER_AGENT = "BulkDeck-prototype/0.1"

CARD_WIDTH, CARD_HEIGHT = 245, 337
CONFIG = {"size": 32, "bits": 256, "skip": 2, "art": {"x0": 0.09, "x1": 0.91, "y0": 0.11, "y1": 0.5}}


def plan(config):
    size = config["size"]
    pairs = sorted(((u, v) for u in range(size) for v in range(size)), key=lambda p: (p[0] + p[1], p[0]))
    picks = pairs[1 + config["skip"]: 1 + config["skip"] + config["bits"]]
    basis = np.array([[math.cos(math.pi * (2 * x + 1) * u / (2 * size)) for x in range(size)] for u in range(size)])
    return picks, basis


PICKS, BASIS = plan(CONFIG)
PICK_U = np.array([p[0] for p in PICKS])
PICK_V = np.array([p[1] for p in PICKS])


def round_half_up(value):
    return math.floor(value + 0.5)


def hash_gray(gray):
    """gray: pole CARD_HEIGHT x CARD_WIDTH. Rovnaky vypocet ako hashFromIntegral v app/scan.js."""
    art, size = CONFIG["art"], CONFIG["size"]
    ax = max(0, round_half_up(art["x0"] * CARD_WIDTH))
    bx = min(CARD_WIDTH, round_half_up(art["x1"] * CARD_WIDTH))
    ay = max(0, round_half_up(art["y0"] * CARD_HEIGHT))
    by = min(CARD_HEIGHT, round_half_up(art["y1"] * CARD_HEIGHT))
    crop_w, crop_h = bx - ax, by - ay

    integral = np.zeros((CARD_HEIGHT + 1, CARD_WIDTH + 1))
    integral[1:, 1:] = np.cumsum(np.cumsum(gray, axis=0), axis=1)
    xs = ax + (np.arange(size + 1) * crop_w) // size
    ys = ay + (np.arange(size + 1) * crop_h) // size
    corners = integral[np.ix_(ys, xs)]
    sums = corners[1:, 1:] - corners[:-1, 1:] - corners[1:, :-1] + corners[:-1, :-1]
    areas = np.outer(np.diff(ys), np.diff(xs))
    small = sums / areas

    # Prvy index koeficientu je riadok, druhy stlpec.
    coefficients = BASIS @ small @ BASIS.T
    values = coefficients[PICK_U, PICK_V]
    bits = values > np.median(values)
    return np.packbits(bits).tobytes()


def decode(payload):
    image = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None
    if image.shape[0] != CARD_HEIGHT or image.shape[1] != CARD_WIDTH:
        image = cv2.resize(image, (CARD_WIDTH, CARD_HEIGHT), interpolation=cv2.INTER_AREA)
    image = image.astype(np.float64)
    return 0.114 * image[..., 0] + 0.587 * image[..., 1] + 0.299 * image[..., 2]


def download(url):
    delay = 1.0
    for attempt in range(5):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == 4:
                raise
        time.sleep(delay)
        delay *= 2
    return None


def main():
    paths = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    cache = pathlib.Path(paths[0]) if paths else None
    cards = json.loads((OUT / "cards.json").read_text(encoding="utf-8"))["cards"]
    with_image = [c for c in cards if c.get("im")]

    existing = {}
    if "--all" not in sys.argv and (OUT / "scan.json").exists() and (OUT / "scan.bin").exists():
        meta = json.loads((OUT / "scan.json").read_text(encoding="utf-8"))
        blob = (OUT / "scan.bin").read_bytes()
        size = CONFIG["bits"] // 8
        if meta.get("config") == CONFIG and len(blob) == len(meta["ids"]) * size:
            existing = {card_id: blob[i * size:(i + 1) * size] for i, card_id in enumerate(meta["ids"])}
    print(f"v indexe uz je {len(existing)}, pocitam {sum(1 for c in with_image if c['id'] not in existing)}")

    def worker(card):
        if card["id"] in existing:
            return card["id"], existing[card["id"]]
        path = cache / f"{card['id']}.webp" if cache else None
        if path and path.exists():
            payload = path.read_bytes()
        elif cache:
            return card["id"], None
        else:
            payload = download(f"{BASE}{card['im']}/low.webp")
        if not payload:
            return card["id"], None
        gray = decode(payload)
        return card["id"], None if gray is None else hash_gray(gray)

    started = time.time()
    ids, chunks = [], []
    missing = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        for card_id, digest in pool.map(worker, with_image):
            if digest is None:
                missing.append(card_id)
                continue
            ids.append(card_id)
            chunks.append(digest)
            if len(ids) % 5000 == 0:
                print(f"{len(ids)} ({time.time() - started:.0f} s)", flush=True)

    (OUT / "scan.bin").write_bytes(b"".join(chunks))
    (OUT / "scan.json").write_text(
        json.dumps({"config": CONFIG, "ids": ids}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"odtlackov {len(ids)}, bez obrazka v databaze {len(cards) - len(with_image)}, nedostupnych {len(missing)}")
    print(f"scan.bin {(OUT / 'scan.bin').stat().st_size / 1e6:.2f} MB, scan.json {(OUT / 'scan.json').stat().st_size / 1e6:.2f} MB")

    # Kontrola proti app/scan.js: rovnaky umely obrazok musi dat rovnaky odtlacok.
    yy, xx = np.mgrid[0:CARD_HEIGHT, 0:CARD_WIDTH]
    pattern = 127.5 + 60 * np.sin(xx / 17.0) + 50 * np.cos(yy / 23.0) + 15 * np.sin((xx + yy) / 5.0)
    fixture = {"note": "Vzniká v tools/build_scan_index.py", "hash": hash_gray(pattern).hex()}
    (ROOT / "tests" / "scan_parity.json").write_text(json.dumps(fixture, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
