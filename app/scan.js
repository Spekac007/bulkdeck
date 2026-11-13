// Rozpoznanie karty z obrazka bez DOM, aby sa dalo testovat v Node.
// Postup: najst stvoruholnik karty, vyrovnat ho, spocitat odtlacok obrazka na karte
// a najst najblizsi odtlacok v databaze. Vsetko bezi v zariadeni, fotka nikam neodchadza.
//
// Odtlacok berie iba ilustraciu, takze funguje aj na kartach v inych jazykoch.
// Rovnake vypocty robi tools/build_scan_index.py, zmeny treba robit v oboch.

export const CARD_WIDTH = 245;
export const CARD_HEIGHT = 337;
const CARD_RATIO = 88 / 63;

export const HASH_CONFIG = {
  size: 32,
  bits: 256,
  skip: 2,
  art: { x0: 0.09, x1: 0.91, y0: 0.11, y1: 0.5 },
};

// Male posuny a mierky vyrovnavaju nepresne najdene rohy karty.
const CROP_VARIANTS = [];
for (const scale of [0.96, 1, 1.04]) {
  for (const dx of [-0.02, 0, 0.02]) {
    for (const dy of [-0.02, 0, 0.02]) CROP_VARIANTS.push({ dx, dy, scale });
  }
}

/* ---------- Praca s obrazkom ---------- */

/** Obrazok: { width, height, channels, data }, kanaly su RGB alebo RGBA. */
export function toGray(image, maxSide = Infinity) {
  const { width, height, data } = image;
  const channels = image.channels ?? 4;
  const factor = Math.max(1, Math.max(width, height) / maxSide);
  const outW = Math.max(1, Math.round(width / factor));
  const outH = Math.max(1, Math.round(height / factor));
  const gray = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outW));
      let sum = 0;
      for (let sy = y0; sy < y1; sy++) {
        let offset = (sy * width + x0) * channels;
        for (let sx = x0; sx < x1; sx++) {
          sum += 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
          offset += channels;
        }
      }
      gray[y * outW + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return { width: outW, height: outH, data: gray, scale: outW / width };
}

/** Zmenseny obrazok po kanaloch. Hrany hladame vo farbe: zlty okraj na svetlom stole ma takmer rovnaky jas. */
function toChannels(image, maxSide) {
  const { width, height, data } = image;
  const channels = image.channels ?? 4;
  const factor = Math.max(1, Math.max(width, height) / maxSide);
  const outW = Math.max(1, Math.round(width / factor));
  const outH = Math.max(1, Math.round(height / factor));
  const planes = [new Float32Array(outW * outH), new Float32Array(outW * outH), new Float32Array(outW * outH)];
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy++) {
        let offset = (sy * width + x0) * channels;
        for (let sx = x0; sx < x1; sx++) {
          r += data[offset];
          g += data[offset + 1];
          b += data[offset + 2];
          offset += channels;
        }
      }
      const area = (y1 - y0) * (x1 - x0);
      const i = y * outW + x;
      planes[0][i] = r / area;
      planes[1][i] = g / area;
      planes[2][i] = b / area;
    }
  }
  return { width: outW, height: outH, scale: outW / width, planes };
}

function blur(gray) {
  const { width, height, data } = gray;
  const horizontal = new Float32Array(data.length);
  const output = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = data[row + Math.max(0, x - 1)];
      const right = data[row + Math.min(width - 1, x + 1)];
      horizontal[row + x] = (left + 2 * data[row + x] + right) / 4;
    }
  }
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const down = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      output[row + x] = (horizontal[up + x] + 2 * horizontal[row + x] + horizontal[down + x]) / 4;
    }
  }
  return { width, height, data: output, scale: gray.scale };
}

