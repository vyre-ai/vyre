// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { siteTar } from "./site-tar.js";

/** Read the archive back, as a plain ustar reader would. */
function entries(/** @type {Uint8Array} */ tar) {
  const dec = new TextDecoder(), out = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every(b => b === 0)) break;
    const str = (/** @type {number} */ a, /** @type {number} */ n) => dec.decode(h.subarray(a, a + n)).replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12), 8), type = str(156, 1);
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.equal(parseInt(str(148, 8).trim(), 8), sum, "checksum");
    const prefix = str(345, 155);
    out.push({ name: (prefix ? prefix + "/" : "") + str(0, 100), type, mode: parseInt(str(100, 8), 8), uid: parseInt(str(108, 8), 8), size, body: dec.decode(tar.subarray(at + 512, at + 512 + size)) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

test("the archive holds only regular files and their directories, owned by the site's user and read-only", () => {
  const e = entries(siteTar([{ path: "index.html", content: "<h1>x</h1>" }, { path: "assets/css/app.css", content: new Uint8Array([97, 98]) }, { path: "assets/app.js", content: "x".repeat(600) }]));
  assert.deepEqual(e.map(x => [x.name, x.type]), [["index.html", "0"], ["assets/", "5"], ["assets/css/", "5"], ["assets/css/app.css", "0"], ["assets/app.js", "0"]]);
  assert.ok(e.every(x => x.uid === 65532));
  assert.deepEqual(e.filter(x => x.type === "0").map(x => x.mode), [0o444, 0o444, 0o444]);
  assert.equal(e[0].body, "<h1>x</h1>");
  assert.equal(e[4].size, 600);
  assert.ok(e.every(x => x.type === "0" || x.type === "5"), "no link, device or pipe entry can exist");
});

test("a build with a link, a climbing path or a path too long never becomes an archive", () => {
  for (const evil of [{ path: "p", type: "symlink", target: "/etc/passwd", content: "" }, { path: "e", symlink: ".env", content: "" }, { path: "../x", content: "x" }, { path: "/etc/x", content: "x" }]) {
    assert.throws(() => siteTar([{ path: "index.html", content: "x" }, /** @type {any} */ (evil)]), (/** @type {any} */ e) => e.code === "bad_output");
  }
  assert.throws(() => siteTar([{ path: "a".repeat(300), content: "x" }]), (/** @type {any} */ e) => e.code === "bad_output");
  const long = "d".repeat(60) + "/" + "e".repeat(60) + "/" + "f".repeat(40) + ".txt";
  assert.equal(entries(siteTar([{ path: long, content: "ok" }])).at(-1).name, long, "a long path splits into prefix and name");
});
