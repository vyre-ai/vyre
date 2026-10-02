// @ts-check
// relay/wink: the camera page's release. A throwaway key, never the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keygen, verify } from "../app/release.js";
import { build, closure, specifiers, ENTRY, STYLE } from "./release.js";
import { CSP, CSP_BODY, HEADERS } from "./headers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wink-"));

test("specifiers: static, dynamic and new URL() imports, relative only", () => {
  const src = `import a from "./a.js";\nimport { b } from "../b.js";\nimport "./side.js";\nexport * from "./re.js";\nconst x = await import("./lazy.js");\nconst w = new Worker(new URL("./w.js", import.meta.url), { type: "module" });\nimport z from "node:fs";`;
  assert.deepEqual(specifiers(src).sort(), ["../b.js", "./a.js", "./lazy.js", "./re.js", "./side.js", "./w.js"]);
});

test("the page loads the scanner, the relay client and the haptics, and never the Deck's API client, router or avatars", () => {
  const files = closure();
  for (const f of ["deck/js/scan.js", "deck/js/scan-worker.js", "deck/js/pair-ticket.js", "deck/js/haptics.js", "relay/client/client.js", "deck/vyrecode/decode-core2.js", "relay/wink/page.js", "relay/wink/flow.js", ENTRY]) assert.ok(files.includes(f), f);
  assert.ok(!files.includes("deck/js/avatars.js") && !files.includes("deck/js/pair-scan.js"), "no avatar renderer, no Deck sheet: the card has no picture");
  assert.ok(!files.includes("deck/js/api.js"), "no Deck API client: the page has no box to call");
  assert.ok(!files.some(f => f === "deck/js/app.js" || f.startsWith("deck/views/") && f !== "deck/views/pair-scan.js"), "no Deck shell or view");
});

test("build: sealed, every folder verifies, the entry is pinned by SRI, no inline script, the worker carries the key", async () => {
  const dir = tmp(), key = path.join(dir, "release.key");
  const pub = keygen(key);
  const out = path.join(dir, "out");
  const r = await build({ release: "0.2.0", key, out });
  assert.ok(r.files > 15);
  const manifest = await verify(out, new Uint8Array(Buffer.from(pub, "base64url")));
  assert.equal(manifest, r.manifest);
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.doesNotMatch(html, /\{\{/);
  assert.match(html, /src="\/relay\/wink\/wink.js" integrity="sha384-/);
  assert.match(html, /href="\/relay\/wink\/wink.css" integrity="sha384-/);
  assert.doesNotMatch(html, /<script>|<style>|style="|onclick=/, "the CSP allows no inline script or style");
  assert.doesNotMatch(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""), /https?:\/\/(?!vyre\.run)/, "nothing third party");
  assert.ok(html.includes(`content="${CSP_BODY}"`), "the page carries the same CSP as the header, minus frame-ancestors");
  assert.ok(fs.readFileSync(path.join(out, "sw.js"), "utf8").includes(`"${pub}"`));
  const m = JSON.parse(fs.readFileSync(path.join(out, "release-manifest.json"), "utf8"));
  assert.deepEqual(m.entry, [ENTRY, STYLE]);
  // Every relative import of every sealed script is a file in the sealed tree.
  for (const f of Object.keys(m.files).filter(f => /\.js$/.test(f))) {
    for (const s of specifiers(fs.readFileSync(path.join(out, f), "utf8"))) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(f), s));
      assert.ok(m.files[next], `${f} imports ${s}, which is not sealed`);
    }
  }
  // A changed file after sealing fails verification.
  fs.appendFileSync(path.join(out, "deck/js/scan.js"), "evil()");
  await assert.rejects(verify(out, new Uint8Array(Buffer.from(pub, "base64url"))), /does not match/);
});

test("the page makes no request but the relay's and keeps nothing: no storage, no cookie, no fetch of its own, in any file it loads except the device-key store the relay client owns", () => {
  const files = closure().filter(f => f.startsWith("relay/wink/") || f === "deck/js/scan.js" || f === "deck/js/haptics.js");
  for (const f of files) {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "..", f), "utf8");
    // haptics.js reads a person's own opt-out (localStorage vyre.haptics) and writes nothing; the tests use no real storage.
    const bad = f === "deck/js/haptics.js" ? /sessionStorage|indexedDB|document\.cookie|fetch\(|setItem/ : /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(/;
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""), bad, f);
  }
});

test("scripts/build-wink-out: the real path (a PEM key from the environment, not --throwaway) seals; a key that is not the pinned one, a prerelease and no key are refused", async () => {
  const { buildWinkOut } = await import("../../scripts/build-wink-out.mjs");
  const crypto = await import("node:crypto");
  const k = crypto.generateKeyPairSync("ed25519");
  const pem = k.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const spki = k.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const out = path.join(tmp(), "wink-out");
  const r = await buildWinkOut({ release: "0.2.0", out, pem, pinned: spki });
  assert.equal(r.throwaway, false);
  assert.ok(fs.existsSync(path.join(out, "index.html")) && fs.existsSync(path.join(out, "sw.js")));
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await assert.rejects(buildWinkOut({ release: "0.2.0", out: path.join(tmp(), "o2"), pem, pinned: other }), /not the pinned release key/);
  await assert.rejects(buildWinkOut({ release: "0.2.0", out: path.join(tmp(), "o3"), pem }), /not the pinned release key/);
  await assert.rejects(buildWinkOut({ release: "0.2.0-rc.1", out: path.join(tmp(), "o4"), pem, pinned: spki }), /plain x\.y\.z/);
  await assert.rejects(buildWinkOut({ release: "0.2.0", out: path.join(tmp(), "o5") }), /no signing key/);
  const t = await buildWinkOut({ release: "0.2.0", out: path.join(tmp(), "o6"), throwaway: true });
  assert.equal(t.throwaway, true);
});

test("headers: no framing, no inline, no third party, camera for this origin only, no referrer, the relay as the only connection", () => {
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.match(CSP, /default-src 'none'/);
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.match(CSP, /connect-src https:\/\/relay\.vyre\.run wss:\/\/relay\.vyre\.run(;|$)/);
  assert.doesNotMatch(CSP, /unsafe-inline|unsafe-eval|\*/);
  assert.equal(CSP_BODY.includes("frame-ancestors"), false, "a meta CSP cannot carry it; the header does");
  assert.equal(HEADERS["x-frame-options"], "DENY");
  assert.match(HEADERS["permissions-policy"], /camera=\(self\)/);
  assert.equal(HEADERS["referrer-policy"], "no-referrer");
  assert.equal(HEADERS["content-security-policy"], CSP);
});
