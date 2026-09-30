// @ts-check
// "Add a Windows PC": the person's Deck takes the pairing code the Windows app shows (13 words or a QR
// code, relay/client/seedwords.js is the one shared encoding) and has the box register it as a Wink
// ticket (relay.pair.ticket { seed }). The app already holds the seed, so nothing has to travel back:
// it resolves the ticket at the relay by itself. Minted only on the person's own tap, with the
// presence prompt the tool always has, and the seed lives only in this function's variables: never a
// URL, storage, a log or an event.
import { h, put } from "./dom.js";
import { webCrypto } from "../../relay/client/webcrypto.js";
import { parseSeedText } from "../../relay/client/seedwords.js";
import { base64url } from "../../relay/client/bytes.js";

const crypto = webCrypto();

/** What the person is told for each way the code can be wrong or the box can refuse. @param {any} e */
export function seedProblem(e) {
  switch (e && e.code) {
    case "word_count": return "That is not 13 words. Read them all off the Windows app.";
    case "unknown_word": return `"${e.word}" is not one of the words. Check it against the Windows app.`;
    case "bad_checksum": return "One of the words is mistyped, or two are swapped. Check them against the Windows app.";
    case "bad_seed": return "That is not a Vyre pairing code.";
    case "conflict": return "That code is already waiting at the relay. Start again on the Windows PC.";
    case "unavailable": return "The relay did not answer. Try again in a moment.";
    default: return (e && e.message) || "Could not add the computer.";
  }
}

/**
 * The whole action, without any DOM: parse what was typed or scanned, and have the box register it.
 * Resolves { ok: true, expiresAt } or { ok: false, message }.
 * @param {string} text
 * @param {(name: string, input?: any, opts?: any) => Promise<{ data?: any, error?: any }>} attempt
 */
export async function addPc(text, attempt) {
  let seed;
  try { seed = await parseSeedText(text, crypto); } catch (e) { return { ok: false, message: seedProblem(e) }; }
  const r = await attempt("relay.pair.ticket", { seed: base64url(seed) }, { presence: "asked" });
  if (r.error) return { ok: false, message: seedProblem(r.error) };
  return { ok: true, expiresAt: Number(r.data && r.data.expiresAt) || 0 };
}

/**
 * @param {{ attempt: (name: string, input?: any, opts?: any) => Promise<{ data?: any, error?: any }>, cleanup: (fn: () => void) => void, alive?: () => boolean }} deps
 */
export function buildAddPcCard({ attempt, cleanup, alive = () => true }) {
  const words = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "input", rows: "3", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
    "aria-label": "The 13 words the Windows app shows", placeholder: "the 13 words" }));
  const status = h("p", { class: "small muted", role: "status", "aria-live": "polite" });
  const add = h("button", { class: "btn btn-primary", type: "button" }, "Add this PC");
  const scan = h("button", { class: "btn", type: "button" }, "Scan its QR code");
  const video = /** @type {HTMLVideoElement} */ (h("video", { class: "add-pc-video", muted: "", playsinline: "", hidden: "" }));
  let stream = /** @type {MediaStream | null} */ (null), timer = /** @type {any} */ (null);
  const stopScan = () => { if (timer) clearInterval(timer); timer = null; if (stream) for (const t of stream.getTracks()) t.stop(); stream = null; video.hidden = true; };
  cleanup(stopScan);
  cleanup(() => { words.value = ""; });

  const run = async (/** @type {string} */ text) => {
    add.disabled = true;
    put(status, "Waiting for your approval…");
    const r = await addPc(text, attempt);
    if (!alive()) return;
    add.disabled = false;
    if (r.ok) { words.value = ""; put(status, "Ready. Your PC finishes on its own in a moment; the code works for five minutes."); }
    else put(status, r.message);
  };
  add.addEventListener("click", () => run(words.value));

  // A QR code is read with the browser's own detector where there is one; otherwise the words are the way.
  const Detector = /** @type {any} */ (globalThis).BarcodeDetector;
  if (!Detector || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) scan.hidden = true;
  scan.addEventListener("click", async () => {
    try {
      const det = new Detector({ formats: ["qr_code"] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      video.srcObject = stream; video.hidden = false; await video.play().catch(() => {});
      timer = setInterval(async () => {
        const found = await det.detect(video).catch(() => []);
        const text = found[0] && found[0].rawValue;
        if (text && String(text).startsWith("vyre-pc:")) { stopScan(); run(String(text)); }
      }, 400);
    } catch { stopScan(); put(status, "The camera is not available. Type the words instead."); }
  });

  return h("div", { class: "add-pc" },
    h("p", { class: "h3" }, "Add a Windows PC"),
    h("p", { class: "small muted" }, "Open Vyre on the PC. It shows 13 words and a QR code. Type the words here, or scan the code."),
    h("div", { class: "field" }, words), video, h("div", { class: "phone-code-actions" }, add, scan), status);
}
