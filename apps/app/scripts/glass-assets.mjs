// Copy the Glass screen page's files next to the web export's static files: public/glass/ is what /app/glass/frame.html serves (a web iframe). noVNC and the take-over input rules
// live in apps/app/vendor/glass (moved from deck/glass), so there is one noVNC in the repo.
//   node scripts/glass-assets.mjs        run by `npm run export:web` before `expo export`
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const out = path.join(app, "public", "glass");
const vendor = path.join(app, "vendor/glass");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(vendor, "novnc/core"), path.join(out, "novnc/core"), { recursive: true });
fs.cpSync(path.join(vendor, "novnc/vendor"), path.join(out, "novnc/vendor"), { recursive: true });
for (const [from, name] of [[path.join(vendor, "input.js"), "input.js"], [path.join(vendor, "util.js"), "util.js"], [path.join(app, "src/glass/frame.js"), "frame.js"], [path.join(app, "src/glass/frame.html"), "frame.html"]]) {
  fs.copyFileSync(from, path.join(out, name));
}
console.log("glass assets: public/glass");