function sobelEdges({ width, height, planes }) {
  const size = width * height;
  const magnitude = new Float32Array(size);
  const angle = new Float32Array(size);
  const histogram = new Uint32Array(512);
  for (const data of planes) {
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const gx = data[i - width + 1] + 2 * data[i + 1] + data[i + width + 1] - data[i - width - 1] - 2 * data[i - 1] - data[i + width - 1];
        const gy = data[i + width - 1] + 2 * data[i + width] + data[i + width + 1] - data[i - width - 1] - 2 * data[i - width] - data[i - width + 1];
        const value = gx * gx + gy * gy;
        // Z kazdeho pixela berieme kanal s najsilnejsou hranou.
        if (value > magnitude[i]) {
          magnitude[i] = value;
          let direction = Math.atan2(gy, gx);
          if (direction < 0) direction += Math.PI;
          if (direction >= Math.PI) direction -= Math.PI;
          angle[i] = direction;
        }
      }
    }
  }
  for (let i = 0; i < size; i++) {
    magnitude[i] = Math.sqrt(magnitude[i]);
    histogram[Math.min(511, Math.floor(magnitude[i] / 2))] += 1;
  }
  // Prah: najsilnejsich 15 % pixelov, ale aspon viditelna hrana.
  let remaining = Math.floor(size * 0.15);
  let threshold = 511;
  while (threshold > 0 && remaining > 0) {
    remaining -= histogram[threshold];
    threshold -= 1;
  }
  return { magnitude, angle, threshold: Math.max(24, threshold * 2) };
}

/* ---------- Najdenie karty ---------- */

const THETA_BINS = 180;
const THETA_COS = Float32Array.from({ length: THETA_BINS }, (_, i) => Math.cos((i * Math.PI) / THETA_BINS));
const THETA_SIN = Float32Array.from({ length: THETA_BINS }, (_, i) => Math.sin((i * Math.PI) / THETA_BINS));

function houghLines(gray, edges, maxLines) {
  const { width, height } = gray;
  const { magnitude, angle, threshold } = edges;
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoBins = 2 * diagonal + 1;
  const votes = new Float32Array(THETA_BINS * rhoBins);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (magnitude[i] < threshold) continue;
      const center = Math.round((angle[i] / Math.PI) * THETA_BINS);
      for (let offset = -3; offset <= 3; offset++) {
        const theta = (center + offset + THETA_BINS) % THETA_BINS;
        const rho = Math.round(x * THETA_COS[theta] + y * THETA_SIN[theta]) + diagonal;
        votes[theta * rhoBins + rho] += 1;
      }
    }
  }
  const lines = [];
  const minVotes = 0.15 * Math.min(width, height);
  for (let round = 0; round < maxLines; round++) {
    let best = -1;
    let bestVotes = minVotes;
    for (let i = 0; i < votes.length; i++) {
      if (votes[i] > bestVotes) {
        bestVotes = votes[i];
        best = i;
      }
    }
    if (best < 0) break;
    const theta = Math.floor(best / rhoBins);
    const rho = (best % rhoBins) - diagonal;
    lines.push({ theta: (theta * Math.PI) / THETA_BINS, thetaBin: theta, rho, votes: bestVotes });
    // Potlacenie okolia. Pri uhle okolo 0 a 180 stupnov sa priamka zrkadli (rho meni znamienko).
    for (let dt = -7; dt <= 7; dt++) {
      let t = theta + dt;
      let center = rho;
      if (t < 0) {
        t += THETA_BINS;
        center = -rho;
      } else if (t >= THETA_BINS) {
        t -= THETA_BINS;
        center = -rho;
      }
      for (let dr = -9; dr <= 9; dr++) {
        const r = center + dr + diagonal;
        if (r >= 0 && r < rhoBins) votes[t * rhoBins + r] = 0;
      }
    }
  }
  return lines;
}

function intersect(a, b) {
  const cosA = Math.cos(a.theta);
  const sinA = Math.sin(a.theta);
  const cosB = Math.cos(b.theta);
  const sinB = Math.sin(b.theta);
  const determinant = cosA * sinB - sinA * cosB;
  if (Math.abs(determinant) < 1e-6) return null;
  return [(a.rho * sinB - b.rho * sinA) / determinant, (b.rho * cosA - a.rho * cosB) / determinant];
}

function angleBetween(a, b) {
  const diff = Math.abs(a.theta - b.theta);
  return Math.min(diff, Math.PI - diff);
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2;
}

