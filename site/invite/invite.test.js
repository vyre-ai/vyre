import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WEB_APP, inviteTarget, tokenOf } from "./target.js";

const here = (p) => new URL(p, import.meta.url);
const read = (p) => fs.readFileSync(here(p), "utf8");
const TOKEN = `inv_${"ab".repeat(16)}.eyJjaGFpbiI6e30`;

test("an invite path becomes the web app's join route with the invite link in the fragment, never in a query", () => {
  const to = inviteTarget(`/i/${TOKEN}`);
  assert.ok(to.startsWith(`${WEB_APP}/join#link=`), to);
  const u = new URL(to);
  assert.equal(u.search, "", "no query string carries the token");
  assert.equal(u.host, "web.vyre.run");
  assert.equal(decodeURIComponent(u.hash.slice("#link=".length)), `https://vyre.run/i/${TOKEN}`, "the web app reads this link from its fragment");
  assert.equal(inviteTarget(`/i/${TOKEN}/`), to, "a trailing slash is the same invite");
});

test("anything that is not an invite path goes nowhere", () => {
  for (const p of ["/i", "/i/", "/i/short", "/i/a b", "/i/../x", `/x/${TOKEN}`, `/i/${TOKEN}/more`, `/i/${"a".repeat(401)}`, "", undefined]) {
    assert.equal(tokenOf(p), null, String(p));
    assert.equal(inviteTarget(p), null, String(p));
  }
});

test("the page loads only its own files, asks for no referrer, is not indexed, and says what to do when the app does not open", () => {
  const html = read("./index.html");
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((u) => /^https?:\/\//.test(u) || u.startsWith("//"));
  assert.deepEqual(refs, ["https://web.vyre.run/"], "the only address on the page is the web app's own");
  assert.match(html, /href="\/mac\/"/);
  assert.match(html, /href="\/windows\/"/);
  assert.match(html, /Nothing was joined/);
  const js = read("./page.js");
  assert.ok(!/localStorage|sessionStorage|document\.cookie|navigator\.sendBeacon|XMLHttpRequest/.test(js), "nothing is stored or sent elsewhere");
  assert.match(js, /fetch\(`\$\{WEB_APP\}\/`, \{ mode: "no-cors"/, "the reachability check names the web app's address and nothing of the invite");
  assert.ok(!/fetch\([^)]*target/.test(js), "the invite link is never a request");
});

test("the site serves /i/<token> as this page with no cache, no referrer and a policy that allows the web app and nothing else", () => {
  const headers = read("../_headers");
  const block = /\n\/i\/\*\n((?:  .+\n)+)/.exec(headers);
  assert.ok(block, "_headers has a /i/* block");
  const csp = /Content-Security-Policy: (.+)/.exec(block[1])[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(?:;|$)/);
  assert.match(csp, /connect-src https:\/\/web\.vyre\.run(?:;|$)/);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp.replace(/;/g, " ")), csp);
  assert.match(block[1], /Referrer-Policy: no-referrer/);
  assert.match(block[1], /Cache-Control: no-store/);
  for (const sh of ["../scripts/assemble-site.sh", "../scripts/build-site.sh"]) {
    const s = fs.readFileSync(new URL(`../../${sh.slice(3)}`, import.meta.url), "utf8");
    assert.match(s, /\/i\/\* \/invite\/ 200/, `${sh} rewrites /i/* to the invite page`);
  }
});
