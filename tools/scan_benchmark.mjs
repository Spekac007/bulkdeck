// Meranie skenera na simulovanych fotkach z tools/scan_scenes.py.
// Pouzitie: node tools/scan_benchmark.mjs <priecinok so scenami> [foto|ziva] [otocenie 0|90|180]
// "foto" a "ziva" su rovnake nastavenia ako v app/scan-worker.js.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ScanIndex, detectCard, guideCorners, recognizeCard } from "../app/scan.js";

const scenesDir = process.argv[2];
const mode = process.argv[3] ?? "foto";
const rotation = Number(process.argv[4] ?? 0);
const appFile = (name) => fileURLToPath(new URL(`../app/data/${name}`, import.meta.url));
const meta = JSON.parse(readFileSync(appFile("scan.json"), "utf8"));
const bin = readFileSync(appFile("scan.bin"));
const index = new ScanIndex(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const cards = JSON.parse(readFileSync(appFile("cards.json"), "utf8")).cards;
const byId = new Map(cards.map((c) => [c.id, c]));
const manifest = JSON.parse(readFileSync(join(scenesDir, "manifest.json"), "utf8"));

function loadScene(name) {
  const file = readFileSync(join(scenesDir, `${name}.rgb`));
  const width = file.readUInt32LE(0);
  const height = file.readUInt32LE(4);
  const data = file.subarray(8);
  if (!rotation) return { width, height, channels: 3, data };
  const outW = rotation === 90 ? height : width;
  const outH = rotation === 90 ? width : height;
  const output = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = rotation === 90 ? height - 1 - y : width - 1 - x;
      const ny = rotation === 90 ? x : height - 1 - y;
      const from = (y * width + x) * 3;
      const to = (ny * outW + nx) * 3;
      output[to] = data[from];
      output[to + 1] = data[from + 1];
      output[to + 2] = data[from + 2];
    }
  }
  return { width: outW, height: outH, channels: 3, data: output };
}

function workerOptions(image) {
  const { width, height } = image;
  if (mode === "ziva") return { fallbacks: [guideCorners(width, height)], tryRotations: false, hypotheses: 2 };
  return { fallbacks: [guideCorners(width, height), [[0, 0], [width, 0], [width, height], [0, height]]], tryRotations: true, hypotheses: 4 };
}

function cornerError(found, truth) {
  // Rohy mozu byt otocene o 180 stupnov, berieme lepsie z oboch poradi.
  const size = Math.hypot(truth[3][0] - truth[0][0], truth[3][1] - truth[0][1]);
  const error = (order) => Math.max(...order.map((f, i) => Math.hypot(f[0] - truth[i][0], f[1] - truth[i][1]))) / size;
  const rotations = [0, 1, 2, 3].map((r) => found.map((_, i) => found[(i + r) % 4]));
  return Math.min(...rotations.map(error));
}

// Ramcek ako v appke: keby sa obrys nenasiel, skusi sa aj stred obrazka a cely obrazok.
const stats = new Map();
const tier = (name) => {
  if (!stats.has(name)) {
    stats.set(name, { n: 0, detected: 0, goodCorners: 0, top1: 0, top1Same: 0, top5: 0, sure: 0, sureWrong: 0, possible: 0, none: 0, nocard: 0, timeDetect: 0, timeAll: 0, dist: [], wrongDist: [] });
  }
  return stats.get(name);
};
const failures = [];
const allDist = [];
const negatives = [];

for (const row of manifest) {
  const image = loadScene(row.name);
  const t = tier(row.tier);
  t.n += 1;
  let started = performance.now();
  const firstGuess = detectCard(image);
  t.timeDetect += performance.now() - started;
  started = performance.now();
  const result = recognizeCard(image, index, workerOptions(image));
  t.timeAll += performance.now() - started;
  const detection = result.detection ?? firstGuess;
  if (detection) t.detected += 1;
  if (result.status === "nocard") t.nocard += 1;
  else t[result.status] += 1;
  if (row.id === null) {
    if (result.status !== "nocard") negatives.push({ name: row.name, status: result.status, distance: result.distance });
    continue;
  }
  if (detection && !rotation && cornerError(detection.corners, row.corners) < 0.04) t.goodCorners += 1;
  const truth = byId.get(row.id);
  const candidates = result.candidates ?? [];
  const top = candidates[0] ? byId.get(candidates[0].id) : null;
  const exact = top?.id === row.id;
  const same = top && top.g === truth.g;
  if (exact) t.top1 += 1;
  if (exact || same) t.top1Same += 1;
  if (candidates.slice(0, 5).some((c) => byId.get(c.id).g === truth.g)) t.top5 += 1;
  if (result.status === "sure" && !same) t.sureWrong += 1;
  if (result.distance !== undefined) {
    (same ? t.dist : t.wrongDist).push(result.distance);
    allDist.push({ tier: row.tier, distance: result.distance, margin: result.margin, ok: Boolean(same) });
  }
  if (!same) failures.push(`${row.name} ${row.id} -> ${top?.id ?? "-"} (${result.status}, d=${result.distance?.toFixed(3)}, rohy ${detection && !rotation ? cornerError(detection.corners, row.corners).toFixed(3) : "-"})`);
}

const pct = (a, b) => `${((a / Math.max(1, b)) * 100).toFixed(1)} %`;
for (const [name, t] of stats) {
  if (name === "prazdne") continue;
  console.log(
    `${name.padEnd(8)} n=${t.n} našlo kartu ${pct(t.detected, t.n)}, presné rohy ${pct(t.goodCorners, t.n)} | ` +
      `1. miesto ${pct(t.top1, t.n)}, rovnaká karta ${pct(t.top1Same, t.n)}, do 5. miesta ${pct(t.top5, t.n)} | ` +
      `isté ${t.sure}, z toho zle ${t.sureWrong}, možné ${t.possible}, žiadne ${t.none}, bez karty ${t.nocard} | ` +
      `detekcia ${(t.timeDetect / t.n).toFixed(0)} ms, spolu ${(t.timeAll / t.n).toFixed(0)} ms`,
  );
}
const negative = stats.get("prazdne");
if (negative) console.log(`prázdne  n=${negative.n}: bez karty ${negative.nocard}, žiadne ${negative.none}, možné ${negative.possible}, isté ${negative.sure}`, negatives.slice(0, 6));

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(3) : "-";
};
const right = allDist.filter((r) => r.ok).map((r) => r.distance);
const wrong = allDist.filter((r) => !r.ok).map((r) => r.distance);
console.log(`vzdialenosť správne: medián ${quantile(right, 0.5)}, 90 % ${quantile(right, 0.9)}, 99 % ${quantile(right, 0.99)}; zle: min ${quantile(wrong, 0)}, medián ${quantile(wrong, 0.5)}, n=${wrong.length}`);
console.log("zlyhania:");
failures.slice(0, 25).forEach((line) => console.log(" ", line));
