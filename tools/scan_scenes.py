#!/usr/bin/env python3
"""Vyrobi simulovane fotky kariet na meranie skenera.

Pouzitie: scan_scenes.py <priecinok s high.webp> <sample.json> <vystupny priecinok>

Su to simulacie, nie skutocne fotky z mobilu: perspektiva, svetlo, odlesk, rozmazanie,
sum a JPEG. Skutocnu presnost treba overit na fotkach.
"""
import json
import math
import pathlib
import random
import struct
import sys

import cv2
import numpy as np

PER_TIER = 120
NEGATIVES = 30
TIERS = {
    # velkost karty vo fotke, perspektiva, rotacia, rozmazanie, sum, JPEG, odlesk
    "lahke": dict(size=(0.72, 0.9), persp=0.02, rot=4, blur=0.4, noise=2, jpeg=90, glare=0.0, sheen=0.0, light=0.12, wb=0.04),
    "stredne": dict(size=(0.6, 0.85), persp=0.05, rot=10, blur=0.9, noise=4, jpeg=80, glare=0.35, sheen=0.25, light=0.25, wb=0.09),
    "tazke": dict(size=(0.5, 0.8), persp=0.09, rot=18, blur=1.5, noise=7, jpeg=65, glare=0.75, sheen=0.5, light=0.4, wb=0.16),
}
FRAMES = [(640, 853), (853, 640), (960, 540), (720, 960)]


def value_noise(rng, height, width, cells):
    grid = rng.random((cells, max(2, int(cells * width / height))), dtype=np.float32)
    return cv2.resize(grid, (width, height), interpolation=cv2.INTER_CUBIC)


def background(rng, height, width):
    kind = rng.integers(0, 5)
    if kind == 0:  # tmavy stol
        color = rng.uniform(15, 60, 3)
        image = np.ones((height, width, 3), np.float32) * color
    elif kind == 1:  # svetly papier alebo stol, tazsi kontrast s okrajom karty
        color = rng.uniform(185, 240, 3)
        image = np.ones((height, width, 3), np.float32) * color
    elif kind == 2:  # drevo
        streaks = cv2.resize(rng.random((height, 12), dtype=np.float32), (width, height), interpolation=cv2.INTER_LINEAR)
        streaks = streaks * 0.6 + value_noise(rng, height, width, 6) * 0.4
        base = np.array([40, 80, 130], np.float32) * rng.uniform(0.7, 1.3)
        image = base[None, None, :] * (0.6 + streaks[..., None] * 0.8)
    elif kind == 3:  # prechod
        low = rng.uniform(20, 120, 3)
        high = rng.uniform(100, 220, 3)
        ramp = np.linspace(0, 1, height, dtype=np.float32)[:, None, None]
        image = low * (1 - ramp) + high * ramp
        image = np.broadcast_to(image, (height, width, 3)).copy()
    else:  # podlozka s predmetmi
        image = np.ones((height, width, 3), np.float32) * rng.uniform(40, 150, 3)
        for _ in range(int(rng.integers(2, 6))):
            x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
            w, h = int(rng.integers(30, width // 2)), int(rng.integers(30, height // 2))
            cv2.rectangle(image, (x, y), (x + w, y + h), tuple(float(v) for v in rng.uniform(0, 255, 3)), -1)
    texture = (value_noise(rng, height, width, 40) - 0.5) * 18
    return np.clip(image + texture[..., None], 0, 255).astype(np.float32)


def rounded_mask(height, width, radius):
    mask = np.zeros((height, width), np.uint8)
    cv2.rectangle(mask, (radius, 0), (width - radius, height), 255, -1)
    cv2.rectangle(mask, (0, radius), (width, height - radius), 255, -1)
    for cx, cy in ((radius, radius), (width - radius, radius), (radius, height - radius), (width - radius, height - radius)):
        cv2.circle(mask, (cx, cy), radius, 255, -1)
    return mask.astype(np.float32) / 255


def load_card(path):
    image = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(path)
    return image.astype(np.float32)


def make_scene(card, params, rng, py_rng):
    frame_w, frame_h = py_rng.choice(FRAMES)
    image = background(rng, frame_h, frame_w)

    height, width = card.shape[:2]
    # Velkost sa viaze na kratsiu aj dlhsiu stranu, aby sa karta vosla do zaberu.
    fraction = rng.uniform(*params["size"])
    target_h = fraction * min(frame_h, frame_w / 0.716)
    target_w = target_h * width / height
    angle = math.radians(rng.uniform(-params["rot"], params["rot"]))
    cos, sin = math.cos(angle), math.sin(angle)
    half = np.array([[-target_w / 2, -target_h / 2], [target_w / 2, -target_h / 2], [target_w / 2, target_h / 2], [-target_w / 2, target_h / 2]])
    corners = half @ np.array([[cos, -sin], [sin, cos]]).T
    corners = corners + rng.uniform(-params["persp"], params["persp"], (4, 2)) * target_h

    spread = corners.max(axis=0) - corners.min(axis=0)
    room = np.maximum(np.array([frame_w, frame_h]) - spread, 1) / 2 * 0.8
    center = np.array([frame_w / 2, frame_h / 2]) + rng.uniform(-1, 1, 2) * room
    corners = corners + center

    source = np.array([[0, 0], [width, 0], [width, height], [0, height]], np.float32)
    matrix = cv2.getPerspectiveTransform(source, corners.astype(np.float32))
    mask = rounded_mask(height, width, int(width * 0.045))

    # Tien pod kartou
    shadow = cv2.warpPerspective(mask, matrix, (frame_w, frame_h), flags=cv2.INTER_LINEAR)
    offset = np.float32([[1, 0, rng.uniform(-5, 10)], [0, 1, rng.uniform(0, 12)]])
    shadow = cv2.warpAffine(shadow, offset, (frame_w, frame_h))
    shadow = cv2.GaussianBlur(shadow, (0, 0), 7)
    image = image * (1 - 0.35 * shadow[..., None])

    # Karta: zmensenie pred warpom potlaci aliasing
    scale = target_h / height
    if scale < 0.8:
        pre_w, pre_h = int(width * scale * 1.3), int(height * scale * 1.3)
        small = cv2.resize(card, (pre_w, pre_h), interpolation=cv2.INTER_AREA)
        small_mask = cv2.resize(mask, (pre_w, pre_h), interpolation=cv2.INTER_AREA)
        small_source = np.array([[0, 0], [pre_w, 0], [pre_w, pre_h], [0, pre_h]], np.float32)
        matrix_small = cv2.getPerspectiveTransform(small_source, corners.astype(np.float32))
    else:
        small, small_mask, matrix_small = card, mask, matrix
    warped = cv2.warpPerspective(small, matrix_small, (frame_w, frame_h), flags=cv2.INTER_LINEAR)
    warped_mask = cv2.warpPerspective(small_mask, matrix_small, (frame_w, frame_h), flags=cv2.INTER_LINEAR)[..., None]

    # Lesk obalu: sikmy pas
    if rng.random() < params["sheen"]:
        yy, xx = np.mgrid[0:frame_h, 0:frame_w].astype(np.float32)
        direction = rng.uniform(0, math.pi)
        position = (xx * math.cos(direction) + yy * math.sin(direction))
        center_pos = rng.uniform(position.min(), position.max())
        band = np.exp(-(((position - center_pos) / rng.uniform(25, 90)) ** 2))
        warped = warped + band[..., None] * rng.uniform(25, 70)
    # Odlesk: svetla skvrna na karte
    if rng.random() < params["glare"]:
        spot = corners.mean(axis=0) + rng.uniform(-0.3, 0.3, 2) * target_h
        yy, xx = np.mgrid[0:frame_h, 0:frame_w].astype(np.float32)
        radius = rng.uniform(0.08, 0.2) * target_h
        glow = np.exp(-((xx - spot[0]) ** 2 + (yy - spot[1]) ** 2) / (2 * radius**2))
        warped = warped + glow[..., None] * rng.uniform(70, 170)
    image = warped * warped_mask + image * (1 - warped_mask)

    # Svetlo v miestnosti a vyvazenie bielej
    yy, xx = np.mgrid[0:frame_h, 0:frame_w].astype(np.float32)
    direction = rng.uniform(0, 2 * math.pi)
    ramp = (xx / frame_w - 0.5) * math.cos(direction) + (yy / frame_h - 0.5) * math.sin(direction)
    image = image * (1 + ramp[..., None] * params["light"] * 2)
    image = image * rng.uniform(1 - params["wb"], 1 + params["wb"], 3)
    image = image * rng.uniform(1 - params["light"], 1 + params["light"] * 0.6)
    gamma = rng.uniform(1 - params["light"] * 0.7, 1 + params["light"] * 0.7)
    image = 255 * np.power(np.clip(image / 255, 0, 1), gamma)

    if params["blur"] > 0:
        image = cv2.GaussianBlur(image, (0, 0), float(rng.uniform(params["blur"] * 0.4, params["blur"])))
    image = image + rng.normal(0, params["noise"], image.shape)
    image = np.clip(image, 0, 255).astype(np.uint8)
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, params["jpeg"]])
    assert ok
    return encoded, corners


