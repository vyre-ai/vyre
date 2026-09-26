// @ts-check
// Renders the phone app's images from their SVG drawings with a running Chrome: the maskable
// icons, the Apple touch icon and the iOS launch screens. A build helper, run by hand when the
// mark changes; the PNGs are committed.
//
//   CDP=http://127.0.0.1:9422 node deck/test/pwa-assets.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.js";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CDP = process.env.CDP || "http://127.0.0.1:9422";
const svg = (/** @type {string} */ f) => fs.readFileSync(path.join(DECK, f), "utf8");

// The iOS launch screens: CSS size and scale of each current iPhone, in portrait.
export const SPLASH = [[320, 568, 2], [375, 667, 2], [414, 736, 3], [375, 812, 3], [414, 896, 2], [414, 896, 3], [390, 844, 3],
  [428, 926, 3], [393, 852, 3], [430, 932, 3], [402, 874, 3], [440, 956, 3]];

/** @param {string} out @param {number} w @param {number} h @param {string} body */
async function render(out, w, h, body) {
  const tab = await openTab(CDP, { width: w, height: h, scale: 1, mobile: false });
  const html = `<!doctype html><html><body style="margin:0;background:#0E0D0C">${body}</body></html>`;
  await tab.go("data:text/html;base64," + Buffer.from(html).toString("base64"), 400);
  fs.writeFileSync(path.join(DECK, out), await tab.shot());
  await tab.close();
  console.log(out, `${w}x${h}`);
}

const img = (/** @type {string} */ s, /** @type {number} */ n) => `<img width="${n}" height="${n}" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}">`;
await render("icon-maskable-192.png", 192, 192, img(svg("icon-maskable.svg"), 192));
await render("icon-maskable-512.png", 512, 512, img(svg("icon-maskable.svg"), 512));
// iOS rounds the corners itself and shows transparency as black, so the touch icon is full bleed.
await render("apple-touch-icon.png", 180, 180, img(svg("icon-maskable.svg"), 180));
fs.mkdirSync(path.join(DECK, "splash"), { recursive: true });
const mark = svg("icon-maskable.svg").replace('<rect width="1024" height="1024" fill="#161513"/>', "");
for (const [w, h, s] of SPLASH) {
  const W = w * s, H = h * s, m = Math.round(W * 0.36);
  await render(`splash/${W}x${H}.png`, W, H, `<div style="width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center">${img(mark, m)}</div>`);
}
