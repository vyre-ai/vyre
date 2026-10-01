// T1, the Local Network Access check (Chrome 142 and later asks before a PUBLIC page reaches a local or
// loopback address). A public page (reached through a throwaway tunnel, so its address is public) tries
// to reach a local server in four ways; the driver reports what the browser did with each. This is the
// setup page's situation: vyre.run (public) opening the box's own address (private, tailnet).
//
//   node scripts/matrix/lna.mjs --cdp http://127.0.0.1:9222 --public https://x.trycloudflare.com --local http://127.0.0.1:18200 --out results/lna --device linux-chrome
// CI runners only.
import http from "node:http";
import { connect } from "./lib/cdp.mjs";
import { recorder } from "./lib/results.mjs";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i < 0 ? d : process.argv[i + 1]; };
if (!process.env.CI) { console.error("lna: runs on a CI runner only (CI is unset)"); process.exit(2); }
const cdp = arg("cdp", "http://127.0.0.1:9222"), pub = arg("public"), local = arg("local", "http://127.0.0.1:18200"), out = arg("out", "results/lna"), device = arg("device", "chrome");
const r = recorder(out, "T1", device);
const sleep = ms => new Promise(res => setTimeout(res, ms));

const page = await connect(cdp, { width: 1280, height: 900 });
try {
  await page.open(pub + "/lna.html");
  const ver = String(await page.evaluate("navigator.userAgent")).match(/(Chrome|Edg|Version)\/[\d.]+/)?.[0] || "unknown";
  r.step("0-browser", true, { why: ver });
  // (a) fetch: what a script on the page does when it asks the local server
  await page.evaluate(`(() => { window.__a = "pending"; fetch(${JSON.stringify(local + "/ping")}, { mode: "cors" }).then(x => x.text()).then(t => { window.__a = "ok:" + t; }).catch(e => { window.__a = "blocked:" + e.message; }); return 1; })()`);
  await sleep(12000);
  const a = String(await page.evaluate("window.__a"));
  r.step("1-fetch-to-local", a.startsWith("ok") ? "ok" : "skip", { why: `fetch: ${a} (pending after 12 s means the browser is waiting on a permission prompt)`, shot: r.saveShot("fetch", 1, await page.shot()) });
  // (b) a popup and a top-level navigation to the local address: the setup page's "open your server" link
  await page.evaluate(`window.__b = window.open(${JSON.stringify(local + "/page")}, "_blank") ? "opened" : "blocked"`);
  await sleep(4000);
  r.step("2-popup-to-local", true, { why: `window.open: ${await page.evaluate("window.__b")}` });
  const targets = await (await fetch(cdp + "/json")).json();
  const hit = targets.filter(t => t.url.startsWith(local)).map(t => `${t.type}:${t.title || "(untitled)"}`);
  r.step("2b-popup-loaded", hit.length > 0, { why: hit.length ? "a tab at the local address: " + hit.join(", ") : "no tab reached the local address" });
  // (c) top-level navigation of the page itself
  const status = await page.open(local + "/page");
  const text = String(await page.waitText(/local page/, 6000)).slice(0, 80);
  r.step("3-navigate-to-local", /local page/.test(text), { why: `HTTP ${status}, text "${text.replace(/\s+/g, " ")}"`, shot: r.saveShot("navigate", 2, await page.shot()) });
} catch (e) {
  r.step("run", false, { why: String(e.message).slice(0, 300) });
} finally { await page.close(); }
process.exit(0);
