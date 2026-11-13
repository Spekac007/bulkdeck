// Okno skenera: ziva kamera, odfotenie a nahratie fotiek. Karty idu do zbierky az po potvrdeni.
import { h, imageUrl, thumb } from "./dom.js";
import { guideCorners } from "./scan.js";
import { isLegal, setCode } from "./engine.js";

const LIVE_INTERVAL = 220;
const LIVE_MAX_SIDE = 720;
const PHOTO_MAX_SIDE = 1400;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
// Kolko snimok po sebe musi ukazovat tu istu kartu, kym ju zivy rezim prida.
const STREAK_SURE = 2;
const STREAK_POSSIBLE = 5;

function cameraProblem(error) {
  if (!window.isSecureContext) return "Živá kamera ide iba cez HTTPS. Použi Odfotiť alebo Nahrať fotky.";
  if (error?.name === "NotAllowedError") return "Prístup ku kamere je zamietnutý. Povoľ ho v prehliadači alebo použi Odfotiť.";
  if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") return "Kameru som nenašiel. Použi Odfotiť alebo Nahrať fotky.";
  if (error?.name === "NotReadableError") return "Kameru práve používa iná aplikácia.";
  return "Kamera sa nespustila. Použi Odfotiť alebo Nahrať fotky.";
}

