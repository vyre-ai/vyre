// @ts-check
// The pre-app pages (web/): served by the box in both modes, from their own folder, never the Deck's shell.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start, serveWeb } from "./index.js";
import { tempHome } from "../../test/helpers.js";
import { paths } from "../config/index.js";

/** A response that keeps what it was given. */
function res() {
  const r = { status: 0, headers: /** @type {Record<string, string>} */ ({}), body: "", writeHead(/** @type {number} */ s, /** @type {Record<string, string>} */ h) { r.status = s; r.headers = h; }, end(/** @type {Buffer|string} */ b) { r.body = String(b); } };
  return r;
}
const get = (/** @type {string} */ p) => { const r = res(); const hit = serveWeb(r, p, {}); return { hit, r }; };

test("web: the pre-app pages are answered from web/ with the Deck's headers", () => {
  for (const [p, needle] of [["/onboard", "onboard.js"], ["/onboard/", "onboard.js"], ["/onboard/passkey", "passkey.js"], ["/onboard/device", "device.js"], ["/person/signin", "signin.js"]]) {
    const { hit, r } = get(p);
    assert.equal(hit, true, p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers["content-type"], /text\/html/, p);
    assert.ok(r.body.includes(needle), `${p} loads ${needle}`);
    assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/, p);
  }
});

test("web: the code, styles and fonts the pages load come from web/ too", () => {
  for (const [p, type] of [["/onboard/onboard.js", "javascript"], ["/js/api.js", "javascript"], ["/css/tokens.css", "text/css"], ["/fonts/instrument-sans-latin.woff2", "font/woff2"], ["/vendor/qrcode.js", "javascript"], ["/icon.svg", "svg"]]) {
    const { hit, r } = get(p);
    assert.equal(hit, true, p);
    assert.match(r.headers["content-type"], new RegExp(type), p);
  }
});

test("web: what web/ does not hold is not claimed (the Deck or the app answers), and nothing escapes web/", () => {
  for (const p of ["/js/app.js", "/views/now.js", "/onboard/nothing.js", "/", "/u/now", "/../deck/index.html", "/%2e%2e/package.json", "/onboard/%2e%2e/%2e%2e/package.json", "/%zz", "/test/fake-dom.js", "/fixtures/onboard.json", "/js/api.test.js"]) assert.equal(get(p).hit, false, p);
});

for (const root of [false, true]) {
  test(`web: over the box's own socket every pre-app address answers, with app.root ${root}`, async t => {
    const home = tempHome(t);
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ transcripts: [], ...(root ? { app: { root: true } } : {}) }));
    const d = await start({ root: home, log: () => {} });
    t.after(() => d.stop());
    const hit = (/** @type {string} */ p) => new Promise((resolve, reject) => {
      http.get({ socketPath: paths(home).socket, path: p }, r => { let b = ""; r.on("data", c => { b += c; }); r.on("end", () => resolve({ status: r.statusCode, type: r.headers["content-type"], body: b })); }).on("error", reject);
    });
    for (const [p, needle] of [["/onboard", "/onboard/onboard.js"], ["/onboard/passkey", "/onboard/passkey/passkey.js"], ["/onboard/device", "/onboard/device/device.js"], ["/person/signin", "/person/signin/signin.js"], ["/onboard/onboard.js", "import {"], ["/js/api.js", "export"], ["/css/tokens.css", "--"]]) {
      const r = /** @type {any} */ (await hit(p));
      assert.equal(r.status, 200, p);
      assert.ok(r.body.includes(needle), `${p} holds ${needle}`);
    }
    assert.equal(/** @type {any} */ (await hit("/fixtures/onboard.json")).status, 404, "sample data is never served");
  });
}