function sideSupport(from, to, gray, edges) {
  const { width, height } = gray;
  const { magnitude, angle, threshold } = edges;
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.max(8, Math.floor(length / 2));
  let normal = Math.atan2(to[0] - from[0], -(to[1] - from[1]));
  if (normal < 0) normal += Math.PI;
  if (normal >= Math.PI) normal -= Math.PI;
  let hits = 0;
  let total = 0;
  // Stredne casti strany: rohy karty su zaoblene.
  for (let step = 1; step < steps; step++) {
    const t = step / steps;
    if (t < 0.06 || t > 0.94) continue;
    total += 1;
    const px = from[0] + (to[0] - from[0]) * t;
    const py = from[1] + (to[1] - from[1]) * t;
    let found = false;
    for (let dy = -2; dy <= 2 && !found; dy++) {
      for (let dx = -2; dx <= 2 && !found; dx++) {
        const x = Math.round(px) + dx;
        const y = Math.round(py) + dy;
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
        const i = y * width + x;
        if (magnitude[i] < threshold * 0.7) continue;
        const diff = Math.abs(angle[i] - normal);
        if (Math.min(diff, Math.PI - diff) < 0.3) found = true;
      }
    }
    if (found) hits += 1;
  }
  return total ? hits / total : 0;
}

/** Zoradi rohy tak, aby dlhsia strana bola zvisla: lavy horny, pravy horny, pravy dolny, lavy dolny. */
function orderCorners(corners) {
  const cx = corners.reduce((sum, p) => sum + p[0], 0) / 4;
  const cy = corners.reduce((sum, p) => sum + p[1], 0) / 4;
  const sorted = [...corners].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // Atan2 ide v obrazovych suradniciach v smere hodinovych ruciciek, zacneme od lavej hornej.
  let start = 0;
  let bestSum = Infinity;
  sorted.forEach((p, i) => {
    if (p[0] + p[1] < bestSum) {
      bestSum = p[0] + p[1];
      start = i;
    }
  });
  const ordered = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
  const top = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
  const left = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
  // Karta lezi nabok: otocime poradie o stvrtinu.
  return top > left ? [ordered[3], ordered[0], ordered[1], ordered[2]] : ordered;
}

/** Spresni stranu: priamka cez hranove pixely v uzkom pase okolo nej (metoda najmensich stvorcov). */
function refineSide(from, to, gray, edges) {
  const { width, height } = gray;
  const { magnitude, angle, threshold } = edges;
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (length < 8) return null;
  const ux = (to[0] - from[0]) / length;
  const uy = (to[1] - from[1]) / length;
  let normal = Math.atan2(ux, -uy);
  if (normal < 0) normal += Math.PI;
  if (normal >= Math.PI) normal -= Math.PI;
  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  const points = [];
  for (let s = length * 0.08; s < length * 0.92; s += 1) {
    const px = from[0] + ux * s;
    const py = from[1] + uy * s;
    let best = 0;
    let bestX = 0;
    let bestY = 0;
    for (let d = -4; d <= 4; d++) {
      const x = Math.round(px - uy * d);
      const y = Math.round(py + ux * d);
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
      const i = y * width + x;
      if (magnitude[i] < threshold * 0.6 || magnitude[i] <= best) continue;
      const diff = Math.abs(angle[i] - normal);
      if (Math.min(diff, Math.PI - diff) > 0.2) continue;
      best = magnitude[i];
      bestX = x;
      bestY = y;
    }
    if (best > 0) {
      points.push([bestX, bestY]);
      weight += 1;
      sumX += bestX;
      sumY += bestY;
    }
  }
  if (weight < 10) return null;
  const meanX = sumX / weight;
  const meanY = sumY / weight;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const [x, y] of points) {
    xx += (x - meanX) ** 2;
    yy += (y - meanY) ** 2;
    xy += (x - meanX) * (y - meanY);
  }
  // Smer priamky je vlastny vektor kovariancie, kolmica na nu je jej normala.
  let theta = 0.5 * Math.atan2(2 * xy, xx - yy) + Math.PI / 2;
  const rho = meanX * Math.cos(theta) + meanY * Math.sin(theta);
  return { theta, rho };
}

