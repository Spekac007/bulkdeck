// Spustenie: node --test tests/scan.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  HASH_CONFIG,
  ScanIndex,
  assessMatches,
  cardHashes,
  detectCard,
  guideCorners,
  hashFromIntegral,
  recognizeCard,
  toGray,
  warpCard,
} from "../app/scan.js";

const dataFile = (name) => fileURLToPath(new URL(`../app/data/${name}`, import.meta.url));
const meta = JSON.parse(readFileSync(dataFile("scan.json"), "utf8"));
const bin = readFileSync(dataFile("scan.bin"));
const index = new ScanIndex(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const parity = JSON.parse(readFileSync(fileURLToPath(new URL("./scan_parity.json", import.meta.url)), "utf8"));

function patternCard() {
  const card = new Float32Array(CARD_WIDTH * CARD_HEIGHT);
  for (let y = 0; y < CARD_HEIGHT; y++) {
    for (let x = 0; x < CARD_WIDTH; x++) {
      card[y * CARD_WIDTH + x] = 127.5 + 60 * Math.sin(x / 17) + 50 * Math.cos(y / 23) + 15 * Math.sin((x + y) / 5);
    }
  }
  return card;
}

function hex(words) {
  return Buffer.from(words.buffer, words.byteOffset, words.byteLength).toString("hex");
}

function bitDifference(a, b) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  let total = 0;
  for (let i = 0; i < left.length; i++) {
    let value = left[i] ^ right[i];
    while (value) {
      total += value & 1;
      value >>= 1;
    }
  }
  return total;
}

test("odtlačok: JavaScript aj Python počítajú to isté", () => {
  const [center] = cardHashes(patternCard(), HASH_CONFIG, [{ dx: 0, dy: 0, scale: 1 }]);
  assert.ok(bitDifference(hex(center), parity.hash) <= 2, `rozdiel ${bitDifference(hex(center), parity.hash)} bitov`);
});

test("databáza: scan.bin sedí k scan.json", () => {
  assert.equal(index.table.length, meta.ids.length * (HASH_CONFIG.bits / 32));
  assert.ok(meta.ids.length > 15000);
  assert.deepEqual(meta.config, HASH_CONFIG);
});

test("hľadanie: rovnaký odtlačok z databázy je prvý so vzdialenosťou 0", () => {
  for (const row of [0, 1234, 9999, meta.ids.length - 1]) {
    const query = index.table.slice(row * index.words, (row + 1) * index.words);
    const [first] = index.search([query], 5);
    assert.equal(first.distance, 0);
    assert.equal(index.distanceBetween(first.row, row), 0);
  }
});

test("hodnotenie: náhodný odtlačok nie je istá zhoda", () => {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (let run = 0; run < 20; run++) {
    const query = Uint32Array.from({ length: index.words }, random);
    const result = assessMatches(index, index.search([query], 12));
    assert.equal(result.status, "none", `vzdialenosť ${result.distance}`);
  }
});

// Umela fotka: svetly obdlznik v pomere karty na tmavom pozadi, lahko otoceny.
function syntheticPhoto(width, height, angleDegrees) {
  const data = new Uint8ClampedArray(width * height * 3).fill(30);
  const cardHeight = height * 0.7;
  const cardWidth = (cardHeight * 63) / 88;
  const angle = (angleDegrees * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x - cx) * Math.cos(angle) + (y - cy) * Math.sin(angle);
      const v = -(x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle);
      if (Math.abs(u) <= cardWidth / 2 && Math.abs(v) <= cardHeight / 2) {
        const i = (y * width + x) * 3;
        data[i] = 225;
        data[i + 1] = 205;
        data[i + 2] = 90;
      }
    }
  }
  const half = [
    [-cardWidth / 2, -cardHeight / 2],
    [cardWidth / 2, -cardHeight / 2],
    [cardWidth / 2, cardHeight / 2],
    [-cardWidth / 2, cardHeight / 2],
  ];
  const corners = half.map(([u, v]) => [cx + u * Math.cos(angle) - v * Math.sin(angle), cy + u * Math.sin(angle) + v * Math.cos(angle)]);
  return { image: { width, height, channels: 3, data }, corners };
}

