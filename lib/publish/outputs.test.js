// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { checkOutputFiles } from "./outputs.js";

const refused = (/** @type {any[]} */ files, /** @type {RegExp} */ re) => assert.throws(() => checkOutputFiles(files), (/** @type {any} */ e) => e.code === "bad_output" && re.test(e.message), JSON.stringify(files).slice(0, 80));

test("a build's site files: regular files by plain relative paths are accepted", () => {
  checkOutputFiles([{ path: "index.html", content: "<h1>x</h1>" }, { path: "assets/app.js", content: new Uint8Array([1, 2]) }, { path: "a/b/c.css", content: "", mode: 0o100644 }, { path: ".well-known/security.txt", content: "x" }]);
});

test("a link of any kind is refused, whatever it points at (PB-1)", () => {
  refused([{ path: "index.html", content: "x" }, { path: "passwd", type: "symlink", target: "/etc/passwd" }], /only regular files/);
  refused([{ path: "env.txt", symlink: ".env", content: "" }], /is a link/);
  refused([{ path: "git", link: "sub/.git/config", content: "" }], /is a link/);
  refused([{ path: "s", target: "/run/secrets/STRIPE_KEY", content: "" }], /is a link/);
  refused([{ path: "h", type: "hardlink", content: "" }], /only regular files/);
  refused([{ path: "d", type: "device", content: "" }, ], /only regular files/);
  refused([{ path: "f", content: "", mode: 0o120777 }], /not a regular file/);
  refused([{ path: "f", content: "", mode: 0o010644 }], /not a regular file/);
});

test("paths that climb out, start at the root, repeat or are not plain are refused", () => {
  for (const p of ["../x", "a/../../x", "/etc/passwd", "a//b", "./a", "a/./b", "C:/x", "a\\b", "a\u0000b", "", "x/".padEnd(2000, "x")]) refused([{ path: p, content: "x" }], /path|has no path/);
  refused([{ path: "a.html", content: "x" }, { path: "A.HTML", content: "y" }], /twice/);
  refused([{ path: "a.html" }], /no content/);
});

test("a file and a folder of one name, and Unicode twins, are refused", () => {
  refused([{ path: "a", content: "x" }, { path: "a/b", content: "y" }], /inside another build file/);
  refused([{ path: "a/b", content: "y" }, { path: "a", content: "x" }], /inside another build file/);
  refused([{ path: "caf\u00e9.html", content: "1" }, { path: "cafe\u0301.html", content: "2" }], /twice/);
});
