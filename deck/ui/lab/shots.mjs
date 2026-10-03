// Screenshots of lab scenarios in headless Chrome (a temp profile, nothing on screen), for matching the prototype's reference shots in team/0.3/ui-ref.
//   node deck/ui/lab/shots.mjs <outdir> <scenario[?query]>... [--w 390,1280] [--theme dark,paper] [--h 860]
// A scenario with its own query (appearance?accent=amber) is shot as given. Files: <outdir>/<w>-<scenario>-<theme>.png. Stops its own Chrome.
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { openTab } from "../../test/cdp.js";
import { CHROME_SAFE } from "../../../lib/chrome-flags/index.js";
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const widths = flag("--w", "390,1280").split(",").map(Number), themes = flag("--theme", "dark,paper").split(","), height = Number(flag("--h", "860"));
const [out, ...scenarios] = args;
fs.mkdirSync(out, { recursive: true });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "uilab-"));
const port = 9700 + Math.floor(Math.random() * 90);
const bin = process.env.CHROME || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const chrome = spawn(bin, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", ...CHROME_SAFE, "--allow-file-access-from-files", `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
const cdp = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { await fetch(`${cdp}/json/version`); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
let bad = 0;
try {
  for (const w of widths) {
    const tab = await openTab(cdp, { width: w, height, scale: 1, mobile: false });
    for (const s of scenarios) for (const theme of themes) {
      const [name, query = ""] = s.split("?");
      await tab.go("about:blank", 100);
      await tab.go(`file://${HERE}/index.html#/${name}?${query}${query ? "&" : ""}theme=${theme}`, 1200);
      const title = await tab.run("return document.title");
      const sideways = await tab.run("return document.scrollingElement.scrollWidth > innerWidth + 1");
      if (title !== "ready" || sideways) { bad++; console.log(`WARN ${w} ${s} ${theme}: ${title !== "ready" ? "not drawn (" + title + ")" : "scrolls sideways"}`); }
      const full = await tab.run("return Math.max(document.scrollingElement.scrollHeight, innerHeight)");
      await tab.send("Emulation.setDeviceMetricsOverride", { width: w, height: Math.min(full, 4000), deviceScaleFactor: 1, mobile: false });
      fs.writeFileSync(path.join(out, `${w}-${name.replace(/\//g, "_")}-${theme}.png`), await tab.shot());
      await tab.send("Emulation.setDeviceMetricsOverride", { width: w, height, deviceScaleFactor: 1, mobile: false });
    }
    await tab.close();
  }
} finally { chrome.kill("SIGTERM"); await new Promise(r => setTimeout(r, 300)); fs.rmSync(profile, { recursive: true, force: true }); }
process.exit(bad ? 1 : 0);
