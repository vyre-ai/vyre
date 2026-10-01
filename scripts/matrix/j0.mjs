// J0, the matrix smoke: a browser on a device opens the box's onboarding link, the page loads
// with its own title and words, nothing throws, no sample-world name shows, and a screenshot
// comes back. Any Chrome with DevTools works (desktop, or Android over adb forward).
//
//   node scripts/matrix/j0.mjs --cdp http://127.0.0.1:9222 --link <url> --device linux-chrome --out results [--mobile]
//   node scripts/matrix/j0.mjs --webdriver http://127.0.0.1:4444 ...   (Safari, through safaridriver)
import fs from "node:fs";
import { connect } from "./lib/cdp.mjs";
import { connect as connectWebDriver } from "./lib/webdriver.mjs";
import { recorder, fixtureHits } from "./lib/results.mjs";

const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i < 0 ? def : process.argv[i + 1]; };
const cdp = arg("cdp", "http://127.0.0.1:9222"), device = arg("device", "chrome"), out = arg("out", "results");
const link = arg("link") || (arg("link-file") && fs.readFileSync(arg("link-file"), "utf8").trim());
const mobile = process.argv.includes("--mobile"), native = process.argv.includes("--native");
if (!link) { console.error("j0: --link or --link-file is required"); process.exit(2); }

const r = recorder(out, "J0", device);
const hide = s => String(s).replace(/([?&]t=)[^&\s]+/g, "$1...");
const t0 = Date.now();
let page;
try {
  page = arg("webdriver") ? await connectWebDriver(arg("webdriver")) : await connect(cdp, native ? { reuse: true } : mobile ? { width: 390, height: 844, mobile: true, scale: 2 } : { width: 1280, height: 900 });
  const status = await page.open(link);
  r.step("open", status === 200, { ms: Date.now() - t0, why: status === 200 ? undefined : `HTTP ${status}` });
  const text = await page.waitText(/\S{3,}/);
  const title = String(await page.evaluate("document.title"));
  r.step("page", title === "Set up Vyre" && text.length > 20, { why: `title "${title}", ${text.length} characters` });
  // Text a person sees that innerText leaves out: placeholders, labels, titles, alt text, values.
  const attrs = String(await page.evaluate(`[...document.querySelectorAll("[placeholder],[aria-label],[title],[alt],input[value]")]
    .map(e => [e.getAttribute("placeholder"), e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("alt"), e.value].filter(Boolean).join(" ")).join(" ") + " " + document.title`));
  const hits = fixtureHits(text + " " + attrs);
  r.step("no-fixture-names", hits.length === 0, hits.length ? { why: "shows " + hits.join(", ") } : {});
  const errors = page.logs.filter(l => /^(exception|error|console\.error)/.test(l));
  r.step("no-errors", errors.length === 0, errors.length ? { why: hide(errors.slice(0, 3).join(" | ")) } : {});
  r.step("screenshot", true, { shot: r.saveShot("setup", 1, await page.shot()) });
} catch (e) {
  r.step("run", false, { why: hide(/** @type {Error} */ (e).message).slice(0, 300) });
} finally {
  if (page) await page.close();
}
process.exit(r.failed ? 1 : 0);