function refineQuad(corners, gray, edges) {
  const sides = [0, 1, 2, 3].map((i) => refineSide(corners[i], corners[(i + 1) % 4], gray, edges));
  if (sides.some((side) => !side)) return corners;
  const refined = [intersect(sides[3], sides[0]), intersect(sides[0], sides[1]), intersect(sides[1], sides[2]), intersect(sides[2], sides[3])];
  if (refined.some((point) => !point)) return corners;
  const size = Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]);
  // Spresnenie smie rohy iba doladit. Velky posun znamena, ze sa chytilo inej hrany.
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(refined[i][0] - corners[i][0], refined[i][1] - corners[i][1]) > size * 0.05) return corners;
  }
  return refined;
}

/**
 * Najde mozne stvoruholniky karty a zoradi ich od najpravdepodobnejsieho.
 * Hlada dvojice takmer rovnobeznych priamok a vyberie stvoruholniky s pomerom stran karty,
 * ktorych strany naozaj lezia na hranach. Rozhodne az porovnanie s databazou.
 */
export function detectCandidates(image, { maxSide = 360, maxLines = 24, limit = 4 } = {}) {
  const small = toChannels(image, maxSide);
  const gray = { width: small.width, height: small.height, scale: small.scale };
  const planes = small.planes.map((data) => blur({ ...gray, data }).data);
  const edges = sobelEdges({ ...gray, planes });
  const lines = houghLines(gray, edges, maxLines);
  if (lines.length < 4) return [];

  const { width, height } = gray;
  const imageArea = width * height;
  const minDistance = 0.18 * Math.min(width, height);
  const pairs = [];
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      if (angleBetween(lines[a], lines[b]) > (15 * Math.PI) / 180) continue;
      // Porovnanie vzdialenosti v strede obrazka, rho samotne sa pri uhle okolo 0 a 180 zrkadli.
      const mid = (line) => line.rho - (width / 2) * Math.cos(line.theta) - (height / 2) * Math.sin(line.theta);
      const sameSide = Math.abs(lines[a].theta - lines[b].theta) > Math.PI / 2;
      const distance = sameSide ? Math.abs(mid(lines[a]) + mid(lines[b])) : Math.abs(mid(lines[a]) - mid(lines[b]));
      if (distance < minDistance) continue;
      pairs.push([lines[a], lines[b]]);
    }
  }

  const found = [];
  const margin = 0.1;
  for (let p = 0; p < pairs.length; p++) {
    for (let q = p + 1; q < pairs.length; q++) {
      const [a, b] = pairs[p];
      const [c, d] = pairs[q];
      const cross = angleBetween(a, c);
      if (cross < (62 * Math.PI) / 180) continue;
      const points = [intersect(a, c), intersect(c, b), intersect(b, d), intersect(d, a)];
      if (points.some((point) => !point)) continue;
      if (points.some(([x, y]) => x < -margin * width || y < -margin * height || x > (1 + margin) * width || y > (1 + margin) * height)) continue;
      const area = polygonArea(points);
      if (area < 0.1 * imageArea || area > 1.15 * imageArea) continue;
      const ordered = orderCorners(points);
      const top = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
      const bottom = Math.hypot(ordered[2][0] - ordered[3][0], ordered[2][1] - ordered[3][1]);
      const left = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
      const right = Math.hypot(ordered[2][0] - ordered[1][0], ordered[2][1] - ordered[1][1]);
      const ratio = (left + right) / (top + bottom);
      if (ratio < 1.12 || ratio > 1.75) continue;
      const support = [
        sideSupport(ordered[0], ordered[1], gray, edges),
        sideSupport(ordered[1], ordered[2], gray, edges),
        sideSupport(ordered[2], ordered[3], gray, edges),
        sideSupport(ordered[3], ordered[0], gray, edges),
      ];
      const weakest = Math.min(...support);
      if (weakest < 0.25) continue;
      const average = support.reduce((sum, value) => sum + value, 0) / 4;
      const shape = 1 - Math.min(1, Math.abs(ratio - CARD_RATIO) / 0.6);
      const score = average * average * Math.sqrt(area / imageArea) * (0.5 + 0.5 * shape);
      found.push({ corners: ordered, score, support: average, ratio });
    }
  }
  found.sort((a, b) => b.score - a.score);

  // Takmer rovnake stvoruholniky nema zmysel skusat viackrat.
  const picked = [];
  for (const quad of found) {
    const size = Math.hypot(quad.corners[3][0] - quad.corners[0][0], quad.corners[3][1] - quad.corners[0][1]);
    const duplicate = picked.some((other) =>
      quad.corners.every((point, i) => Math.hypot(point[0] - other.corners[i][0], point[1] - other.corners[i][1]) < size * 0.05),
    );
    if (duplicate) continue;
    picked.push(quad);
    if (picked.length >= limit) break;
  }
  return picked.map((quad) => ({
    ...quad,
    corners: refineQuad(quad.corners, gray, edges).map(([x, y]) => [x / gray.scale, y / gray.scale]),
  }));
}

