// @ts-check
// extension tests: background.js runs in a vm with a fake `chrome`, against a real fill listener
// over a real Vault in a temp folder. They check the message policy (who may ask for what, and
// that the page is the browser's word, not the message's) and the HTTP contract of match, fill,
// otp and save. No browser runs; the "page" is whatever executeScript is handed.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { open, migrate } from "../../core/store/index.js";
import { Vault, MIGRATIONS } from "../../core/vault/vault.js";
import { Fill, serveFill } from "../../core/vault/fill.js";
import { build, forBrowser, packageFiles } from "./build.mjs";
import { SCRATCH } from "../../test/scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const canary = () => `fixture-canary-${crypto.randomBytes(12).toString("hex")}`;
const ID = "abcdefghijklmnopabcdefghijklmnop";

/**
 * @param {any} t
 * @param {{ firefox?: boolean }} [o] firefox: background.js sees only a `browser` global and
 *   moz-extension URLs, as in Firefox, with no `chrome` at all.
 */
async function setup(t, { firefox = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(SCRATCH, "vyre-ext-"));
  const db = open(path.join(tmp, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const vault = new Vault({ db, dir: path.join(tmp, "vault"), config: { vault: { keystore: "file" } }, emit: () => {} });
  const pw = canary();
  await vault.put({ name: "example-mail", kind: "login", url: "https://mail.example.com", fields: { username: "alex@example.com", password: pw, totp: "JBSWY3DPEHPK3PXP" } }, "cli");
  const fill = new Fill({ vault });
  const srv = await serveFill({ host: "127.0.0.1", port: 0, fill });
  t.after(async () => { await srv.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  // Pair and unlock over HTTP, as the popup would.
  const post = async (route, body, headers = {}) => (await fetch(`${srv.url}/v1/fill/${route}`, { method: "POST", headers: { "content-type": "application/json", origin: `chrome-extension://${ID}`, ...headers }, body: JSON.stringify(body) })).json();
  const paired = (await post("pair", { code: fill.code({ name: "vm browser" }).code })).data;
  await fill.setUnlockPassphrase({ passphrase: "a long unlock passphrase" });
  const session = (await post("unlock", { passphrase: "a long unlock passphrase" }, { authorization: `Bearer ${paired.token}` })).data;

  // A fake chrome with just what background.js touches.
  const local = { url: srv.url, device: paired.device, token: paired.token, deviceName: paired.name };
  const sess = { session: session.session, expires: session.expires };
  const injected = [];
  let listener = null, command = null;
  const store = obj => ({
    get: async keys => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]])),
    set: async v => { Object.assign(obj, v); }, remove: async keys => { for (const k of keys) delete obj[k]; },
    setAccessLevel: () => {},
  });
  const chrome = {
    runtime: { id: ID, getURL: p => `${firefox ? "moz-extension" : "chrome-extension"}://${ID}/${p}`, onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: store(local), session: store(sess) },
    tabs: { query: async () => [{ id: 7, url: "https://mail.example.com/login" }], onRemoved: { addListener: () => {} }, sendMessage: async () => {} },
    commands: { onCommand: { addListener: fn => { command = fn; } } },
    scripting: {
      executeScript: async ({ target, func, args, files }) => { if (files) return []; injected.push({ target, fn: args[0], arg: args[1] }); return [{ result: { filled: ["password"] } }]; },
      getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {},
    },
    permissions: { contains: async () => true },
  };
  if (firefox) delete /** @type {any} */ (chrome.storage.session).setAccessLevel;
  vm.runInNewContext(fs.readFileSync(path.join(HERE, "background.js"), "utf8"), { ...(firefox ? { browser: chrome } : { chrome }), fetch, URL, Date, console, setTimeout });
  /** Send one message as `sender`; resolve with the reply. */
  // Replies are made in the vm's realm; a JSON round trip gives plain objects to compare.
  const send = (msg, sender) => new Promise(resolve => { listener(msg, sender, r => resolve(JSON.parse(JSON.stringify(r)))); });
  const page = (url, frameId = 0, tab = 7) => ({ id: ID, tab: { id: tab, url }, frameId, origin: new URL(url).origin, url });
  const popup = { id: ID, url: `${firefox ? "moz-extension" : "chrome-extension"}://${ID}/popup.html` };
  return { vault, send, page, popup, injected, pw, command: () => command };
}