function worstCornerError(found, truth) {
  const size = Math.hypot(truth[3][0] - truth[0][0], truth[3][1] - truth[0][1]);
  return Math.max(...found.map((point, i) => Math.hypot(point[0] - truth[i][0], point[1] - truth[i][1]))) / size;
}

test("detekcia: nájde kartu aj pootočenú", () => {
  for (const angle of [0, 8, -12]) {
    const { image, corners } = syntheticPhoto(640, 853, angle);
    const found = detectCard(image);
    assert.ok(found, `uhol ${angle}: nič nenašlo`);
    assert.ok(worstCornerError(found.corners, corners) < 0.03, `uhol ${angle}: chyba rohov ${worstCornerError(found.corners, corners)}`);
  }
});

test("detekcia: karta položená nabok má dlhšiu stranu zvislo", () => {
  const { image } = syntheticPhoto(853, 853, 90);
  const found = detectCard(image);
  assert.ok(found);
  const [a, b, , d] = found.corners;
  assert.ok(Math.hypot(d[0] - a[0], d[1] - a[1]) > Math.hypot(b[0] - a[0], b[1] - a[1]));
});

test("detekcia: prázdny obrázok nie je karta", () => {
  const data = new Uint8ClampedArray(640 * 480 * 3).fill(120);
  assert.equal(detectCard({ width: 640, height: 480, channels: 3, data }), null);
  const result = recognizeCard({ width: 640, height: 480, channels: 3, data }, index);
  assert.equal(result.status, "nocard");
});

test("rozpoznanie: obrys bez zhody v databáze sa berie ako žiadna karta", () => {
  const { image } = syntheticPhoto(640, 853, 5);
  assert.equal(recognizeCard(image, index).status, "nocard");
});

test("rozpoznanie: záložný rámik sa použije, keď sa obrys nenájde", () => {
  // Rovnomerny obrazok nema ziadnu hranu a v databaze nema zhodu.
  const data = new Uint8ClampedArray(640 * 480 * 3).fill(120);
  const result = recognizeCard({ width: 640, height: 480, channels: 3, data }, index, { fallbacks: [guideCorners(640, 480)] });
  assert.equal(result.status, "nocard");
  assert.equal(result.detection.fallback, true);
});

test("rámik: rohy majú pomer karty a zmestia sa do obrazu", () => {
  for (const [width, height] of [[640, 853], [1280, 720]]) {
    const corners = guideCorners(width, height);
    const cardWidth = corners[1][0] - corners[0][0];
    const cardHeight = corners[3][1] - corners[0][1];
    assert.ok(Math.abs(cardHeight / cardWidth - 88 / 63) < 0.001);
    for (const [x, y] of corners) assert.ok(x >= 0 && y >= 0 && x <= width && y <= height);
  }
});

test("vyrovnanie: rovnobežná karta sa vykreslí rovnako", () => {
  const card = patternCard();
  const gray = { width: CARD_WIDTH, height: CARD_HEIGHT, data: card, scale: 1 };
  const corners = [[0, 0], [CARD_WIDTH, 0], [CARD_WIDTH, CARD_HEIGHT], [0, CARD_HEIGHT]];
  const warped = warpCard(gray, corners);
  let difference = 0;
  for (let i = 0; i < card.length; i++) difference += Math.abs(card[i] - warped[i]);
  assert.ok(difference / card.length < 1);
});

test("obrázok: zmenšenie zachová rozmery aj jas", () => {
  const data = new Uint8ClampedArray(400 * 300 * 4).fill(200);
  const gray = toGray({ width: 400, height: 300, channels: 4, data }, 100);
  assert.equal(gray.width, 100);
  assert.equal(gray.height, 75);
  assert.ok(Math.abs(gray.data[10] - 200) < 0.01);
  assert.equal(gray.scale, 0.25);
  assert.ok(hashFromIntegral);
});
