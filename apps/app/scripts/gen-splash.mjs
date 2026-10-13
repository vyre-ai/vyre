// Writes the splash: public/splash.html (self-contained, for the web page and for the Mac and Windows shells to show while the web view loads) and the same markup
// inside public/index.html between the vyre-splash markers. Colours come from lib/theme/tokens.json (v2.color bg), the mark from the approved master SVG. Nothing is hand-typed.
//   node scripts/gen-splash.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const repo = path.resolve(app, "../..");
const tokens = JSON.parse(fs.readFileSync(path.join(repo, "lib/theme/tokens.json"), "utf8"));
const dark = tokens.v2.color.dark.bg, paper = tokens.v2.color.paper?.bg ?? tokens.v2.color.light?.bg;
if (!dark || !paper) throw new Error("tokens.v2.color.{dark,paper}.bg not found");

// The master, with every id made private to the splash (the app draws the same mark and the ids must not meet), and the wire and bead given class names to animate.
let svg = fs.readFileSync(path.join(repo, "docs/design/brand/export/vyre/vyre-master.svg"), "utf8").trim();
svg = svg.replace(/id="([^"]+)"/g, 'id="sp-$1"').replace(/url\(#([^)]+)\)/g, "url(#sp-$1)");
svg = svg.replace(/<svg [^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true">');
const WIRE = 'd="M256 320 L496 720 L634 490"';
svg = svg.split(WIRE).join(`${WIRE} class="w"`);
svg = svg.replace('<clipPath id="sp-c20">', '<g class="bead"><clipPath id="sp-c20">').replace('</g><rect width="1024" height="1024" filter="url(#sp-grain)"', '</g></g><rect width="1024" height="1024" filter="url(#sp-grain)"');
if (!svg.includes('class="bead"') || !svg.includes('class="w"')) throw new Error("the master changed: wire or bead not found");

const css = `
#vyre-splash{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:${dark};transition:opacity .32s ease}
@media (prefers-color-scheme:light){#vyre-splash{background:${paper}}}
#vyre-splash.gone{opacity:0;pointer-events:none}
#vyre-splash .m{width:112px;height:112px;animation:sp-in .32s ease both}
#vyre-splash .w{stroke-dasharray:740;stroke-dashoffset:740;animation:sp-draw .56s cubic-bezier(.2,.7,.2,1) .08s forwards}
#vyre-splash .bead{opacity:0;animation:sp-bead .36s ease .52s forwards}
@keyframes sp-in{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}
@keyframes sp-draw{to{stroke-dashoffset:0}}
@keyframes sp-bead{to{opacity:1}}
@media (prefers-reduced-motion:reduce){#vyre-splash .m,#vyre-splash .w,#vyre-splash .bead{animation:none;opacity:1;stroke-dashoffset:0}}`.trim();
// The app calls __vyreSplashDone() when its first screen is up; the splash always plays its 950 ms intro first, then fades. A page that never calls it clears itself after 9 s.
const script = `var t0=Date.now();window.__vyreSplashDone=function(){var s=document.getElementById("vyre-splash");if(!s||s.__go)return;s.__go=1;setTimeout(function(){s.className+=" gone";setTimeout(function(){s.parentNode&&s.parentNode.removeChild(s)},400)},Math.max(0,950-(Date.now()-t0)))};setTimeout(window.__vyreSplashDone,9000);`;
const block = `<style id="vyre-splash-css">${css}</style>\n    <div id="vyre-splash" role="img" aria-label="Vyre"><div class="m">${svg}</div></div>\n    <script>${script}</script>`;

const standalone = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vyre</title></head>\n<body style="margin:0">\n    ${block}\n</body></html>\n`;
fs.writeFileSync(path.join(app, "public/splash.html"), standalone);

const idx = path.join(app, "public/index.html");
let html = fs.readFileSync(idx, "utf8");
const a = "<!-- vyre-splash:start -->", b = "<!-- vyre-splash:end -->";
const region = `${a}\n    ${block}\n    ${b}`;
if (html.includes(a)) html = html.replace(new RegExp(`${a}[\\s\\S]*?${b}`), () => region);
else html = html.replace('<div id="root"></div>', `<div id="root"></div>\n    ${region}`);
fs.writeFileSync(idx, html);
console.log("public/splash.html and public/index.html written");
