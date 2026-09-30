// @ts-check
// A click-through of the Deck's Vault against a REAL vyred in a temp home, in headless Chrome,
// with screenshots. A test helper, not part of the product; never touches ~/.vyre.
//
//   node deck/test/vault-shots.js <out-dir>
//
// What is real: vyred, the vault module (list, update with generate, health, passes, pending,
// devices, audit), the Deck, and a passkey assertion made by Chrome's virtual authenticator.
// What is a TEST-ONLY STUB, in the proxy below, because those tools are on other branches:
// vault.session.open/close, vault.copy, vault.clipboard.clear, vault.reveal, vault.history, the
// presence challenge (it checks the assertion's shape, not its signature), and letting the
// "deck" caller use vault.totp, grant, pending, approve, pass.create and offboard (remapped to
// "local"). The stub's copy writes no clipboard; it only records that a copy happened.
//
// It fails (exit 1) if a canary value reaches the page's DOM, any HTTP response or the event
// stream, except the one vault.reveal response after an explicit Reveal click.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), "vault-shots"));
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4800 + Math.floor(Math.random() * 400);
const CANARY = "cnry" + crypto.randomBytes(14).toString("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
const fail = m => { failures.push(m); console.error("FAIL:", m); };

// ---- a temp home and a real vyred ------------------------------------------------------------

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vy-vault-deck-")));
if (path.resolve(root) === path.resolve(os.homedir(), ".vyre")) throw new Error("refusing to use the real ~/.vyre");
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  name: "alex-box", roots: [], transcripts: [], recall: { vectors: false, download: false },
  vault: { keystore: "file", relay: { host: "127.0.0.1", port: 0 }, deck: { reveal: true }, breach: "off" },
}));
const env = { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1", VYRE_HARNESS_DIR: path.join(root, "no-harness") };
const daemon = spawn(process.execPath, [path.join(REPO, "core", "daemon", "main.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
const { socketPath } = await import("../../core/config/index.js");
const { call } = await import("../../core/daemon/client.js");
const sock = socketPath(root);
for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
if (!fs.existsSync(sock)) throw new Error("vyred did not come up");
const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
const cli = as("cli");

let chrome = null, server = null, profile = "";
const cleanup = async () => {
  try { chrome?.kill(); } catch {}
  if (chrome) await new Promise(r => { chrome.once("exit", r); setTimeout(r, 3000); });
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try { server?.close(); } catch {}
  daemon.kill("SIGTERM");
  await new Promise(r => { daemon.once("exit", r); setTimeout(r, 3000); });
  fs.rmSync(root, { recursive: true, force: true });
};

try {
  // ---- fictional items ---------------------------------------------------------------------
  const strong = () => crypto.randomBytes(18).toString("base64url");
  const shared = strong();
  const put = async x => { const r = await cli("vault.put", x); if (r.error) throw new Error(`seed ${x.name}: ${r.error.message}`); };
  await put({ name: "harlow-drive", kind: "login", description: "Harlow Legal's shared Drive, for the monthly reports.", url: "https://accounts.google.com/signin", fields: { username: "alex@acme.test", password: CANARY } });
  await put({ name: "example-mail", kind: "login", description: "The team inbox.", url: "https://mail.example.com", fields: { username: "team@example.com", password: strong(), totp: "JBSWY3DPEHPK3PXP" } });
  await put({ name: "old-forum", kind: "login", description: "Support forum.", url: "https://forum.acme.test", fields: { username: "alex", password: "Summer2024!" } });
  await put({ name: "acme-intranet", kind: "login", url: "https://intranet.acme.test", fields: { username: "alex", password: shared } });
  await put({ name: "acme-wiki", kind: "login", url: "https://wiki.acme.test", fields: { username: "alex", password: shared } });
  await put({ name: "anthropic-api", kind: "api-key", description: "The team's Claude API key.", hosts: ["https://api.anthropic.com"], fields: { value: "sk-fixture-" + strong() } });
  await put({ name: "github-deploy", kind: "api-key", description: "Deploys the Harlow Legal site.", hosts: ["https://api.github.com"], fields: { value: strong() } });
  await put({ name: "stripe-restricted", kind: "secret", description: "Read-only Stripe key for the bookkeeping export.", hosts: ["https://api.stripe.com"], fields: { value: strong() } });
  await put({ name: "acme-visa", kind: "card", description: "Company card.", fields: { name: "Alex Rivera", number: "4242424242424242", expiry: "09/28", cvc: "123" } });
  await put({ name: "office-wifi", kind: "note", fields: { text: "Network acme-guest. Ask Dana for the printer code." } });
  await put({ name: "launch-env", kind: "env-set", description: "The Launch site's production settings.", fields: { DATABASE_URL: "postgres://fixture/" + strong(), STRIPE_KEY: strong(), SENTRY_DSN: strong() } });
  await cli("vault.grant", { name: "harlow-drive", module: "gate" });
  await cli("vault.grant", { name: "anthropic-api", module: "agents" });
  await cli("vault.grant", { name: "anthropic-api", module: "watchers", watcher: "q3-report" });
  await cli("vault.grant", { name: "github-deploy", module: "agents" });
  await as("mcp")("vault.grant", { name: "stripe-restricted", module: "watchers" });

  // Passes: a card for a fictional person, one relayed pass, one an agent asked for.
  const { newIdentity } = await import("../../core/vault/crypto.js");
  const { encodeCard } = await import("../../core/vault/relay.js");
  const dana = newIdentity(), theo = newIdentity();
  const card = (name, id) => encodeCard({ name, sign: id.sign.public, box: id.box.public, relay: "" });
  let r = await cli("vault.pass.create", { holder: "dana", card: card("dana", dana), items: ["harlow-drive"], mode: "relayed", expires: "30d", note: "Read the Reports folder" });
  if (r.error) throw new Error("pass: " + r.error.message);
  await cli("vault.pass.create", { holder: "theo", card: card("theo", theo), items: ["github-deploy"], mode: "relayed", expires: "7d", note: "Open pull requests, no push" }).then(async () => {
    // Make the second one the agent's request instead, so it waits.
    const p = (await cli("vault.pass.list")).data.passes.find(x => x.holder === "theo");
    if (p) await cli("vault.pass.revoke", { id: p.id });
  });
  await as("mcp")("vault.pass.create", { holder: "theo", items: ["github-deploy"], mode: "relayed", expires: "7d", note: "Open pull requests, no push" });

  // Rows vyred would have written over time: an old item, a rotate mark, usage today, a pass
  // held from someone else and a paired browser.
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  db.exec("PRAGMA busy_timeout=10000");
  const now = Date.now(), H = 3600_000, D = 24 * H;
  db.prepare("UPDATE vault_items SET updated=?, created=? WHERE name='old-forum'").run(now - 420 * D, now - 420 * D);
  db.prepare("UPDATE vault_items SET rotate='sealed to theo by p_old' WHERE name='github-deploy'").run();
  const audit = db.prepare("INSERT INTO vault_audit (at, action, name, who, ok, why) VALUES (?,?,?,?,1,NULL)");
  audit.run(now - 2 * H, "release", "harlow-drive", "module:gate");
  audit.run(now - 3 * H, "relay", "harlow-drive", "pass:p_x:dana");
  audit.run(now - 20 * 60_000, "release", "anthropic-api", "module:agents");
  audit.run(now - 50 * 60_000, "release", "anthropic-api", "module:watchers/q3-report");
  audit.run(now - 26 * H, "release", "github-deploy", "module:agents");
  db.prepare("INSERT INTO vault_held (id, owner, relay, owner_sign, items, mode, expires, accepted) VALUES (?,?,?,?,?,?,?,?)")
    .run("p_theo_ads", "theo", "https://theo.example.com", theo.sign.public, JSON.stringify(["acme-ads"]), "relayed", null, now - 5 * D);
  db.prepare("INSERT INTO vault_devices (id, name, token_hash, created, last_seen, revoked) VALUES (?,?,?,?,?,NULL)")
    .run("d_chrome", "Chrome on alex-mac", crypto.randomBytes(32).toString("hex"), now - 12 * D, now - H);
  db.close();

  // ---- the proxy, with the test-only stubs and the canary scan -------------------------------

  const cred = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credId = crypto.randomBytes(16);
  const challenges = new Map();
  const sessions = new Map();
  let revealAllowed = false;
  const hits = [];
  const STUB_TOOLS = ["vault.session.open", "vault.session.close", "vault.copy", "vault.clipboard.clear", "vault.reveal", "vault.history"];
  const REMAP = ["vault.totp", "vault.grant", "vault.pending", "vault.approve", "vault.pass.create", "vault.offboard"];
  const scan = (where, text) => { if (String(text).includes(CANARY)) hits.push(where); };
  const json = (res, status, body) => { const s = JSON.stringify(body); scan(`${status} stub`, s); res.writeHead(status, { "content-type": "application/json" }); res.end(s); };
  const readBody = req => new Promise(ok => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });
  const valueOf = async (name, field) => {
    if (field === "totp") return (await cli("vault.totp", { name })).data?.code;
    const x = await cli("vault.inject", { items: [{ name, env: "V", field }] });
    return x.data?.env?.V;
  };
  const liveSession = s => { const t = sessions.get(String(s || "")); return t && t > Date.now(); };
  const proof = h => {
    const m = /^passkey id=(\S+) cred=(\S+) ad=(\S+) cd=(\S+) sig=(\S+)$/.exec(String(h || ""));
    if (!m || !challenges.has(m[1])) return false;
    const cd = JSON.parse(Buffer.from(m[4], "base64url").toString("utf8"));
    const ok = cd.type === "webauthn.get" && cd.challenge === challenges.get(m[1]) && m[2] === credId.toString("base64url");
    challenges.delete(m[1]);
    return ok;
  };
  const presence = res => json(res, 403, { error: { code: "presence_required", message: "needs a person", methods: ["passkey"] } });

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const tool = url.pathname.startsWith("/v1/tools/") ? decodeURIComponent(url.pathname.slice(10)) : null;
    if (req.method === "POST" && url.pathname === "/v1/presence/challenge") {
      const id = crypto.randomBytes(12).toString("base64url"), ch = crypto.randomBytes(32).toString("base64url");
      challenges.set(id, ch);
      return json(res, 200, { data: { challenge: id, webauthn: { challenge: ch, rpId: "localhost", userVerification: "required", timeout: 60000, allowCredentials: [{ type: "public-key", id: credId.toString("base64url") }] } } });
    }
    if (req.method === "POST" && tool && STUB_TOOLS.includes(tool)) {
      const input = await readBody(req);
      if (tool === "vault.session.open") {
        if (!proof(req.headers["x-vyre-presence"])) return presence(res);
        const s = crypto.randomBytes(18).toString("base64url");
        sessions.set(s, Date.now() + 10 * 60_000);
        return json(res, 200, { data: { session: s, expires: sessions.get(s) } });
      }
      if (tool === "vault.session.close") { sessions.delete(String(input.session)); return json(res, 200, { data: { closed: true } }); }
      if (tool === "vault.clipboard.clear") return json(res, 200, { data: { cleared: true } });
      if (tool === "vault.history") {
        const a = (await cli("vault.audit", { name: input.name, limit: 50 })).data?.entries || [];
        const ch = a.filter(e => ["add", "change"].includes(e.action)).reverse();
        return json(res, 200, { data: { versions: ch.map((e, i) => ({ ver: i + 1, at: e.at, by: e.who, fields: i ? ["password"] : [] })).reverse(), passwords: ch.slice(1).map(e => ({ at: e.at })) } });
      }
      if (!liveSession(input.session) && !proof(req.headers["x-vyre-presence"])) return presence(res);
      const v = await valueOf(input.name, input.field);
      if (typeof v !== "string") return json(res, 500, { error: { code: "failed", message: `${input.name} has no field ${input.field}` } });
      if (tool === "vault.copy") return json(res, 200, { data: { copied: true, clearsAt: Date.now() + 90_000 } });
      // vault.reveal: the one response allowed to carry a value, after an explicit click.
      const body = JSON.stringify({ data: { value: v } });
      if (body.includes(CANARY) && !revealAllowed) hits.push("reveal before the Reveal click");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(body);
    }
    // vault.totp for the Deck needs a session (stubbed); the rest are remapped as a person's surface.
    const headers = { ...req.headers };
    if (tool && REMAP.includes(tool) && headers["x-vyre-caller"] === "deck") {
      if (tool === "vault.totp") {
        const input = await readBody(req);
        if (!liveSession(input.session)) return presence(res);
        const r2 = await cli("vault.totp", { name: input.name });
        return json(res, r2.error ? 500 : 200, r2);
      }
      headers["x-vyre-caller"] = "local";
    }
    if (url.pathname === "/v1/tools" && req.method === "GET") {
      const up = await new Promise(ok => http.get({ socketPath: sock, path: "/v1/tools", headers: { "x-vyre-caller": "local" } }, r3 => { let b = ""; r3.on("data", c => (b += c)); r3.on("end", () => ok(JSON.parse(b))); }));
      const names = new Set(up.data.map(t => t.name));
      for (const t of STUB_TOOLS) if (!names.has(t)) up.data.push({ name: t, module: "vault", description: "test stub" });
      return json(res, 200, up);
    }
    const upstream = http.request({ socketPath: sock, path: req.url, method: req.method, headers }, r4 => {
      res.writeHead(r4.statusCode || 502, r4.headers);
      r4.on("data", c => { scan(`${req.method} ${url.pathname}`, c.toString("utf8")); res.write(c); });
      r4.on("end", () => res.end());
    });
    upstream.on("error", e => { res.writeHead(502); res.end(String(e.message)); });
    req.pipe(upstream);
  });
  await new Promise(ok => server.listen(PORT, "127.0.0.1", ok));
  const BASE = `http://localhost:${PORT}`;

  // ---- Chrome over the DevTools protocol ------------------------------------------------------

  profile = fs.mkdtempSync(path.join(os.tmpdir(), "vy-vault-chrome-"));
  const dport = 9400 + Math.floor(Math.random() * 400);
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, "--use-mock-keychain", "--password-store=basic", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${dport}/json`)).json()).find(t => t.type === "page"); } catch {} }
  if (!target) throw new Error("chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = m => {
    const d = JSON.parse(String(m.data));
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map(a => a.value ?? a.description).join(" "));
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise(ok => { const n = ++id; pending.set(n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (js) => {
    const r5 = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const $ = s => document.querySelector(s);
      const click = s => { const el = typeof s === "string" ? $(s) : s; if (!el) throw new Error("no " + s); el.click(); };
      const byText = (sel, t) => [...document.querySelectorAll(sel)].find(e => e.textContent.trim().includes(t));
      const key = (k, extra = {}) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
      ${js}
    })()` });
    if (r5.result?.exceptionDetails) throw new Error("page: " + (r5.result.exceptionDetails.exception?.description || r5.result.exceptionDetails.text));
    return r5.result?.result?.value;
  };
  const size = (w, hh) => send("Emulation.setDeviceMetricsOverride", { width: w, height: hh, deviceScaleFactor: w < 700 ? 2 : 1, mobile: w < 700 });
  const nav = async (u, settle = 1800) => { await send("Page.navigate", { url: BASE + u }); await sleep(settle); };
  const shots = [];
  const shot = async name => {
    await sleep(350);
    const s = await send("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, name + ".png");
    fs.writeFileSync(file, Buffer.from(s.result.data, "base64"));
    shots.push(file);
    await domClean(name);
  };
  const domClean = async where => {
    const found = await ev(`const vals = [...document.querySelectorAll("input,textarea")].map(i => i.value).join("|");
      return (document.documentElement.outerHTML + vals).includes(${JSON.stringify(CANARY)});`);
    if (found) fail(`canary in the DOM at ${where}`);
  };

  await send("Page.enable"); await send("Runtime.enable");
  await send("WebAuthn.enable", { enableUI: false });
  const auth = await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await send("WebAuthn.addCredential", { authenticatorId: auth.result.authenticatorId, credential: { credentialId: credId.toString("base64"), isResidentCredential: false, rpId: "localhost",
    privateKey: cred.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), signCount: 0 } });

  // 1. the list
  await size(1440, 900);
  await nav("/vault");
  await shot("01-list");
  // keyboard: j j moves the cursor, / focuses the filter, typing filters, Esc clears
  const moved = await ev(`key("j"); key("j"); await wait(50); return document.querySelector(".vt-row.cursor")?.dataset.name;`);
  if (!moved) fail("j did not move the cursor");
  const filtered = await ev(`key("/"); await wait(30); const f = $(".vt-filter-in"); if (document.activeElement !== f) return "no focus";
    f.value = "acme"; f.dispatchEvent(new Event("input")); await wait(50); const n = document.querySelectorAll(".vt-row").length;
    f.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await wait(50); return n + "/" + document.querySelectorAll(".vt-row").length;`);
  if (!/^[1-4]\/1[01]$/.test(String(filtered))) fail(`filter and Esc: ${filtered}`);

  // 2. an item
  await ev(`click(byText(".vt-row", "harlow-drive")); await wait(600);`);
  await shot("02-item");

  // 3. unlock with the passkey sheet, then copy: the toast
  await ev(`click(byText(".vt-head button", "Unlock")); await wait(500);`);
  await shot("03a-presence-sheet");
  await ev(`click(byText(".vt-sheet button", "Use passkey")); await wait(1200);`);
  const chip = await ev(`return $(".vt-unlocked")?.textContent || ""`);
  if (!/Unlocked/i.test(chip)) fail(`not unlocked: ${chip}`);
  await ev(`click('[aria-label="Copy Password"]'); await wait(700);`);
  await shot("03-unlocked-copy-toast");

  // 4. reveal (the only time the canary may reach the page), then it goes on blur
  revealAllowed = true;
  const shown = await ev(`click('[aria-label="Reveal Password"]'); await wait(700); return document.body.textContent.includes(${JSON.stringify(CANARY)});`);
  if (!shown) fail("reveal did not show the value");
  const s4 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, "04a-revealed.png"), Buffer.from(s4.result.data, "base64"));
  const gone = await ev(`window.dispatchEvent(new Event("blur")); await wait(100); return !document.documentElement.outerHTML.includes(${JSON.stringify(CANARY)});`);
  if (!gone) fail("the revealed value stayed in the DOM after blur");
  revealAllowed = false;

  // 5. TOTP with the ring, unlocked (in-app navigation keeps the session in memory)
  await ev(`click(byText(".vt-row", "example-mail")); await wait(1200);`);
  const code = await ev(`return $(".vt-code")?.textContent || ""`);
  if (!/^\d{3} \d{3}$/.test(code)) fail(`no TOTP code while unlocked: "${code}"`);
  await shot("05-totp");

  // 6. add a login with the generator; save it, and check vyred made the password
  await ev(`key("n"); await wait(500); const n = $("#vt-e-name"); n.value = "acme-crm"; $("#vt-f-username").value = "alex@acme.test"; $("#vt-e-url").value = "https://crm.acme.test";
    click(byText(".vt-gen-t", "Generate")); await wait(200);`);
  await shot("06-add-login-generator");
  await ev(`click(byText("button[type=submit]", "Seal it")); await wait(1500);`);
  const made = (await cli("vault.list")).data.items.find(i => i.name === "acme-crm");
  if (!made || !made.fields.includes("password")) fail("acme-crm was not saved with a generated password");
  const gpw = (await cli("vault.inject", { items: [{ name: "acme-crm", env: "P", field: "password" }] })).data?.env?.P || "";
  if (gpw.length !== 24) fail(`generated password length ${gpw.length}`);
  if (gpw && (await ev(`return document.documentElement.outerHTML.includes(${JSON.stringify(gpw)})`))) fail("the generated password reached the page");
  // edit never pre-fills: the password shows as Unchanged
  const unchanged = await ev(`key("e"); await wait(400); return [...document.querySelectorAll(".vt-unch-t")].map(e => e.textContent).join(",")`);
  if (!/Unchanged/.test(unchanged)) fail(`edit did not show Unchanged: ${unchanged}`);
  await shot("06b-edit-unchanged");

  // 7. Watchtower
  await ev(`key("Escape"); await wait(200); click(byText(".vt-rail-a", "Watchtower")); await wait(1200);`);
  await shot("07-watchtower");

  // 8. Passes, then the share sheet
  await ev(`click(byText(".vt-rail-a", "Passes")); await wait(700);`);
  await shot("08a-passes");
  await ev(`click(byText("button", "New pass")); await wait(400); $("#vt-s-who").value = "dana"; $("#vt-s-who").dispatchEvent(new Event("input"));
    const box = [...document.querySelectorAll(".vt-check")].find(l => l.textContent.includes("harlow-drive")); box.querySelector("input").click(); await wait(200);`);
  await shot("08-share-sheet");
  await ev(`click(byText(".vt-sheet button", "Sealed")); await wait(150);`);
  await shot("08b-share-sealed");
  await ev(`key("Escape"); await wait(100); click(byText(".vt-rail-a", "Devices")); await wait(700);`);
  await shot("09-devices");

  // 9. help sheet and lock
  await ev(`click(byText(".vt-rail-a", "All items")); await wait(400); key("?"); await wait(300);`);
  await shot("10-help");
  const locked = await ev(`key("Escape"); await wait(100); key("L"); await wait(400); return !$(".vt-unlocked")`);
  if (!locked) fail("L did not lock");

  // 10. phone
  await size(390, 844);
  await nav("/vault");
  await shot("11-phone-list");
  await ev(`click(byText(".vt-row", "example-mail")); await wait(800);`);
  await shot("12-phone-item");
  await ev(`click(".vt-back"); await wait(300); click(byText(".vt-chip", "Watchtower")); await wait(1200);`);
  await shot("13-phone-watchtower");

  // Events: vyred's whole log, through the proxy (so the scan sees it too).
  const evs = await (await fetch(BASE + "/v1/events?since=0&limit=1000")).text();
  if (evs.includes(CANARY)) fail("canary in the event log");
  for (const h of hits) fail(`canary in a response: ${h}`);
  const pageErrors = errors.filter(e => !/favicon|Failed to load resource/.test(e));
  for (const e of pageErrors) fail("page error: " + e);
  console.log(JSON.stringify({ shots, failures }, null, 2));
  ws.close();
} catch (e) {
  fail(String(e && e.stack || e));
} finally {
  await cleanup();
  process.exitCode = failures.length ? 1 : 0;
}
