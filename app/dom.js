// Spolocne pomocne funkcie pre rozhranie.

const IMAGE_BASE = "https://assets.tcgdex.net/en/";

// Vsetok text ide cez DOM, takze data z API ani vstup hraca sa nikdy nevykonaju ako HTML.
export function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") element.className = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value" || key === "checked" || key === "disabled" || key === "open") element[key] = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child.nodeType ? child : String(child));
  }
  return element;
}

export function imageUrl(card, size = "low") {
  return card.im ? `${IMAGE_BASE}${card.im}/${size}.webp` : null;
}

export function thumb(card) {
  const url = imageUrl(card);
  return url
    ? h("img", { class: "thumb", src: url, alt: "", loading: "lazy", width: 40, height: 55 })
    : h("span", { class: "thumb" });
}