export function detectCard(image, options) {
  return detectCandidates(image, { ...options, limit: 1 })[0] ?? null;
}

/** Rohy stvoruholnika pre pripad, ze kartu drzi hrac v rameceku na obrazovke. */
export function guideCorners(width, height, fill = 0.82) {
  const cardHeight = Math.min(height * fill, (width * fill * 88) / 63);
  const cardWidth = (cardHeight * 63) / 88;
  const x0 = (width - cardWidth) / 2;
  const y0 = (height - cardHeight) / 2;
  return [
    [x0, y0],
    [x0 + cardWidth, y0],
    [x0 + cardWidth, y0 + cardHeight],
    [x0, y0 + cardHeight],
  ];
}

/* ---------- Vyrovnanie ---------- */

function homography([p0, p1, p2, p3], width, height) {
  // Stvorec (0,0)-(1,1) na stvoruholnik, Heckbert 1989.
  const dx1 = p1[0] - p2[0];
  const dx2 = p3[0] - p2[0];
  const sx = p0[0] - p1[0] + p2[0] - p3[0];
  const dy1 = p1[1] - p2[1];
  const dy2 = p3[1] - p2[1];
  const sy = p0[1] - p1[1] + p2[1] - p3[1];
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / denominator;
  const h = (dx1 * sy - sx * dy1) / denominator;
  const a = p1[0] - p0[0] + g * p1[0];
  const b = p3[0] - p0[0] + h * p3[0];
  const c = p0[0];
  const d = p1[1] - p0[1] + g * p1[1];
  const e = p3[1] - p0[1] + h * p3[1];
  const f = p0[1];
  return { a: a / width, b: b / height, c, d: d / width, e: e / height, f, g: g / width, h: h / height };
}

/** Vyrovna kartu na CARD_WIDTH x CARD_HEIGHT v odtienoch sivej. */
export function warpCard(gray, corners) {
  const scaled = corners.map(([x, y]) => [x * gray.scale, y * gray.scale]);
  const m = homography(scaled, CARD_WIDTH, CARD_HEIGHT);
  const output = new Float32Array(CARD_WIDTH * CARD_HEIGHT);
  const { width, height, data } = gray;
  for (let v = 0; v < CARD_HEIGHT; v++) {
    for (let u = 0; u < CARD_WIDTH; u++) {
      const pu = u + 0.5;
      const pv = v + 0.5;
      const w = m.g * pu + m.h * pv + 1;
      // Suradnice maju okraj obrazka v nule, stred pixela je o polovicu dalej.
      const x = Math.min(width - 1.001, Math.max(0, (m.a * pu + m.b * pv + m.c) / w - 0.5));
      const y = Math.min(height - 1.001, Math.max(0, (m.d * pu + m.e * pv + m.f) / w - 0.5));
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const i = y0 * width + x0;
      output[v * CARD_WIDTH + u] =
        data[i] * (1 - fx) * (1 - fy) +
        data[i + 1] * fx * (1 - fy) +
        data[i + width] * (1 - fx) * fy +
        data[i + width + 1] * fx * fy;
    }
  }
  return output;
}

/* ---------- Odtlacok ---------- */

function buildZigzag({ size, bits, skip }) {
  const pairs = [];
  for (let u = 0; u < size; u++) for (let v = 0; v < size; v++) pairs.push([u, v]);
  pairs.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0]);
  return pairs.slice(1 + skip, 1 + skip + bits);
}

