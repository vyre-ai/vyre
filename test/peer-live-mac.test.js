// A LIVE check of 8cf64fe9's signature reader (core/daemon/peer.js's signatureOf/codeSignature,
// core/presence/module.js's presence.capsule.pin refusal): everything peer.test.js's own
// "presence.capsule.pin is presence-required" test covers with an INJECTED codeSignature, this
// runs against vyred's own real read of `codesign -dvvv +pid` for a real process on the socket.
//
// Off by default. codesign and a throwaway ad-hoc-signed copy of this Node binary are real macOS
// operations; nothing here should run on the testbox (Linux) or in an ordinary CI pass. Set
// VYRE_ALLOW_MAC_TESTS=1 (and, as every Mac test here already must, VYRE_NO_DIALOGS=1) to run it
// on a real Mac.
//
// NOT covered here, and why (capsule-pro, 28 Sep -- surfaced rather than worked around):
// "a real signed build passes" and "a mismatched fingerprint on a signed build is refused" both
// need a throwaway binary signed with a NON-ad-hoc identity. Tried three ways to get codesign to
// accept a fresh self-signed cert without the person's real login keychain: by common name, by
// its SHA-1 hash, and via `security set-identity-preference` -- codesign refuses all three with
// "no identity found" until the cert has Trust Settings. Getting there needs
// `security add-trusted-cert`, which (a) *always* writes the per-user Trust Settings store (the
// `-k <keychain>` flag only says where the CERT is kept, not where the TRUST decision lives --
// confirmed by reading it back with `security dump-trust-settings` after `-k` pointed at a temp
// keychain) and (b) raises a real interactive authorization dialog to do it (confirmed: it hung
// for the OS's own ~3.5s auto-cancel under a non-interactive test runner). Either one is a real
// finding a test must not paper over: production's `vyre capsule install` accepts exactly this
// once, as a disclosed, person-initiated action (capsule-native.js's IDENTITY_QUESTION already
// says "macOS may ask for your password once") -- a test has no such consent to spend, and must
// never leave the person's actual Trust Settings holding a throwaway test certificate regardless.
// Verifying those two cases live needs either a real Apple Developer ID identity set aside for
// CI, or vyre-core's own code-signing key once ADR 0040 lands (docs/adr/0040-vyre-core.md
// section 4: "vyre-core generates and holds its own code-signing key"). Flagged for the lead
// rather than decided here.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { inputHash } from "../core/presence/index.js";

const LIVE = process.platform === "darwin" && process.env.VYRE_ALLOW_MAC_TESTS === "1" && process.env.VYRE_NO_DIALOGS === "1";
const SKIP = LIVE ? false : "set VYRE_ALLOW_MAC_TESTS=1 and VYRE_NO_DIALOGS=1 on a real Mac to run this";

/** cdhash (lower-case hex) from codesign's own stderr (its -dvvv output, whether it exits 0 or
 * not, always lands there -- never stdout: execFileSync's throw-only capture missed this the
 * first time this test ran for real, 28 Sep), the same field vyred's parseCodesign reads. */
function cdhashOf(file) {
  const r = spawnSync("/usr/bin/codesign", ["-dvvv", file], { encoding: "utf8" });
  const m = /^CDHash=([0-9a-f]+)$/m.exec(r.stderr || "");
  if (!m) throw new Error(`no CDHash in codesign -dvvv output for ${file}: ${r.stderr}`);
  return m[1];
}

test("peer (live Mac): an ad-hoc-signed caller's presence.capsule.pin is really refused by vyred's own codesign read", { skip: SKIP, timeout: 30_000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-live-mac-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  // A throwaway copy of this Node binary, ad-hoc signed (no identity at all) -- exactly what
  // `vyre capsule install` produces before the person opts into a stable signing identity
  // (capsule-native.js's AD_HOC_NOTE), and what parseCodesign() reads as { signed: true, adhoc: true }.
  const adhocBin = path.join(scratch, "vyre-live-adhoc");
  fs.copyFileSync(process.execPath, adhocBin);
  fs.chmodSync(adhocBin, 0o755);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "sh.vyre.livemactest", adhocBin]);
  const adhocCdhash = cdhashOf(adhocBin);

  // A dumb HTTP/1.1 client over the unix socket, run BY the throwaway binary being checked (so
  // vyred's own peer read sees that binary's real pid and signature) -- no crypto or Vyre logic
  // of its own, just the raw call and its response on stdout.
  const callerScript = path.join(scratch, "caller.mjs");
  fs.writeFileSync(callerScript, `
    import http from "node:http";
    const [, , socketPath, body, header] = process.argv;
    const req = http.request({ socketPath, path: "/v1/tools/presence.capsule.pin", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-vyre-caller": "capsule", "x-vyre-presence": header } },
      res => { let data = ""; res.on("data", c => (data += c)); res.on("end", () => { process.stdout.write(data); process.exit(0); }); });
    req.on("error", e => { process.stdout.write(JSON.stringify({ error: { code: "conn", message: String(e) } })); process.exit(1); });
    req.write(body); req.end();
  `);

  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const presence = d.registry.deps.presence;

  // The Capsule's own enrolled key: same real crypto this suite already uses elsewhere for this
  // tool (peer.test.js), just driving a real socket call instead of an injected registry.call.
  const ck = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const capsuleKey = presence.enroll({ kind: "capsule", name: "live-mac-test", public_key: ck.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
  const proofFor = cdhash => {
    const input = { cdhash }, ts = Date.now(), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\npresence.capsule.pin\n${inputHash(input)}\n${ts}\n${nonce}`), { key: ck.privateKey, dsaEncoding: "der" }).toString("base64url");
    return `capsule key=${capsuleKey.id} ts=${ts} nonce=${nonce} sig=${sig}`;
  };
  const call = (bin, cdhash) => new Promise((resolve, reject) => execFile(bin, [callerScript, d.paths.socket, JSON.stringify({ cdhash }), proofFor(cdhash)],
    { encoding: "utf8", timeout: 20_000 }, (e, stdout, stderr) => (e ? reject(new Error(`${e.message}\n${stderr}`)) : resolve(JSON.parse(stdout)))));

  const r = await call(adhocBin, adhocCdhash);
  assert.equal(r.error?.code, "denied", JSON.stringify(r));
  assert.match(r.error.message, /ad-hoc signed[\s\S]*vyre capsule install/);
  assert.equal(presence.capsulePin(), null, "an ad-hoc build never gets pinned");
});