def write_scene(out_dir, name, encoded):
    (out_dir / f"{name}.jpg").write_bytes(encoded.tobytes())
    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    rgb = cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)
    height, width = rgb.shape[:2]
    with (out_dir / f"{name}.rgb").open("wb") as handle:
        handle.write(struct.pack("<II", width, height))
        handle.write(rgb.tobytes())


def main():
    high_dir, sample_path, out_dir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    ids = json.loads(sample_path.read_text(encoding="utf-8"))
    rng = np.random.default_rng(151)
    py_rng = random.Random(151)
    manifest = []
    position = 0
    for tier, params in TIERS.items():
        made = 0
        while made < PER_TIER:
            card_id = ids[position % len(ids)]
            position += 1
            path = high_dir / f"{card_id}.webp"
            if not path.exists():
                continue
            name = f"{tier}_{made:03d}"
            encoded, corners = make_scene(load_card(path), params, rng, py_rng)
            write_scene(out_dir, name, encoded)
            manifest.append({"name": name, "tier": tier, "id": card_id, "corners": corners.tolist()})
            made += 1
        print(tier, made, flush=True)
    for index in range(NEGATIVES):
        frame_w, frame_h = py_rng.choice(FRAMES)
        image = np.clip(background(rng, frame_h, frame_w) + rng.normal(0, 4, (frame_h, frame_w, 3)), 0, 255).astype(np.uint8)
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
        assert ok
        name = f"prazdne_{index:03d}"
        write_scene(out_dir, name, encoded)
        manifest.append({"name": name, "tier": "prazdne", "id": None, "corners": None})
    (out_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    print("HOTOVO", len(manifest), flush=True)


if __name__ == "__main__":
    main()
