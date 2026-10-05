// Make src/native/wink-scan-page.generated.js: the page the phone's camera reader loads in a WebView (src/native/WinkScan.tsx).
//
//   node scripts/build-wink-scan.mjs          write it
//   node scripts/build-wink-scan.mjs --check  exit 1 when it differs from what the sources would make (the test runs this)
//
// The decoder is the shared one (lib/wink-code: geometry, Reed-Solomon, payload, decode-core2), the same code web/js/scan.js runs in a browser, so a phone and a
// browser read a drawn Wink code with one decoder. The page opens the back camera (getUserMedia), grabs a square frame every few hundred ms and hands it to a worker
// that runs the rotation, scale and perspective search; a frame that decodes posts the 8-byte ticket to the app. A decode attempt takes 1 to 2 s of JIT time, which is why
// this runs in the system WebView and not in Hermes. The page's backdrop colour is the placeholder __PAGE_BG__, which WinkScan.native.tsx fills from the theme (a literal colour here fails the raw-colours test). Nothing here logs or stores the ticket: it goes to the app once and the page stops.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const OUT = path.resolve(here, "../src/native/wink-scan-page.generated.js");

const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");

/** A module's source as a classic-script IIFE named `name`: its imports are the names already in scope, its `export { ... }` list is what the IIFE returns. */
function inline(name, file) {
  let src = read(file);
  const names = [];
  src = src.replace(/^export\s*\{([^}]*)\};?\s*$/gm, (_, list) => { for (const n of list.split(",")) if (n.trim()) names.push(n.trim()); return ""; });
  src = src.replace(/^import\s+[^;]*;\s*$/gm, "");
  if (/^\s*(import|export)\s/m.test(src)) throw new Error(`${file} has an import or export this build does not handle`);
  return `const ${name} = (function () {\n${src}\nreturn { ${names.join(", ")} };\n})();\n`;
}

/** The worker: the decoder modules and the same message protocol as web/js/scan-worker.js. */
export function workerSource() {
  return [
    inline("geo", "lib/wink-code/geometry.js"),
    inline("rs", "lib/wink-code/rs.js"),
    inline("payload", "lib/wink-code/payload.js"),
    "const { decodeCore2 } = " + inline("decode", "lib/wink-code/decode-core2.js").replace(/^const decode = /, "").replace(/;\n$/, ";\n"),
    `
function levelsToBits(levels) { const bits = []; for (const lv of levels) bits.push((lv >> 1) & 1, lv & 1); return bits; }
/** The 8-byte ticket one candidate's mark levels spell, or null when Reed-Solomon and the checksum refuse it. */
function ticketFromLevels(levels) {
  const r = payload.recoverId(payload.bitsToBytes(levelsToBits(levels)));
  return r ? r.id8 : null;
}
function decodeFrame(data, width, height) {
  const core = decodeCore2();
  const getLum = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (y * width + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  for (const cand of core.searchWithPerspective(getLum, width / 2, height / 2, {})) {
    const t = ticketFromLevels(cand.levels);
    if (t) return t;
  }
  return null;
}
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = (e) => { const { data, width, height } = e.data; self.postMessage({ ticket: decodeFrame(data, width, height) }); };
}
`,
  ].join("\n");
}

const PAGE_SCRIPT = (worker) => `
(function () {
  var ATTEMPT_MS = 350, FRAME = 640, SLOW_MS = 4000;
  var stopped = false, found = false, busy = false, stream = null, timer = null;
  function send(m) { try { window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {} }
  var video = document.getElementById("v");
  var canvas = document.createElement("canvas"); canvas.width = FRAME; canvas.height = FRAME;
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  var worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: "text/javascript" })));
  worker.onerror = function (e) { busy = false; if (!stopped && !found) send({ type: "error", code: "scan_worker", message: e.message || "The scanner failed." }); };
  worker.onmessage = function (e) {
    busy = false;
    if (stopped || found) return;
    if (e.data.ticket) { found = true; send({ type: "ticket", ticket: Array.prototype.slice.call(e.data.ticket) }); stop(); return; }
    schedule();
  };
  function schedule() { if (!stopped && !found) timer = setTimeout(attempt, ATTEMPT_MS); }
  function attempt() {
    if (stopped || found || busy || video.readyState < 2 || !video.videoWidth) return schedule();
    var side = Math.min(video.videoWidth, video.videoHeight);
    ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, FRAME, FRAME);
    var img; try { img = ctx.getImageData(0, 0, FRAME, FRAME); } catch (e) { return schedule(); }
    busy = true;
    worker.postMessage({ data: img.data, width: FRAME, height: FRAME }, [img.data.buffer]);
  }
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    try { worker.terminate(); } catch (e) {}
  }
  window.__winkScanStop = stop;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { send({ type: "error", code: "no_camera", message: "This phone's browser engine cannot use the camera." }); return; }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false }).then(function (s) {
    if (stopped) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
    stream = s; video.srcObject = s; video.muted = true; video.setAttribute("playsinline", ""); video.play().catch(function () {});
    send({ type: "ready" });
    setTimeout(function () { if (!stopped && !found) send({ type: "slow" }); }, SLOW_MS);
    schedule();
  }).catch(function (err) { send({ type: "error", code: (err && err.name === "NotAllowedError") ? "denied" : "no_camera", message: (err && err.message) || "The camera did not open." }); });
})();
`;

export function page() {
  const worker = workerSource();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body{margin:0;height:100%;background:__PAGE_BG__;overflow:hidden}video{width:100%;height:100%;object-fit:cover}</style></head><body><video id="v" muted playsinline autoplay></video><script>${PAGE_SCRIPT(worker)}</script></body></html>`;
}

export function generated() {
  return `// GENERATED by scripts/build-wink-scan.mjs from lib/wink-code. Do not edit; the test fails when it is out of date.\nexport const WINK_SCAN_HTML = ${JSON.stringify(page())};\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const want = generated();
  if (process.argv[2] === "--check") {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (have !== want) { console.error("wink-scan-page.generated.js is out of date: run node scripts/build-wink-scan.mjs"); process.exit(1); }
    console.log("wink-scan page is up to date");
  } else { fs.writeFileSync(OUT, want); console.log(`wrote ${path.relative(repo, OUT)} (${want.length} bytes)`); }
}