test("content scripts get names, fills and codes for their own page only", async t => {
  const { send, page, injected, pw } = await setup(t);
  const m = await send({ type: "inline-match" }, page("https://mail.example.com/login"));
  assert.deepEqual(m, { data: { logins: [{ name: "example-mail" }] } });
  assert.deepEqual((await send({ type: "inline-match" }, page("https://other.example.org/"))).data.logins, []);

  const f = await send({ type: "inline-fill", name: "example-mail" }, page("https://mail.example.com/login"));
  assert.deepEqual(f.data.filled, ["password"]);
  assert.equal(injected[0].fn, "vyreFill");
  assert.equal(injected[0].arg.password, pw, "the value goes to the page's top frame");
  assert.deepEqual(JSON.parse(JSON.stringify(injected[0].target)), { tabId: 7, frameIds: [0] });

  // A lookalike page asking for the real site's login by name is refused by vyred.
  const evil = await send({ type: "inline-fill", name: "example-mail", url: "https://mail.example.com" }, page("https://mail.example.com.evil.test/"));
  assert.equal(evil.error.code, "wrong_origin");
  assert.equal(injected.length, 1);

  const o = await send({ type: "inline-otp", name: "example-mail" }, page("https://mail.example.com/2fa"));
  assert.deepEqual(o.data.filled, ["password"]);
  assert.equal(injected[1].fn, "vyreFillOtp");
  assert.match(injected[1].arg.code, /^\d{6}$/);

  for (const [msg, sender] of [
    [{ type: "inline-fill", name: "example-mail" }, page("https://mail.example.com/login", 3)],
    [{ type: "fill", name: "example-mail" }, page("https://mail.example.com/login")],
    [{ type: "inline-fill", name: "example-mail" }, { ...page("https://mail.example.com/login"), id: "another-extension" }],
    [{ type: "state" }, page("https://mail.example.com/login")],
  ]) assert.equal((await send(msg, sender)).error.code, "refused", JSON.stringify(msg));
});

test("save on submit: held in memory, offered on the same origin only, saved on the person's click", async t => {
  const { vault, send, page } = await setup(t);
  const pw = canary();
  const signin = page("https://shop.example.org/signin");
  assert.deepEqual((await send({ type: "inline-offer-save", username: "dana@example.org", password: pw }, signin)).data, { held: true });
  assert.equal((await send({ type: "inline-pending" }, page("https://elsewhere.example.net/"))).data.pending, null, "never offered on another site");
  const p = (await send({ type: "inline-pending" }, page("https://shop.example.org/account"))).data.pending;
  assert.deepEqual(p, { host: "shop.example.org", username: "dana@example.org", change: false });
  assert.ok(!JSON.stringify(p).includes(pw));

  const s = await send({ type: "inline-save" }, page("https://shop.example.org/account"));
  assert.deepEqual(s.data, { name: "shop.example.org", created: true, updated: false });
  assert.deepEqual(JSON.parse(vault.row("shop.example.org").hosts), ["https://shop.example.org"]);
  assert.equal((await vault.fields(vault.row("shop.example.org"))).password, pw);
  assert.equal((await send({ type: "inline-save" }, signin)).error.code, "expired", "a save happens once");

  // A changed password updates the login and keeps the old one in history.
  const next = canary();
  await send({ type: "inline-offer-save", username: "dana@example.org", password: next, change: true }, signin);
  assert.equal((await send({ type: "inline-save" }, signin)).data.updated, true);
  const f = await vault.fields(vault.row("shop.example.org"));
  assert.equal(f.password, next);
  assert.equal(JSON.parse(f.history)[0].password, pw);
});

test("the keyboard command fills the only login for the active tab", async t => {
  const { command, injected } = await setup(t);
  await command()("fill-login");
  assert.equal(injected.length, 1);
  assert.equal(injected[0].fn, "vyreFill");
  await command()("something-else");
  assert.equal(injected.length, 1);
});

