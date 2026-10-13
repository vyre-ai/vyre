// Writes the splash: public/splash.html (self-contained, for the web page and for the Mac and Windows shells to show while the web view loads) and the same markup
// inside public/index.html between the vyre-splash markers. Colours come from lib/theme/tokens.json (v2.color bg), the icon from site/favicon.svg. Nothing is hand-typed.
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

// The icon the site and the app use everywhere (the halftone V on a card with a folded corner, site/favicon.svg, drawn by scripts/gen-mark.mjs), with every id made private to the splash
// (the app draws marks of its own and the ids must not meet). It is a vector, so it is crisp at any density.
let svg = fs.readFileSync(path.join(repo, "site/favicon.svg"), "utf8").trim();
svg = svg.replace(/id="([^"]+)"/g, 'id="sp-$1"').replace(/url\(#([^)]+)\)/g, "url(#sp-$1)");
svg = svg.replace(/<svg [^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">');
if (!svg.includes('sp-card')) throw new Error("site/favicon.svg changed: the card was not found");

const css = `
#vyre-splash{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:${dark};transition:opacity .32s ease}
@media (prefers-color-scheme:light){#vyre-splash{background:${paper}}}
#vyre-splash.gone{opacity:0;pointer-events:none}
#vyre-splash .m{width:128px;height:128px;filter:drop-shadow(0 0 1px rgba(241,238,230,.55)) drop-shadow(0 10px 32px rgba(184,164,255,.16));animation:sp-in .6s cubic-bezier(.2,.7,.2,1) both}
@media (prefers-color-scheme:light){#vyre-splash .m{filter:drop-shadow(0 0 1px rgba(20,19,18,.35)) drop-shadow(0 12px 28px rgba(20,19,18,.22))}}
@keyframes sp-in{from{opacity:0;transform:translateY(6px) scale(.94)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){#vyre-splash .m{animation:none}}`.trim();
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
