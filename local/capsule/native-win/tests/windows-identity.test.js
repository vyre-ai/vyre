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
    assert.match(body, /from_pinned\(&app, &webview, &request\)\?;/, c);
    assert.ok(body.indexOf("from_pinned") < body.search(/identity_seed|ncrypt::/), `${c} checks the origin first`);
  }
  assert.match(rs, /if webview\.label\(\) != "main"/);
  // the frame that made the call, not only the top-level page: a cross-origin iframe inside the pinned page carries its own Origin and is refused
  assert.match(rs, /request\.headers\(\)\.get\("origin"\)/);
  assert.match(rs, /if !pin\.is_origin\(origin\) \{ return Err/);
  assert.match(readFileSync(new URL("../src/shell.rs", import.meta.url), "utf8"), /fn only_the_pinned_origin_itself_is_the_caller_a_frame_inside_it_is_not/);
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
  assert.match(rs, /kind: "windows", boxless: \{boxless\}, version: \{v\}, identity: identity/);
  for (const call of ["identity_public", "identity_sign", "enclave_public", "enclave_sign", "agree_public", "agree_secret"]) assert.match(rs, new RegExp(`inv\\("${call}"`));
  assert.match(rs, /\.initialization_script\(shell_signal\(/);
  for (const call of ["identity_has", "identity_forget"]) assert.match(rs, new RegExp(`inv\\("${call}"`));
  assert.doesNotMatch(/function shell_signal[\s\S]*?\}\)\(\);/.exec(rs)?.[0] ?? "", /presence|onCommand|notify/);
});

test("the TPM key is a P-256 key in the Platform Crypto Provider behind a UI policy that forces Windows to ask the person, and a machine with no TPM refuses plainly", () => {
  const nc = read("../app/src/ncrypt.rs");
  assert.match(nc, /Microsoft Platform Crypto Provider/);
  assert.match(nc, /ECDSA_P256/);
  assert.match(nc, /NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG: u32 = 0x2/);
  assert.match(nc, /UI Policy/);
  assert.match(nc, /NOT PROVEN/, "the comment does not claim a Hello prompt that nobody has seen");
  assert.match(nc, /This computer has no TPM that Vyre can use\./);
  assert.match(nc, /point_from_ecc_blob/);
});

test("the Windows app is a client only in 0.2.9: it starts no vyred and offers no home, and its setup page says so (the user's ruling)", () => {
  const rs = read("../app/src/main.rs");
  assert.ok(!/vyred(\.exe)?"|Command::new\([^)]*vyred/i.test(rs), "the app never starts a vyred");
  assert.ok(!/make_server|makeServer|setup\.server/.test(rs + read("../src/shell.rs")), "no make-this-PC-a-home command");
  const bridge = /fn shell_signal[\s\S]*?\n}\n/.exec(rs)[0];
  assert.ok(!/makeServer|boxless: true/.test(bridge), "the page is not offered a home on this PC");
  // One setup (spec part 10): Windows offers Join a team or Add a server after the identity, and no My Home. The window is not a Mac window, so deviceKind never gives it the Mac's home path.
  const flow = readFileSync(new URL("../../../../apps/app/screens/install/first-run.js", import.meta.url), "utf8");
  assert.match(flow, /return macShell \? "mac" : "web"/);
});

test("the TPM key signs only bytes the shell can summarise, behind the shell's own native confirmation, and never shows the page's caption (KP-3)", () => {
  const rs = read("../app/src/main.rs");
  const body = /fn enclave_sign\([\s\S]*?\n}\n/.exec(rs)[0];
  assert.match(body, /chain_summary\(&m\)\.ok_or_else/, "no summary, no signature");
  assert.match(body, /confirm_native\(&said\)/);
  assert.ok(body.indexOf("confirm_native") < body.indexOf("ncrypt::sign"), "the person says yes before the key signs");
  assert.ok(!/confirm_native\([^)]*prompt/.test(body), "the page's prompt is not what is shown");
  assert.match(rs, /MessageBoxW/);
  assert.match(read("../src/identity.rs"), /pub fn chain_summary/);
});