const plans = new Map();
function hashPlan(config) {
  const key = `${config.size}|${config.bits}|${config.skip}`;
  if (plans.has(key)) return plans.get(key);
  const picks = buildZigzag(config);
  const highest = Math.max(...picks.flat()) + 1;
  const basis = [];
  for (let u = 0; u < highest; u++) {
    const row = new Float64Array(config.size);
    for (let x = 0; x < config.size; x++) row[x] = Math.cos((Math.PI * (2 * x + 1) * u) / (2 * config.size));
    basis.push(row);
  }
  const plan = { picks, highest, basis };
  plans.set(key, plan);
  return plan;
}

function integralImage(card) {
  const stride = CARD_WIDTH + 1;
  const integral = new Float64Array(stride * (CARD_HEIGHT + 1));
  for (let y = 0; y < CARD_HEIGHT; y++) {
    let line = 0;
    for (let x = 0; x < CARD_WIDTH; x++) {
      line += card[y * CARD_WIDTH + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + line;
    }
  }
  return integral;
}

const roundHalfUp = (value) => Math.floor(value + 0.5);

/** Odtlacok vyrezu ilustracie. Vrati pole slov Uint32Array, poradie bitov je rovnake ako v databaze. */
export function hashFromIntegral(integral, config, { dx = 0, dy = 0, scale = 1 } = {}) {
  const { size, bits, art } = config;
  const { picks, highest, basis } = hashPlan(config);
  const stride = CARD_WIDTH + 1;
  const centerX = (art.x0 + art.x1) / 2 + dx;
  const centerY = (art.y0 + art.y1) / 2 + dy;
  const halfW = ((art.x1 - art.x0) / 2) * scale;
  const halfH = ((art.y1 - art.y0) / 2) * scale;
  const ax = Math.max(0, roundHalfUp((centerX - halfW) * CARD_WIDTH));
  const bx = Math.min(CARD_WIDTH, roundHalfUp((centerX + halfW) * CARD_WIDTH));
  const ay = Math.max(0, roundHalfUp((centerY - halfH) * CARD_HEIGHT));
  const by = Math.min(CARD_HEIGHT, roundHalfUp((centerY + halfH) * CARD_HEIGHT));
  const cropW = bx - ax;
  const cropH = by - ay;

  const small = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    const y0 = ay + Math.floor((y * cropH) / size);
    const y1 = ay + Math.floor(((y + 1) * cropH) / size);
    for (let x = 0; x < size; x++) {
      const x0 = ax + Math.floor((x * cropW) / size);
      const x1 = ax + Math.floor(((x + 1) * cropW) / size);
      const area = (y1 - y0) * (x1 - x0);
      small[y * size + x] =
        (integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0]) / area;
    }
  }

  // Dvojrozmerna DCT, iba nizke frekvencie, ktore odtlacok pouziva. Prvy index je riadok.
  const partial = new Float64Array(size * highest);
  for (let y = 0; y < size; y++) {
    for (let v = 0; v < highest; v++) {
      let sum = 0;
      const row = basis[v];
      for (let x = 0; x < size; x++) sum += small[y * size + x] * row[x];
      partial[y * highest + v] = sum;
    }
  }
  const values = new Float64Array(bits);
  picks.forEach(([u, v], index) => {
    let sum = 0;
    const row = basis[u];
    for (let y = 0; y < size; y++) sum += partial[y * highest + v] * row[y];
    values[index] = sum;
  });
  const sorted = Float64Array.from(values).sort();
  const median = (sorted[(bits >> 1) - 1] + sorted[bits >> 1]) / 2;

  const bytes = new Uint8Array(bits >> 3);
  for (let i = 0; i < bits; i++) {
    if (values[i] > median) bytes[i >> 3] |= 0x80 >> (i & 7);
  }
  return new Uint32Array(bytes.buffer);
}

export function cardHashes(card, config = HASH_CONFIG, variants = CROP_VARIANTS) {
  const integral = integralImage(card);
  return variants.map((variant) => hashFromIntegral(integral, config, variant));
}

function rotated180(card) {
  const output = new Float32Array(card.length);
  for (let i = 0; i < card.length; i++) output[i] = card[card.length - 1 - i];
  return output;
}