export function createScanner({ getDb, getFormat, legalityTag, money, onAdd }) {
  const dialog = h("dialog", { class: "scanner", "aria-label": "Skenovanie kariet" });
  document.body.append(dialog);

  let worker = null;
  let workerReady = null;
  let requestId = 0;
  const pending = new Map();

  let items = [];
  let unknown = [];
  let stream = null;
  let running = false;
  let timer = null;
  let busy = false;
  let lockGroup = null;
  let streak = { group: null, count: 0 };
  let emptyFrames = 0;
  let cameraMessage = "";
  let processing = 0;
  let view = null;

  function startWorker() {
    if (worker) return workerReady;
    worker = new Worker(new URL("./scan-worker.js", import.meta.url), { type: "module" });
    workerReady = new Promise((resolve, reject) => {
      worker.addEventListener("message", ({ data }) => {
        if (data.type === "ready") resolve(data.cards);
        else if (data.type === "error") reject(new Error(data.message));
        else if (data.type === "result") {
          pending.get(data.id)?.(data);
          pending.delete(data.id);
        }
      });
      worker.addEventListener("error", () => reject(new Error("Skener sa nepodarilo spustiť.")));
    });
    return workerReady;
  }

  function recognize(imageData, live) {
    const id = (requestId += 1);
    const buffer = imageData.data.buffer;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ type: "recognize", id, width: imageData.width, height: imageData.height, buffer, live }, [buffer]);
    });
  }

  function grab(source, sourceWidth, sourceHeight, maxSide) {
    const factor = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * factor));
    const height = Math.max(1, Math.round(sourceHeight * factor));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  /* ---------- Vysledky ---------- */

  function cardsFromResult(result) {
    const db = getDb();
    return result.candidates.map((match) => db.byId.get(match.id)).filter(Boolean);
  }

  // Rovnaky obrazok vo viacerych vytlackoch: na legalite moze zalezat, ktory hrac drzi v ruke.
  function printChoices(result) {
    const db = getDb();
    const format = getFormat();
    const prints = result.sameArt.map((id) => db.byId.get(id)).filter(Boolean);
    if (prints.length < 2) return [];
    const legalityDiffers = new Set(prints.map((card) => isLegal(card, format))).size > 1;
    const groupsDiffer = new Set(prints.map((card) => card.g)).size > 1;
    return legalityDiffers || groupsDiffer ? prints : [];
  }

  function addResult(result, { confirmed, photoUrl = null }) {
    const options = cardsFromResult(result);
    const card = options[0];
    if (!card) return null;
    const choices = printChoices(result);
    const needsPrint = choices.length > 0;
    const isConfirmed = confirmed && !needsPrint;
    const existing = items.find((item) => item.card.id === card.id && item.confirmed === isConfirmed);
    if (existing) {
      existing.qty += 1;
      render();
      return existing;
    }
    const item = {
      key: `i${requestId}-${items.length}`,
      card,
      qty: 1,
      confirmed: isConfirmed,
      reason: needsPrint ? "print" : confirmed ? null : "unsure",
      options: needsPrint ? choices : options.slice(0, 6),
      expanded: !isConfirmed,
      photoUrl,
    };
    items.unshift(item);
    render();
    return item;
  }

  function confirmedCount() {
    return items.filter((item) => item.confirmed).reduce((sum, item) => sum + item.qty, 0);
  }

  function setStatus(message, tone = "") {
    if (!view) return;
    view.status.textContent = message;
    view.status.dataset.tone = tone;
  }

  function drawOutline(corners, tone, width, height) {
    if (!view) return;
    view.overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
    view.guide.setAttribute("points", guideCorners(width, height).map((point) => point.join(",")).join(" "));
    view.outline.setAttribute("points", corners ? corners.map((point) => point.join(",")).join(" ") : "");
    view.outline.dataset.tone = tone;
  }

  /* ---------- Ziva kamera ---------- */

  function handleLive(result, width, height) {
    const cards = cardsFromResult(result);
    const card = cards[0];
    const found = result.status === "sure" || result.status === "possible";
    drawOutline(found ? result.corners : null, result.status, width, height);

    if (!found || !card) {
      emptyFrames += 1;
      streak = { group: null, count: 0 };
      if (emptyFrames >= 3) {
        lockGroup = null;
        setStatus("Daj kartu do rámika");
      }
      return;
    }
    emptyFrames = 0;
    if (lockGroup === card.g) {
      setStatus(`Pridané: ${card.n}. Daj ďalšiu kartu.`, "ok");
      return;
    }
    streak = streak.group === card.g ? { group: card.g, count: streak.count + 1 } : { group: card.g, count: 1 };
    const needed = result.status === "sure" ? STREAK_SURE : STREAK_POSSIBLE;
    setStatus(result.status === "sure" ? `Spoznávam: ${card.n}` : `Možno: ${card.n}`, "");
    if (streak.count < needed) return;

    lockGroup = card.g;
    streak = { group: null, count: 0 };
    addResult(result, { confirmed: result.status === "sure" });
    navigator.vibrate?.(60);
    view?.camera.classList.remove("flash");
    void view?.camera.offsetWidth;
    view?.camera.classList.add("flash");
    setStatus(`Pridané: ${card.n}. Daj ďalšiu kartu.`, "ok");
  }

  async function liveTick() {
    if (!running || !view) return;
    const { video } = view;
    if (!busy && video.readyState >= 2 && video.videoWidth > 0 && !document.hidden) {
      busy = true;
      try {
        const frame = grab(video, video.videoWidth, video.videoHeight, LIVE_MAX_SIDE);
        const result = await recognize(frame, true);
        if (running && result.status !== "error") handleLive(result, frame.width, frame.height);
      } finally {
        busy = false;
      }
    }
    if (running) timer = setTimeout(liveTick, LIVE_INTERVAL);
  }

  async function startCamera() {
    cameraMessage = "";
    if (!navigator.mediaDevices?.getUserMedia) {
      showCameraProblem(cameraProblem());
      return;
    }
    setStatus("Spúšťam kameru…");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (error) {
      showCameraProblem(cameraProblem(error));
      return;
    }
    if (!dialog.open) {
      stopCamera();
      return;
    }
    render();
    view.video.srcObject = stream;
    await view.video.play().catch(() => {});
    setStatus("Daj kartu do rámika");
    running = true;
    liveTick();
  }

  function showCameraProblem(message) {
    cameraMessage = message;
    if (view) view.status.textContent = "";
    render();
  }

  function stopCamera() {
    running = false;
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (view?.video) view.video.srcObject = null;
  }

  /* ---------- Fotky ---------- */

  async function decodeFile(file) {
    if (file.size > MAX_FILE_BYTES) throw new Error("Súbor je príliš veľký.");
    if (file.type && !file.type.startsWith("image/")) throw new Error("Súbor nie je obrázok.");
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error("Obrázok sa nedá otvoriť.");
    }
    const frame = grab(bitmap, bitmap.width, bitmap.height, PHOTO_MAX_SIDE);
    bitmap.close?.();
    return frame;
  }

  async function processFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    processing += files.length;
    render();
    try {
      await startWorker();
    } catch (error) {
      processing = 0;
      cameraMessage = error.message;
      render();
      return;
    }
    for (const file of files) {
      const photoUrl = URL.createObjectURL(file);
      let outcome = null;
      try {
        const frame = await decodeFile(file);
        outcome = await recognize(frame, false);
      } catch (error) {
        outcome = { status: "error", message: error.message };
      }
      processing -= 1;
      if (outcome.status === "sure") {
        addResult(outcome, { confirmed: true, photoUrl });
      } else if (outcome.status === "possible") {
        addResult(outcome, { confirmed: false, photoUrl });
      } else {
        unknown.unshift({ key: `u${requestId}-${unknown.length}`, name: file.name, photoUrl, message: outcome.status === "error" ? outcome.message : null });
      }
      render();
    }
  }

  /* ---------- Vykreslenie ---------- */

  function pickOption(item, option) {
    item.card = option;
    item.confirmed = true;
    item.expanded = false;
    item.reason = null;
    // Rovnaka karta uz moze byt v zozname, vtedy sa spoja.
    const twin = items.find((other) => other !== item && other.card.id === option.id && other.confirmed);
    if (twin) {
      twin.qty += item.qty;
      items = items.filter((other) => other !== item);
    }
    render();
  }

  function itemRow(item) {
    const format = getFormat();
    const db = getDb();
    const printLabel = `${setCode(db, item.card)} ${item.card.l}`;
    const note = item.reason === "print"
      ? "Rovnaký obrázok má viac výtlačkov. Vyber ten svoj."
      : item.reason === "unsure"
        ? "Neistá zhoda. Je to táto karta?"
        : null;
    return h(
      "li",
      { class: `scan-item${item.confirmed ? "" : " unsure"}` },
      h(
        "div",
        { class: "scan-row" },
        thumb(item.card),
        h(
          "div",
          { class: "text" },
          h("div", { class: "row-name" }, item.card.n),
          h(
            "div",
            { class: "row-sub" },
            printLabel,
            !isLegal(item.card, format) ? [" · ", h("span", { class: "tag-out" }, legalityTag(item.card))] : null,
            typeof item.card.p === "number" ? ` · ${money(item.card.p)}` : "",
          ),
        ),
        h(
          "div",
          { class: "stepper" },
          h("button", {
            type: "button",
            "aria-label": `Ubrať ${item.card.n}`,
            "data-focus": `-${item.key}`,
            onclick: () => {
              item.qty -= 1;
              if (item.qty <= 0) items = items.filter((other) => other !== item);
              render();
            },
          }, "−"),
          h("output", null, item.qty),
          h("button", {
            type: "button",
            "aria-label": `Pridať ${item.card.n}`,
            "data-focus": `+${item.key}`,
            onclick: () => {
              item.qty += 1;
              render();
            },
          }, "+"),
        ),
      ),
      note ? h("p", { class: "scan-note" }, note) : null,
      !item.confirmed && item.reason === "unsure"
        ? h(
            "div",
            { class: "actions compact" },
            h("button", { class: "btn primary", type: "button", onclick: () => pickOption(item, item.card) }, "Áno, je to táto"),
            h("button", { class: "btn", type: "button", onclick: () => { items = items.filter((other) => other !== item); render(); } }, "Zahodiť"),
          )
        : null,
      item.expanded
        ? h(
            "div",
            { class: "scan-options" },
            item.options.map((option) =>
              h(
                "button",
                {
                  class: `scan-option${option.id === item.card.id ? " current" : ""}`,
                  type: "button",
                  "aria-label": `${option.n}, ${setCode(db, option)} ${option.l}`,
                  onclick: () => pickOption(item, option),
                },
                imageUrl(option) ? h("img", { src: imageUrl(option), alt: "", loading: "lazy", width: 245, height: 337 }) : h("span", { class: "noimg" }, option.n),
                h("span", { class: "scan-option-label" }, `${setCode(db, option)} ${option.l}`),
              ),
            ),
          )
        : item.options.length > 1
          ? h("button", { class: "link scan-other", type: "button", onclick: () => { item.expanded = true; render(); } }, "Je to iná karta")
          : null,
    );
  }

  function render() {
    if (!dialog.open) return;
    const previousVideo = view?.video;
    const statusText = view?.status.textContent ?? "";
    const statusTone = view?.status.dataset.tone ?? "";
    const listScroll = dialog.querySelector(".scan-list")?.scrollTop ?? 0;
    const focused = document.activeElement?.dataset?.focus;

    const video = previousVideo ?? h("video", { playsinline: true, muted: true, autoplay: true, "aria-label": "Obraz z kamery" });
    video.muted = true;
    const guide = view?.guide ?? document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    guide.setAttribute("class", "scan-guide");
    const outline = view?.outline ?? document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    outline.setAttribute("class", "scan-outline");
    let overlay = view?.overlay;
    if (!overlay) {
      overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      overlay.setAttribute("class", "scan-overlay");
      overlay.setAttribute("aria-hidden", "true");
      overlay.setAttribute("preserveAspectRatio", "xMidYMid meet");
      overlay.setAttribute("viewBox", "0 0 720 960");
      guide.setAttribute("points", guideCorners(720, 960).map((point) => point.join(",")).join(" "));
      overlay.append(guide, outline);
    }

    const status = h("div", { class: "scan-status", role: "status", "aria-live": "polite", "data-tone": statusTone }, statusText);
    const camera = view?.camera ?? h("div", { class: "scan-camera" });
    if (camera.firstChild !== video) camera.replaceChildren(video, overlay);
    camera.classList.toggle("off", !stream);
    camera.hidden = Boolean(cameraMessage);

    const count = confirmedCount();
    const waiting = items.filter((item) => !item.confirmed).length;

    const photoInput = h("input", {
      type: "file",
      accept: "image/*",
      capture: "environment",
      class: "visually-hidden",
      id: "scan-photo",
      onchange: (event) => {
        processFiles(event.target.files);
        event.target.value = "";
      },
    });
    const filesInput = h("input", {
      type: "file",
      accept: "image/*",
      multiple: true,
      class: "visually-hidden",
      id: "scan-files",
      onchange: (event) => {
        processFiles(event.target.files);
        event.target.value = "";
      },
    });

    dialog.replaceChildren(
      h(
        "div",
        { class: "scan-head" },
        h("h2", null, "Skenovanie kariet"),
        h("button", { class: "btn", type: "button", "data-focus": "close", onclick: () => dialog.close() }, "Zavrieť"),
      ),
      h(
        "div",
        { class: "scan-body" },
        h(
          "section",
          { class: "scan-capture", "aria-label": "Snímanie" },
          camera,
          status,
          cameraMessage ? h("p", { class: "scan-message" }, cameraMessage) : null,
          h(
            "div",
            { class: "actions compact" },
            photoInput,
            h("label", { class: "btn", for: "scan-photo" }, "Odfotiť"),
            filesInput,
            h("label", { class: "btn", for: "scan-files" }, "Nahrať fotky"),
          ),
          h("p", { class: "hint" }, "Karty hľadá podľa obrázka, takže funguje aj na iných jazykoch. Fotky zostávajú v tvojom zariadení."),
        ),
        h(
          "section",
          { class: "scan-results", "aria-label": "Naskenované karty" },
          h(
            "div",
            { class: "head-row" },
            h("h3", null, "Naskenované"),
            processing > 0 ? h("span", { class: "count" }, `Spracúvam ${processing}…`) : null,
          ),
          items.length || unknown.length
            ? h(
                "ul",
                { class: "scan-list" },
                items.map(itemRow),
                unknown.map((photo) =>
                  h(
                    "li",
                    { class: "scan-item unsure" },
                    h(
                      "div",
                      { class: "scan-row" },
                      h("img", { class: "thumb", src: photo.photoUrl, alt: "" }),
                      h(
                        "div",
                        { class: "text" },
                        h("div", { class: "row-name" }, "Nespoznal som"),
                        h("div", { class: "row-sub" }, `${photo.name}: ${photo.message ?? "skús lepšie svetlo a menej odleskov, alebo kartu zadaj ručne."}`),
                      ),
                      h("button", { class: "btn", type: "button", onclick: () => { unknown = unknown.filter((other) => other !== photo); render(); } }, "Zahodiť"),
                    ),
                  ),
                ),
              )
            : h("div", { class: "empty" }, h("strong", null, "Zatiaľ nič"), "Karty sa tu ukážu hneď po rozpoznaní."),
          h(
            "div",
            { class: "scan-footer" },
            waiting ? h("p", { class: "hint" }, waiting === 1 ? "1 karta čaká na potvrdenie." : `Na potvrdenie čakajú karty: ${waiting}.`) : null,
            h(
              "button",
              {
                class: "btn primary scan-commit",
                type: "button",
                disabled: count === 0,
                onclick: () => {
                  const confirmed = items.filter((item) => item.confirmed);
                  onAdd(confirmed.map((item) => ({ card: item.card, qty: item.qty })));
                  items = items.filter((item) => !item.confirmed);
                  if (!items.length && !unknown.length) dialog.close();
                  else render();
                },
              },
              count ? `Pridať do zbierky (${count})` : "Pridať do zbierky",
            ),
          ),
        ),
      ),
    );

    view = { video, overlay, guide, outline, camera, status };
    const list = dialog.querySelector(".scan-list");
    if (list) list.scrollTop = listScroll;
    if (focused) dialog.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  }

  dialog.addEventListener("close", () => {
    stopCamera();
    for (const item of items) if (item.photoUrl) URL.revokeObjectURL(item.photoUrl);
    for (const photo of unknown) URL.revokeObjectURL(photo.photoUrl);
    items = [];
    unknown = [];
    view = null;
    lockGroup = null;
    streak = { group: null, count: 0 };
    processing = 0;
    cameraMessage = "";
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && running) liveTick();
  });

  return {
    async open() {
      if (dialog.open) return;
      dialog.showModal();
      render();
      setStatus("Načítavam odtlačky kariet…");
      try {
        await startWorker();
      } catch (error) {
        cameraMessage = error.message;
        render();
        return;
      }
      if (dialog.open) startCamera();
    },
  };
}
