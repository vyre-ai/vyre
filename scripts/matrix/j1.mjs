// J1, install and onboarding through the setup page, walked the way a person does. Stand-ins are
// named: the relay is the real relay code on the runner, and the page and install script come from
// the staged build (j1-services.mjs). Run on a CI runner only.
//
//   node scripts/matrix/j1.mjs --cdp http://127.0.0.1:9222 --site http://127.0.0.1:PORT --env-file env.json --out results/j1
// env.json holds the environment for the install line: VYRE_BOX_URL, VYRE_RELAY and the like.
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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

  // 1.2b A hostile box (J1_HOSTILE): someone who copied the install line from a screenshot runs it on their own
  // server first. It is installed to another folder and not started, but it opens the relay mailbox for this code
  // and writes its own lines there. The real server's run follows. The page must either still reach the real
  // server or stop with a plain "start again"; it must never show the hostile box as the server.
  if (process.env.J1_HOSTILE) {
    const h = spawnSync("sh", ["-c", line], { env: { ...process.env, ...extraEnv, VYRE_DIR: "/srv/vyre-other", VYRE_NO_UP: "1" }, encoding: "utf8" });
    r.step("1.2b-hostile-box-ran-first", "fake", { why: `a second server with the same line, exit ${h.status} (stand-in for someone holding the screenshot)` });
  }

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
  if (process.env.J1_EXPECT_REFUSE) {
    // A server the installer must turn away (snap, rootless or Podman Docker): it stops in plain words, names the fix,
    // exits non-zero and starts nothing. The rest of the journey is not reachable, by design.
    const log = fs.readFileSync(out + "/install.log", "utf8");
    const plain = new RegExp(process.env.J1_EXPECT_REFUSE, "i").test(log) && /docker\.com/.test(log);
    r.step("1.3-install-refuses", words.code !== 0 && plain, { ms: Date.now() - t0, why: words.code === 0 ? "the installer went ahead on a Docker it should refuse" : plain ? `exit ${words.code}, plain words and the fix` : `exit ${words.code}: ${words.tail}`.slice(0, 300) });
    const ps = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
    const left = String(ps.stdout || "").split("\n").filter(n => /^vyre/.test(n));
    r.step("1.3c-nothing-started", left.length === 0, { why: left.length ? "containers left: " + left.join(", ") : "no Vyre container was made" });
    for (const st of ["1.4-page-found-box", "1.5-words-match", "1.6-channel-ready", "1.7-address", "1.8-claude", "1.9-tailscale", "1.11-claim-link"]) r.step(st, "skip", { why: "refused by design on this Docker" });
    throw Object.assign(new Error("done"), { expected: true });
  }
  r.step("1.3-install-runs", words.code === 0, { ms: Date.now() - t0, why: words.code === 0 ? undefined : `exit ${words.code}: ${words.tail}`.slice(0, 300) });
  if (words.code !== 0) throw new Error("install failed");
  if (process.env.J1_TWICE) {
    // The line pasted a second time (on the same server, or a screenshotted one): it leaves the running box alone.
    const again = spawnSync("sh", ["-c", line], { env: { ...process.env, ...extraEnv }, encoding: "utf8" });
    const said = hide((again.stdout || "") + (again.stderr || ""));
    r.step("1.3d-line-twice-is-harmless", again.status === 0 && /already (running|installed)/i.test(said) && !/Check words/.test(said), { why: `exit ${again.status}: ${said.split("\n").slice(-4).join(" | ")}`.slice(0, 300) });
  }
  r.step("1.3b-terminal-words", Boolean(words.words), { why: words.words ? undefined : "the terminal printed no four check words" });

  if (process.env.J1_HOSTILE) {
    // Someone else's server used the same code first, so the mailbox holds lines this page cannot trust. Safe is: the
    // page stops with a plain "Start again" and never offers the other server's words. (A holder of the code can stop
    // a setup this way; they cannot become the server.)
    const seen = await page.waitText(/Setup stopped|Found your server/i, 90000);
    const stopped = /Setup stopped/i.test(seen) && /Start again/i.test(seen);
    r.step("1.4h-hostile-box-stops-the-page", stopped, { shot: await shot("setup-hostile"), why: stopped ? "plain Start again, no words offered" : "the page showed: " + seen.replace(/\s+/g, " ").slice(0, 160) });
    throw Object.assign(new Error("done"), { expected: true });
  }
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
  if (!claimed) throw new Error("name not claimed");
  await click("I saved it");
  await sleep(500);
  await click("Continue");

  // 1.8 AI: Claude signs in through the page. FAKE: `claude auth login` on the box is a stand-in, since
  // a real sign-in needs a person and a real account. The box's own account handling is real.
  await sees(/Sign in with Claude/i, 30000);
  await click("Sign in with Claude");
  let paste = await sees(/the sign-in page/i, 45000);
  if (!paste) {
    // What the box said, straight from its tool (the page only shows a generic line).
    const said = spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "vyre", "call", "sessions.accounts.signin", '{"provider":"claude","label":"diag"}'], { encoding: "utf8" });
    const msg = ((said.stdout || "").match(/"message":\s*"([^"]+)"/) || [])[1] || "no message";
    r.step("1.8a-claude-signin-offered", false, { shot: await shot("setup-ai-fail"), why: `the box said: ${msg}` });
    // Known bug B1 (sessions): a fresh box has no /home/acct/<uid>. Provision it as root so the later stages run, and say so.
    const uid = (msg.match(/account (\d+) has no home/) || [])[1];
    if (!uid) throw new Error("sign-in failed: " + msg);
    const mk = spawnSync("docker", ["exec", "--privileged", "-u", "root", "vyre-vyre-1", "sh", "-c", `for u in $(seq ${uid} $((${uid} + 9))); do mkdir -p /home/acct/$u && chown $u:$u /home/acct/$u && chmod 700 /home/acct/$u; done; id; grep Cap /proc/self/status`], { encoding: "utf8" });
    fs.writeFileSync(out + "/acct-mk.txt", (mk.stdout || "") + (mk.stderr || ""));
    await click("Sign in with Claude");
    paste = await sees(/the sign-in page/i, 45000);
    let why2 = "home made by the harness, fake claude auth login";
    if (!paste) { const again = spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "vyre", "call", "sessions.accounts.signin", '{"provider":"claude","label":"diag2"}'], { encoding: "utf8" }); why2 = "the box said: " + (((again.stdout || "").match(/"message":\s*"([^"]+)"/) || [])[1] || (again.stdout || again.stderr || "").slice(0, 200)); const ls = spawnSync("docker", ["exec", "vyre-vyre-1", "ls", "-ln", "/home/acct"], { encoding: "utf8" }); fs.writeFileSync(out + "/acct-ls.txt", ls.stdout + ls.stderr); }
    r.step("1.8a2-claude-signin-after-workaround", paste ? "fake" : false, { shot: await shot("setup-ai-link"), why: why2 });
    if (!paste) throw new Error("no sign-in link even with the home made");
  } else r.step("1.8a-claude-signin-offered", "fake", { shot: await shot("setup-ai-link"), why: "fake claude auth login" });
  await page.evaluate(`(() => { const i = document.querySelector('input[name="code"]'); i.focus(); i.value = "good-code"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await click("Finish");
  const signed = await sees(/Claude is signed in/i, 60000);
  r.step("1.8b-claude-signed-in", signed ? "fake" : false, { shot: await shot("setup-ai-done"), why: "fake claude auth login" });
  if (!signed) throw new Error("claude sign-in did not finish");
  await click("Continue");

  // 1.9 Tailscale. STAND-IN: a headscale on the runner. The person's "sign in on Tailscale's page" is the register command.
  await sees(/Connect my server/i, 30000);
  const clicked = await click("Connect my server");
  fs.writeFileSync(out + "/ts-click.txt", `clicked=${clicked}\n`);
  // The page only shows a sign-in link on tailscale.com (correct for real Tailscale), so a headscale link is not shown.
  // The harness reads the same link from the box, as a person would open it from the page.
  await sleep(4000);
  fs.appendFileSync(out + "/ts-click.txt", "page text after the click: " + hide(String(await page.evaluate(`(document.querySelector('[data-region="tailscale"]')||{}).innerText||""`))).replace(/\s+/g, " ") + "\n");
  const said = spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "vyre", "call", "network.tailscale.login", "{}"], { encoding: "utf8" });
  const login = ((said.stdout || "").match(/"loginUrl":\s*"([^"]+)"/) || [])[1] || "";
  const key = (login.match(/\/register\/([A-Za-z0-9_-]+)/) || [])[1];
  r.step("1.9a-tailscale-login-link", key ? "fake" : false, { why: key ? "headscale stand-in: the register link was read from the box, because the page only shows tailscale.com links" : "no register link: " + hide((said.stdout || said.stderr || "").slice(0, 150)), shot: await shot("setup-ts-link") });
  if (!key) throw new Error("no tailscale login link");
  const reg = spawnSync("docker", ["exec", "e2e-headscale", "headscale", "nodes", "register", "--user", "marlow", "--key", key], { encoding: "utf8" });
  r.step("1.9b-node-approved", reg.status === 0, { why: reg.status === 0 ? "headscale stand-in" : (reg.stderr || reg.stdout).slice(0, 200) });
  const live = await sees(/Your address is live/i, 240000);
  if (!live) {
    const dbg = t => spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "vyre", "call", t, "{}"], { encoding: "utf8" });
    fs.writeFileSync(out + "/addr-diag.txt", ["names.status", "network.tailscale.status"].map(t => { const x = dbg(t); return `== ${t}\n${hide(x.stdout || "")}${x.stderr || ""}`; }).join("\n"));
  }
  r.step("1.9c-address-live", live, { shot: await shot("setup-ts-live"), why: live ? "certificate from a stand-in ACME server (pebble), DNS record in the fake zone" : undefined });
  if (!live) {
    const ns = spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "vyre", "call", "names.status", "{}"], { encoding: "utf8" });
    const phase = ((ns.stdout || "").match(/"phase":\s*"([^"]+)"/) || [])[1];
    r.step("1.9c2-box-says-serving", phase === "serving", { why: `names.status phase "${phase}" while the page still says Publishing your address` });
    for (const st of ["1.10-devices", "1.11-claim-link"]) r.step(st, "skip", { why: "blocked: the page never left Publishing your address (B3)" });
    throw new Error("address never went live");
  }
  await click("Continue");

  // 1.10 devices: the ring is scanned by a person's phone. By hand; here the page is walked past it.
  await sees(/Add my phone|Skip for now/i, 30000);
  r.step("1.10a-phone-ring-offered", /Add my phone/i.test(await page.waitText(/Add my phone/i, 10000)), { shot: await shot("setup-devices") });
  r.step("1.10b-phone-pairs", "by-hand", { why: "scan the ring with the Vyre app: batch U1" });
  await click("Skip for now");

  // 1.11 claim: the page mints the passkey link for the server's own address
  const arrive = await sees(/Open your server/i, 60000);
  await click("Get my link");
  await sleep(3000);
  const claimHref = String(await page.evaluate(`(() => { const t = [...document.querySelectorAll("a[href],pre,code,input")].map(e => e.href || e.value || e.textContent).find(x => /onboard\\/passkey/.test(x || "")); return t || ""; })()`)).trim();
  r.step("1.11-claim-link", arrive && /^https:\/\/marlow-finch\.vyre\.run\/onboard\/passkey#claim=\S+/.test(claimHref), { shot: await shot("setup-claim-link"), why: claimHref ? hide(claimHref).slice(0, 100) : "no link on the page after Get my link" });
} catch (e) {
  if (!(e && /** @type {any} */ (e).expected)) {
    r.step("run", false, { why: hide(e.message).slice(0, 300) });
    try { await shot("failure"); } catch {}
  }
} finally {
  if (page) await page.close();
}
process.exit(r.failed ? 1 : 0);
