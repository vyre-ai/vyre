// J1, install and onboarding through the setup page, walked the way a person does. Stand-ins are
// named: the relay is the real relay code on the runner, and the page and install script come from
// the staged build (j1-services.mjs). Run on a CI runner only.
//
//   node scripts/matrix/j1.mjs --cdp http://127.0.0.1:9222 --site http://127.0.0.1:PORT --env-file env.json --out results/j1
// env.json holds the environment for the install line: VYRE_BOX_URL, VYRE_RELAY and the like.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "./lib/cdp.mjs";
import { recorder, fixtureHits } from "./lib/results.mjs";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i < 0 ? d : process.argv[i + 1]; };
const cdp = arg("cdp", "http://127.0.0.1:9222"), site = arg("site"), out = arg("out", "results/j1"), device = arg("device", "linux-chrome");
const extraEnv = arg("env-file") ? JSON.parse(fs.readFileSync(arg("env-file"), "utf8")) : {};
if (!site) { console.error("j1: --site is required"); process.exit(2); }
if (!process.env.CI) { console.error("j1: runs on a CI runner only (CI is unset)"); process.exit(2); }

const r = recorder(out, "J1", device);
const hide = s => String(s).replace(/(VYRE_CODE=)\S+/g, "$1...").replace(/(claim=)[^\s"']+/g, "$1...");
let n = 0;
const sleep = ms => new Promise(res => setTimeout(res, ms));
let page;

/** Click the button whose visible text starts with `label`. */
const click = label => page.evaluate(`(() => { const b = [...document.querySelectorAll("button,a.btn")].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
const shot = async name => r.saveShot(name, ++n, await page.shot());
/** Wait for a page text; returns whether it appeared. */
const sees = async (re, ms = 30000) => re.test(await page.waitText(re, ms));

try {
  page = await connect(cdp, { width: 1280, height: 900 });
  const status = await page.open(site + "/setup/");
  r.step("1.1-open-setup", status === 200, { why: `HTTP ${status}`, shot: await shot("setup-start") });
  const text = await page.waitText(/Put Vyre on your server/);
  const attrs = String(await page.evaluate(`[...document.querySelectorAll("[placeholder],[aria-label],[title],[alt]")].map(e => [e.getAttribute("placeholder"), e.getAttribute("aria-label"), e.getAttribute("title"), e.getAttribute("alt")].filter(Boolean).join(" ")).join(" ") + " " + document.title`));
  const hits = fixtureHits(text + " " + attrs);
  r.step("1.1b-no-fixture-names", hits.length === 0, hits.length ? { why: hits.join(", ") } : {});

  // 1.2 start: the page makes its key and shows one install line
  await click("Set up my server");
  const shown = await sees(/Run this on your server/);
  const line = String(await page.evaluate(`(document.querySelector("pre code")||{}).textContent||""`)).trim();
  const okLine = shown && /^curl -fsSL http:\/\/127\.0\.0\.1:\d+\/i \| VYRE_CODE=\S+ sh$/.test(line);
  r.step("1.2-install-line", okLine, { why: okLine ? undefined : hide(line).slice(0, 200), shot: await shot("setup-install") });
  if (!okLine) throw new Error("no install line");

  // 1.3 run the line on the runner, as a person pastes it
  const t0 = Date.now();
  const words = await new Promise(resolve => {
    const child = spawn("sh", ["-c", line], { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let all = "";
    const eat = d => { all += d; };
    child.stdout.on("data", eat); child.stderr.on("data", eat);
    child.on("close", code => {
      fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(out + "/install.log", hide(all));
      const m = all.match(/Check words:\s*(?:\x1b\[[0-9;]*m)*([a-z]+(?: [a-z]+){3})/);
      resolve({ code, words: m ? m[1].split(" ") : null, tail: hide(all).split("\n").slice(-6).join(" | ") });
    });
  });
  r.step("1.3-install-runs", words.code === 0, { ms: Date.now() - t0, why: words.code === 0 ? undefined : `exit ${words.code}: ${words.tail}`.slice(0, 300) });
  if (words.code !== 0) throw new Error("install failed");
  r.step("1.3b-terminal-words", Boolean(words.words), { why: words.words ? undefined : "the terminal printed no four check words" });

  // 1.4 the page finds the box
  const found = await sees(/Found your server/i, 90000);
  r.step("1.4-page-found-box", found, { shot: await shot("setup-found") });
  if (!found) throw new Error("box not found");
  const onPage = String(await page.evaluate(`[...document.querySelectorAll('ol[aria-label="Check words"] li')].map(l => l.textContent.trim()).join(" ")`));
  r.step("1.5-words-match", Boolean(words.words) && onPage === words.words.join(" "), { why: `page "${onPage}" terminal "${(words.words || []).join(" ")}"` });
  await click("These match my server's terminal");
  const form = await sees(/Choose its address/, 60000);
  r.step("1.6-channel-ready", form, { shot: await shot("setup-naming") });
  if (!form) throw new Error("no naming form");

  // 1.7 choose the address and claim it (the name directory here is the real Worker code over a fake DNS)
  await page.evaluate(`(() => { const i = document.querySelector('input[name="address"]'); i.focus(); i.value = "marlow-finch"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const hint = await page.waitText(/is free|is taken|is reserved|not allowed/i, 30000);
  r.step("1.7a-name-checked", /is free/i.test(hint), { shot: await shot("setup-name-check"), why: hide(String(await page.evaluate(`(document.querySelector('[data-role="hint"]')||{}).textContent||""`))) });
  await click("Claim this address");
  const claimed = await sees(/recovery code/i, 60000);
  r.step("1.7b-name-claimed", claimed, { shot: await shot("setup-claimed") });
} catch (e) {
  r.step("run", false, { why: hide(e.message).slice(0, 300) });
  try { await shot("failure"); } catch {}
} finally {
  if (page) await page.close();
}
process.exit(r.failed ? 1 : 0);
