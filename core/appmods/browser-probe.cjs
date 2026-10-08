// A real browser against an app's screens on its own origin (run inside ghcr.io/puppeteer/puppeteer by docuseal-live.test.js with VYRE_APPMODS_BROWSER=1): open the address Vyre gave (it carries a one-time
// ticket), wait for the app's JavaScript to settle, click through to a second screen, report every request the page made (all must be to the app's origin, none may fail, the console must hold no error),
// and from the app's own page try to read Vyre's origin as a script of the app could (it must get nothing).
const puppeteer = require("puppeteer");
(async () => {
  const [entry, vyreOrigin] = process.argv.slice(2);
  const app = new URL(entry).origin;
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const requests = [], failed = [], errors = [], statuses = {};
  page.on("request", r => { const u = new URL(r.url()); requests.push(u.origin); });
  page.on("requestfailed", r => failed.push(`${r.url()} ${r.failure() && r.failure().errorText}`));
  page.on("response", r => { const u = new URL(r.url()); if (u.origin === app && r.status() >= 400) statuses[u.pathname] = r.status(); });
  page.on("pageerror", e => errors.push(String(e.message || e).slice(0, 200)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  await page.goto(entry, { waitUntil: "load", timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));
  const first = { url: page.url(), title: await page.title(), sawLogin: (await page.$('input[name="user[password]"]')) !== null };
  const links = await page.$$eval("a[href]", as => as.map(a => a.getAttribute("href")).filter(h => h && h.startsWith("/")));
  const next = links.find(h => h !== new URL(page.url()).pathname && !h.includes("sign_out") && !h.includes("logout"));
  let second = null;
  if (next) {
    await page.evaluate(h => { const a = [...document.querySelectorAll("a[href]")].find(x => x.getAttribute("href") === h); a.click(); }, next);
    await new Promise(r => setTimeout(r, 4000));
    second = { link: next, url: page.url(), title: await page.title() };
  }
  const pageErrors = errors.slice(0, 10);
  // what a script of the app can do to Vyre: read its health route with credentials, from the app's own origin
  const vyreFromApp = await page.evaluate(async origin => { try { const r = await fetch(origin + "/v1/health", { credentials: "include", mode: "cors" }); const t = await r.text(); return r.ok && t.includes("version") ? "readable" : "blocked"; } catch { return "blocked"; } }, vyreOrigin);
  const shot = await page.screenshot({ type: "png" });
  require("fs").writeFileSync("/out/page.png", shot);
  const outside = [...new Set(requests.filter(o => o !== app && !o.startsWith("data:") && o !== "null"))];
  console.log(JSON.stringify({ first, second, requests: requests.length, outside, failed, statuses, errors: pageErrors, vyreFromApp, links: links.slice(0, 12) }));
  await browser.close();
})().catch(e => { console.log(JSON.stringify({ crash: String(e && e.message || e) })); process.exit(1); });
