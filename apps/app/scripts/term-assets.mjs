// Copy the terminal page's files next to the web export's static files: public/term/ is what /app/term/frame.html serves
// (a web iframe and a phone WebView both load it). xterm is the Deck's vendored copy, so there is one xterm in the repo.
//   node scripts/term-assets.mjs        run by `npm run export:web` before `expo export`
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const out = path.join(app, "public", "term");
const vendor = path.resolve(app, "src/vendor/deck/vendor/xterm");
fs.mkdirSync(out, { recursive: true });
const files = [
  [path.join(vendor, "xterm.js"), "xterm.js"], [path.join(vendor, "addon-fit.js"), "addon-fit.js"], [path.join(vendor, "xterm.css"), "xterm.css"],
  [path.join(app, "src/terminal/client.js"), "client.js"], [path.join(app, "src/terminal/keys.js"), "keys.js"], [path.join(app, "src/terminal/frame.js"), "frame.js"], [path.join(app, "src/terminal/frame.html"), "frame.html"],
];
for (const [from, name] of files) fs.copyFileSync(from, path.join(out, name));
console.log(`term assets: ${files.length} files in public/term`);
