// Shows the pairing seed the two ways the Deck accepts it: 13 numbered words and a QR code that
// carries only `vyre-pc:<seed>`. Never logged, never in a link, and cleared when pairing ends.
import { webCrypto } from "./relay/webcrypto.js";
import { seedToWords, seedQrText } from "./relay/seedwords.js";
import { fromBase64url } from "./relay/bytes.js";
import { qrcode } from "./vendor/qrcode.js";

const SVG = "http://www.w3.org/2000/svg";

function qrSvg(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), quiet = 2, size = n + quiet * 2;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Pairing code");
  const bg = document.createElementNS(SVG, "rect");
  bg.setAttribute("width", size); bg.setAttribute("height", size); bg.setAttribute("fill", "#fff");
  svg.append(bg);
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#000");
  svg.append(path);
  return svg;
}

/** Fill `root` with the words grid, the QR and a Copy button for a base64url seed. Returns a clear(). */
export async function showSeed(root, seedB64u) {
  const seed = fromBase64url(seedB64u);
  const words = await seedToWords(seed, webCrypto());
  root.replaceChildren();
  const grid = document.createElement("ol");
  grid.className = "words";
  for (const w of words) { const li = document.createElement("li"); li.textContent = w; grid.append(li); }
  const qr = document.createElement("div");
  qr.className = "qr";
  qr.append(qrSvg(seedQrText(seed)));
  const copy = document.createElement("button");
  copy.textContent = "Copy the words";
  // For a Deck open on this same PC: paste them there. Nothing reads the clipboard back (that would
  // raise a permission prompt), so the words stay there; the code itself dies in 5 minutes.
  copy.addEventListener("click", () => navigator.clipboard.writeText(words.join(" ")).then(() => { copy.textContent = "Copied"; }, () => {}));
  root.append(qr, grid, copy);
  return function clear() { root.replaceChildren(); };
}