test("the typed code is on in a release build, on Windows too: only VYRE_TYPED_CODE=0 at compile time turns it off (the user's ruling of 5 Oct)", () => {
  const rs = read("../app/src/main.rs");
  assert.match(rs, /const TYPED_CODE: bool = !env_is_zero\(option_env!\("VYRE_TYPED_CODE"\)\);/, "on unless the build says exactly 0");
  const cmd = /async fn finish_typed_pair\([\s\S]*?\n}\n/.exec(rs)[0];
  assert.ok(cmd.indexOf("if !TYPED_CODE") > -1 && cmd.indexOf("if !TYPED_CODE") < cmd.indexOf("pin_from_offer"), "the command refuses only when the build turned it off");
  assert.match(rs, /StateOut \{ typed_code: TYPED_CODE,/, "the page is told");
  const html = read("../app/ui/first-run.html");
  assert.match(html, /<section id="typed">/, "the typed path shows by default");
  assert.ok(!/<section id="typed" hidden>/.test(html));
  assert.match(read("../app/ui/first-run.js"), /s\.typed_code === false\) document\.getElementById\("typed"\)\.hidden = true/, "hidden only when the shell says it was built off");
  const wf = readFileSync(new URL("../../../../.github/workflows/capsule-win.yml", import.meta.url), "utf8");
  assert.ok(!/VYRE_TYPED_CODE\s*[:=]\s*["']?0/.test(wf), "no workflow sets it to 0");
});

test("the bundled app page (its own origin, served by the shell) gets the identity commands too, and only from itself", () => {
  const cap = JSON.parse(read("../app/capabilities/main-identity-bundled.json"));
  assert.deepEqual(cap.windows, ["main"]);
  assert.deepEqual(cap.remote.urls, ["https://vyreapp.localhost/*"]);
  assert.deepEqual(cap.permissions, [...FOUR.slice(0, 2), "identity_has", "identity_forget", "setup_finished", ...FOUR.slice(2)].map((c) => "allow-" + c.replace(/_/g, "-")));
  assert.ok(!cap.permissions.some((p) => /core:|shell|fs|opener|notification|pair|drive|autostart|link/.test(p)), "no other permission");
  const rs = read("../app/src/main.rs");
  const build = read("../app/build.rs");
  const handler = /generate_handler!\[([^\]]*)\]/.exec(rs)[1];
  for (const c of ["identity_has", "identity_forget", "setup_finished"]) {
    assert.ok(build.includes(`"${c}"`) && handler.includes(c), c);
    const body = rs.slice(rs.indexOf(`fn ${c}(`), rs.indexOf("\n}\n", rs.indexOf(`fn ${c}(`)));
    assert.match(body, /from_pinned\(&app, &webview, &request\)\?;/, c);
  }
  // both the top-level page and the calling frame must be exactly the bundled origin
  assert.match(rs, /bundled::is_page\(u\.as_str\(\)\)\) && bundled::is_origin\(frame\)/);
  assert.match(read("../src/bundled.rs"), /pub const ORIGIN: &str = "https:\/\/vyreapp\.localhost";/);
});

test("every key failure is written to the app log with its real reason, and the page is given the same words", () => {
  const rs = read("../app/src/main.rs");
  assert.match(rs, /applog::path\(std::env::var\("LOCALAPPDATA"\)/);
  for (const c of ["enclave_public", "enclave_sign", "agree_public", "agree_secret"]) assert.match(rs, new RegExp(`logged\\("${c}", ncrypt::`), c);
  assert.match(rs, /log\("fail", "identity_seed", e\)/);
});

test("one origin and one first run: the window is always the bundled app, a build without the web build fails, and setup_finished is the one signal for starting hidden", () => {
  const rs = read("../app/src/main.rs");
  const panel = /fn show_panel\([\s\S]*?\n}\n/.exec(rs)[0];
  assert.match(panel, /show_app\(app, path\)/);
  assert.ok(!/pinned\(|url_for|navigate/.test(panel), "the window is never sent to the server's own page");
  assert.match(/fn show_first_run\([\s\S]*?\n}\n/.exec(rs)[0], /show_app\(app, ""\)/);
  assert.match(rs, /if !setup_done\(&handle\) \{ show_first_run/);
  assert.match(read("../app/build.rs"), /app-web\/index\.html is missing/);
  assert.match(readFileSync(new URL("../../../../.github/workflows/capsule-win.yml", import.meta.url), "utf8"), /name: win-web-app\n\s+path: local\/capsule\/native-win\/app\/app-web/);
});
