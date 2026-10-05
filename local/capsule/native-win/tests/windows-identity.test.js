import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const FOUR = ["identity_public", "identity_sign", "enclave_public", "enclave_sign", "agree_public", "agree_secret"]; // the four identity commands and the two agreement ones

test("the main panel is permitted exactly the identity and agreement commands, on https origins, and nothing else", () => {
  const cap = JSON.parse(read("../app/capabilities/main-identity.json"));
  assert.deepEqual(cap.windows, ["main"]);
  assert.deepEqual(cap.permissions, FOUR.map((c) => "allow-" + c.replace(/_/g, "-")));
  assert.deepEqual(cap.remote.urls, ["https://*"]);
  assert.ok(!cap.permissions.some((p) => /core:|shell|fs|opener|notification|pair|drive|autostart|link/.test(p)), "no other permission");
  // the other capabilities stay bundled pages only: none of them names the main window
  for (const f of ["first-run", "link", "settings"]) assert.ok(!JSON.parse(read(`../app/capabilities/${f}.json`)).windows.includes("main"), f);
});

test("the four commands exist, are declared and registered, and each refuses a page that is not the pinned origin before touching a key", () => {
  const rs = read("../app/src/main.rs");
  const build = read("../app/build.rs");
  const handler = /generate_handler!\[([^\]]*)\]/.exec(rs)[1];
  for (const c of FOUR) {
    assert.match(rs, new RegExp(`fn ${c}\\(`));
    assert.ok(build.includes(`"${c}"`), `${c} declared in build.rs`);
    assert.ok(handler.includes(c), `${c} registered`);
    const body = rs.slice(rs.indexOf(`fn ${c}(`), rs.indexOf("\n}\n", rs.indexOf(`fn ${c}(`)));
    assert.match(body, /from_pinned\(&app, &webview\)\?;/, c);
    assert.ok(body.indexOf("from_pinned") < body.search(/identity_seed|ncrypt::/), `${c} checks the origin first`);
  }
  assert.match(rs, /if webview\.label\(\) != "main"/);
  assert.match(rs, /pin\.allows\(url\.as_str\(\)\)/);
});

test("no command returns a seed: the identity commands give a public key or a signature, and the seed is read only inside Rust", () => {
  const rs = read("../app/src/main.rs");
  for (const c of FOUR) {
    const body = rs.slice(rs.indexOf(`fn ${c}(`), rs.indexOf("\n}\n", rs.indexOf(`fn ${c}(`)));
    assert.doesNotMatch(body, /Ok\(b64u\(&?seed|Ok\(b64u\(&?k\)|seed\)\)/, c);
  }
  assert.match(rs, /identity_public[\s\S]*vyre_capsule_win::identity::public_key/);
  assert.match(rs, /identity_sign[\s\S]*vyre_capsule_win::identity::sign/);
  // the seed is DPAPI-protected on disk
  assert.match(rs, /fn identity_seed[\s\S]*protect\(&k, true\)/);
});

test("the page sees a frozen window.__vyreShell of kind windows with the same identity calls as the Mac's, and no presence or menu", () => {
  const rs = read("../app/src/main.rs");
  assert.match(rs, /kind: "windows", boxless: false, version: \{v\}, identity: identity/);
  for (const call of ["identity_public", "identity_sign", "enclave_public", "enclave_sign", "agree_public", "agree_secret"]) assert.match(rs, new RegExp(`inv\\("${call}"`));
  assert.match(rs, /\.initialization_script\(shell_signal\(/);
  assert.doesNotMatch(/function shell_signal[\s\S]*?\}\)\(\);/.exec(rs)?.[0] ?? "", /presence|onCommand|notify/);
});

test("the TPM key is a P-256 key in the Platform Crypto Provider behind a UI policy that forces Windows to ask the person, and a machine with no TPM refuses plainly", () => {
  const nc = read("../app/src/ncrypt.rs");
  assert.match(nc, /Microsoft Platform Crypto Provider/);
  assert.match(nc, /ECDSA_P256/);
  assert.match(nc, /NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG: u32 = 0x2/);
  assert.match(nc, /UI Policy/);
  assert.match(nc, /This computer has no TPM that Vyre can use\./);
  assert.match(nc, /point_from_ecc_blob/);
});