function popcount(value) {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/* ---------- Databaza ---------- */

export class ScanIndex {
  /** meta: { ids, bits, ... } zo scan.json, buffer: obsah scan.bin. */
  constructor(meta, buffer) {
    this.ids = meta.ids;
    this.config = { ...HASH_CONFIG, ...meta.config };
    this.words = this.config.bits >> 5;
    this.table = new Uint32Array(buffer);
    if (this.table.length !== this.ids.length * this.words) {
      throw new Error("scan.bin nesedí k scan.json");
    }
  }

  /** Najblizsie karty k odtlackom. Pre kazdu kartu sa rata najmensia vzdialenost cez vsetky odtlacky. */
  search(queries, limit = 12) {
    const { table, words, ids } = this;
    const count = ids.length;
    const best = new Uint16Array(count).fill(65535);
    for (const query of queries) {
      for (let row = 0, offset = 0; row < count; row++, offset += words) {
        let distance = 0;
        for (let w = 0; w < words; w++) distance += popcount(table[offset + w] ^ query[w]);
        if (distance < best[row]) best[row] = distance;
      }
    }
    const top = [];
    for (let row = 0; row < count; row++) {
      const distance = best[row];
      if (top.length < limit || distance < top[top.length - 1].distance) {
        let position = top.length;
        while (position > 0 && top[position - 1].distance > distance) position -= 1;
        top.splice(position, 0, { row, id: ids[row], distance });
        if (top.length > limit) top.pop();
      }
    }
    return top;
  }

  /** Rozdiel dvoch odtlackov v databaze: maly znamena rovnaky obrazok v inom vytlacku. */
  distanceBetween(rowA, rowB) {
    const { table, words } = this;
    let distance = 0;
    for (let w = 0; w < words; w++) distance += popcount(table[rowA * words + w] ^ table[rowB * words + w]);
    return distance;
  }
}

// Hranice odtlacku z merania na simulovanych fotkach, pozri tools/scan_benchmark.mjs.
export const MATCH_LIMITS = { sure: 0.27, possible: 0.33, margin: 0.04, sameArt: 0.14 };

/**
 * Zhodnoti vysledok hladania.
 * status: "sure" = mozno pridat bez pytania, "possible" = hrac ma potvrdit, "none" = nie je to karta z databazy.
 */
export function assessMatches(index, matches, limits = MATCH_LIMITS) {
  const bits = index.config.bits;
  if (!matches.length) return { status: "none", best: null, candidates: [], distance: 1 };
  const best = matches[0];
  // Rovnaky obrazok v inom vytlacku nie je konkurent, hraca sa to pytame osobitne.
  const sameArt = [];
  const others = [];
  for (const match of matches) {
    if (match === best || index.distanceBetween(best.row, match.row) / bits <= limits.sameArt) sameArt.push(match);
    else others.push(match);
  }
  const distance = best.distance / bits;
  const margin = others.length ? (others[0].distance - best.distance) / bits : 1;
  let status = "none";
  if (distance <= limits.possible) status = "possible";
  if (distance <= limits.sure && margin >= limits.margin) status = "sure";
  return { status, best, sameArt, candidates: matches, distance, margin };
}

/**
 * Cely postup pre jeden obrazok. Skusi niekolko moznych obrysov a necha rozhodnut databazu:
 * spravny obrys ma vyrazne mensiu vzdialenost nez nespravny.
 * fallbacks su dalsie obrysy, ked sa karta nenajde: ramcek na obrazovke alebo cely obrazok.
 */
export function recognizeCard(image, index, { fallbacks = [], tryRotations = true, limit = 12, maxSide = 900, hypotheses = 4 } = {}) {
  const quads = detectCandidates(image, { limit: hypotheses });
  for (const corners of fallbacks) quads.push({ corners, score: 0, fallback: true });
  if (!quads.length) return { status: "nocard", detection: null, candidates: [] };
  const gray = toGray(image, maxSide);
  let best = null;
  for (const detection of quads) {
    const card = warpCard(gray, detection.corners);
    const queries = cardHashes(card, index.config);
    if (tryRotations) queries.push(...cardHashes(rotated180(card), index.config));
    const result = { ...assessMatches(index, index.search(queries, limit)), detection };
    if (!best || result.distance < best.distance) best = result;
    if (result.status === "sure") break;
  }
  // Obrys bez zhody v databaze nie je karta, hracovi by sme ukazovali nezmysly.
  if (best.status === "none") return { ...best, status: "nocard" };
  return best;
}
