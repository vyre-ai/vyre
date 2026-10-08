// A real browser against an app's screens under /m/<module>/ (run inside ghcr.io/puppeteer/puppeteer by docuseal-live.test.js with VYRE_APPMODS_BROWSER=1): load the page, wait for the app's
// JavaScript to settle, click through to a second screen, and report every request the page made. Every request must be under the prefix and none may fail; the console must hold no error.
const puppeteer = require("puppeteer");
(async () => {
  const [base, prefix] = process.argv.slice(2);
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const requests = [], failed = [], errors = [], statuses = {};
  page.on("request", r => { const u = new URL(r.url()); if (u.origin === new URL(base).origin) requests.push(u.pathname); });
  page.on("requestfailed", r => failed.push(`${r.url()} ${r.failure() && r.failure().errorText}`));
  page.on("response", r => { const u = new URL(r.url()); if (u.origin === new URL(base).origin && r.status() >= 400) statuses[u.pathname] = r.status(); });
  page.on("pageerror", e => errors.push(String(e.message || e).slice(0, 200)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  await page.goto(base + prefix + "/", { waitUntil: "load", timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));
  const first = { url: page.url(), title: await page.title(), sawLogin: (await page.$('input[name="user[password]"]')) !== null };
  // a second screen: follow the app's own navigation (a link under the prefix that is not the page we are on)
  const links = await page.$$eval("a[href]", as => as.map(a => a.getAttribute("href")).filter(h => h && h.startsWith("/")));
  const next = links.find(h => h !== new URL(page.url()).pathname && !h.includes("sign_out") && !h.includes("logout"));
  let second = null;
  if (next) {
    await page.evaluate(h => { const a = [...document.querySelectorAll("a[href]")].find(x => x.getAttribute("href") === h); a.click(); }, next);
    await new Promise(r => setTimeout(r, 4000));
    second = { link: next, url: page.url(), title: await page.title() };
  }
  const icons = await page.$$eval("link[rel*=icon]", ls => ls.map(l => l.getAttribute("href")));
  const shot = await page.screenshot({ type: "png" });
  require("fs").writeFileSync("/out/page.png", shot);
  const outside = [...new Set(requests.filter(p => !(p === prefix || p.startsWith(prefix + "/"))))];
  console.log(JSON.stringify({ icons, first, second, requests: requests.length, outside, failed, statuses, errors: errors.slice(0, 10), links: links.slice(0, 12) }));
  await browser.close();
})().catch(e => { console.log(JSON.stringify({ crash: String(e && e.message || e) })); process.exit(1); });
