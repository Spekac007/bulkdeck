// Rozpoznavanie bezi mimo hlavneho vlakna, aby sa pri skenovani nesekalo rozhranie.
import { ScanIndex, guideCorners, recognizeCard } from "./scan.js";

let index = null;

async function load() {
  const [metaResponse, binResponse] = await Promise.all([fetch("data/scan.json"), fetch("data/scan.bin")]);
  if (!metaResponse.ok || !binResponse.ok) throw new Error("Odtlačky kariet sa nepodarilo načítať.");
  index = new ScanIndex(await metaResponse.json(), await binResponse.arrayBuffer());
}

const ready = load();
ready.then(
  () => postMessage({ type: "ready", cards: index.ids.length }),
  (error) => postMessage({ type: "error", message: String(error.message ?? error) }),
);

self.addEventListener("message", async ({ data }) => {
  if (data.type !== "recognize") return;
  try {
    await ready;
    const { id, width, height, buffer, live } = data;
    const image = { width, height, channels: 4, data: new Uint8ClampedArray(buffer) };
    const started = performance.now();
    // Odfotena karta moze vyplnat cely obrazok, vtedy ziadny obrys nenajdeme.
    const fallbacks = [guideCorners(width, height)];
    if (!live) fallbacks.push([[0, 0], [width, 0], [width, height], [0, height]]);
    const result = recognizeCard(image, index, { fallbacks, tryRotations: !live, hypotheses: live ? 2 : 4 });
    postMessage({
      type: "result",
      id,
      status: result.status,
      distance: result.distance ?? null,
      candidates: (result.candidates ?? []).map(({ id: cardId, distance }) => ({ id: cardId, distance })),
      sameArt: (result.sameArt ?? []).map((match) => match.id),
      corners: result.detection && !result.detection.fallback ? result.detection.corners : null,
      ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    postMessage({ type: "result", id: data.id, status: "error", message: String(error.message ?? error), candidates: [], sameArt: [] });
  }
});