test("the manifest and scripts keep their promises", () => {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
  assert.ok(m.commands["fill-login"]);
  assert.ok(!m.content_scripts, "no content script on every page unless the person turns suggestions on");
  assert.ok(!m.host_permissions.some(h => /\*:\/\/\*|https:\/\/\*\/|<all_urls>/.test(h)), "page access is optional, never granted up front");
  const inline = fs.readFileSync(path.join(HERE, "inline.js"), "utf8");
  assert.match(inline, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(inline, /if \(!e\.isTrusted\) return;/);
  assert.ok(!/innerHTML/.test(inline), "text only, never markup from a page or vyred");
});

// ---- Firefox -------------------------------------------------------------------------------

test("Firefox: background.js runs on `browser` alone, with moz-extension URLs, and fills the same", async t => {
  const { send, page, popup, injected, command } = await setup(t, { firefox: true });
  const st = await send({ type: "state" }, popup);
  assert.equal(st.data.paired, true);
  assert.equal(st.data.unlocked, true);
  const f = await send({ type: "inline-fill", name: "example-mail" }, page("https://mail.example.com/login"));
  assert.deepEqual(f.data.filled, ["password"]);
  assert.equal(injected[0].fn, "vyreFill");
  await command()("fill-login");
  assert.equal(injected.length, 2);
  assert.equal((await send({ type: "state" }, { id: ID, url: `chrome-extension://${ID}/popup.html` })).error.code, "refused",
    "a popup URL from the other browser's scheme is not this extension's popup");
});

test("background.js makes no bare chrome.* call: everything goes through the one namespace", () => {
  const code = fs.readFileSync(path.join(HERE, "background.js"), "utf8").split("\n")
    .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /\bchrome\./, "use ext.*, which is browser in Firefox and chrome elsewhere");
  assert.match(code, /globalThis\)\.browser \?\? \/\*\* @type \{any\} \*\/ \(globalThis\)\.chrome/);
  // The one call Firefox lacks is looked up before it is made.
  assert.match(code, /typeof set === "function"/);
});

test("one manifest loads in Chrome and Firefox; the build writes a clean one for each", () => {
  const src = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
  assert.equal(src.background.service_worker, "background.js");
  assert.deepEqual(src.background.scripts, ["background.js"]);
  assert.equal(src.browser_specific_settings.gecko.id, "vault@vyre.sh");
  assert.equal(src.browser_specific_settings.gecko.strict_min_version, "121.0");

  const chrome = forBrowser(src, "chrome"), firefox = forBrowser(src, "firefox");
  assert.deepEqual(chrome.background, { service_worker: "background.js" });
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.deepEqual(firefox.background, { scripts: ["background.js"] }, "Firefox MV3 has no service_worker: an event page");
  assert.equal(firefox.browser_specific_settings.gecko.id, "vault@vyre.sh");
  assert.equal(firefox.minimum_chrome_version, undefined);
  for (const k of ["manifest_version", "permissions", "host_permissions", "optional_host_permissions", "content_security_policy", "commands", "action", "version"])
    assert.deepEqual(firefox[k], chrome[k], `${k} is the same in both`);
  assert.equal(firefox.manifest_version, 3);
  assert.deepEqual([...firefox.permissions].sort(), ["activeTab", "scripting", "storage"]);
  assert.ok(!firefox.content_scripts);
  assert.throws(() => forBrowser({ ...src, browser_specific_settings: undefined }, "firefox"), /gecko id/);

  // No remote code: scripts only from the package, and no script, style or fetch of a remote URL.
  const csp = firefox.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-|script-src[^;]*https?:/);
  const html = fs.readFileSync(path.join(HERE, "popup.html"), "utf8");
  assert.doesNotMatch(html, /<script[^>]+src="(https?:)?\/\//);
  assert.doesNotMatch(html, /<link[^>]+href="(https?:)?\/\//);
  for (const f of packageFiles().filter(x => x.endsWith(".js"))) {
    const js = fs.readFileSync(path.join(HERE, f), "utf8");
    assert.doesNotMatch(js, /\beval\(|new Function\(|importScripts\(|\bimport\(/, f);
    assert.doesNotMatch(js, /(src|href)\s*=\s*["'`]https?:/, f);
  }
});

test("build.mjs writes dist/chrome and dist/firefox with every file the manifests name", () => {
  const out = fs.mkdtempSync(path.join(SCRATCH, "vyre-ext-dist-"));
  try {
    const dirs = build(out);
    for (const [target, d] of Object.entries(dirs)) {
      const m = JSON.parse(fs.readFileSync(path.join(d, "manifest.json"), "utf8"));
      const named = [m.action.default_popup, ...(m.background.scripts || [m.background.service_worker]), "fill.js", "inline.js", "popup.js", "popup.css"];
      for (const f of named) assert.ok(fs.existsSync(path.join(d, f)), `${target}: ${f}`);
      assert.ok(!fs.existsSync(path.join(d, "extension.test.js")), `${target}: no tests in the package`);
      assert.ok(!fs.existsSync(path.join(d, "build.mjs")), `${target}: no build script in the package`);
      assert.equal(fs.readFileSync(path.join(d, "background.js"), "utf8"), fs.readFileSync(path.join(HERE, "background.js"), "utf8"), "a plain copy");
    }
    assert.ok(JSON.parse(fs.readFileSync(path.join(dirs.firefox, "manifest.json"), "utf8")).browser_specific_settings.gecko.id);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
