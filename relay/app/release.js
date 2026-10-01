#!/usr/bin/env node
// @ts-check
// release: turns the web app's build into what app.vyre.run serves (ADR 0026 section 10, ADR 0027
// section 4). No dependencies.
//
//   node relay/app/release.js keygen <file>                   an Ed25519 release key (0600) and <file>.pub
//   node relay/app/release.js build <dist> --release 0.4.2 [--key <file>] [--out <dir>]
//        copies the build into <out>/v/<sha>/ with its signed manifest, and prints the line the
//        box's core/relay/releases.json gets
//   node relay/app/release.js loader [--key <file>] [--out <dir>] --release 0.4.2
//        writes the fixed loader (index.html, the loader and relay client modules, sw.js with the
//        public key stamped in) and its own signed manifest, which the service worker checks
//   node relay/app/release.js verify <folder> --pub <file>    signature and every file's hash
//
// The key defaults to $VYRE_RELEASE_KEY and never lives in the repo. <out> defaults to ./app-out.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildManifest, signManifest, verifyManifest, sha256Hex, folderOf, sri, MANIFEST, SIGNATURE } from "./manifest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
/** The loader's own files: the page, its module and the device client it imports. */
export const LOADER_FILES = ["index.html", "loader.js", "loader.css", "manifest.js",
  ...["bytes.js", "channel.js", "client.js", "noise.js", "paths.js", "response.js", "sse.js", "webcrypto.js"].map(f => `client/${f}`)];

/** @param {string} dir @returns {Record<string, Uint8Array>} relative path -> bytes */
export function readTree(dir) {
  /** @type {Record<string, Uint8Array>} */
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(dir, p).split(path.sep).join("/")] = new Uint8Array(fs.readFileSync(p));
    }
  })(dir);
  return out;
}

/**
 * The entry scripts and styles the build's index.html loads, in order, as the keys of `files`. An export
 * built with a base URL (apps/app sets experiments.baseUrl "/app") writes `/app/_expo/static/js/...` in its
 * index.html while the files are keyed `_expo/static/js/...`: leading folders are stripped until the path is
 * one of the build's own files.
 */
export function entriesOf(html, files) {
  const out = [];
  for (const m of String(html).matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="\/?([^"?#]+)"/g)) {
    let p = m[1];
    while (!(p in files) && p.includes("/")) p = p.slice(p.indexOf("/") + 1);
    if (p in files && /\.(m?js|css)$/.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The raw 32-byte Ed25519 seed of a key given as a file of those bytes, or as a PKCS8 PEM (the release
 * environment's secret, which a workflow passes in an environment variable and never writes to disk).
 * @param {string} fileOrPem @returns {Buffer}
 */
export function rawKey(fileOrPem) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(fileOrPem)) {
    const k = crypto.createPrivateKey(fileOrPem);
    if (k.asymmetricKeyType !== "ed25519") throw new Error("the key is not an Ed25519 key");
    return Buffer.from(k.export({ format: "der", type: "pkcs8" }).subarray(-32));
  }
  const raw = fs.readFileSync(fileOrPem);
  if (raw.length !== 32) throw new Error(`${fileOrPem} is not a raw 32-byte Ed25519 key`);
  return raw;
}

/** @param {string} file a path, or a PKCS8 PEM */
export function loadKey(file) {
  return crypto.webcrypto.subtle.importKey("pkcs8", Buffer.concat([PKCS8, rawKey(file)]), { name: "Ed25519" }, false, ["sign"]);
}

/** @param {string} file @returns {Uint8Array} */
export const publicOf = file => new Uint8Array(crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([PKCS8, rawKey(file)]), format: "der", type: "pkcs8" }))
  .export({ format: "der", type: "spki" }).subarray(-32));

/** @param {string} file */
export function keygen(file) {
  const k = crypto.generateKeyPairSync("ed25519");
  const raw = k.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  fs.writeFileSync(file, raw, { mode: 0o600 });
  const pub = Buffer.from(k.publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");
  fs.writeFileSync(`${file}.pub`, pub + "\n");
  return pub;
}

/** Sign a set of files into <dir> with its manifest. Returns the manifest's sha256 hex. */
async function sealed(files, dir, o) {
  const bytes = await buildManifest({ release: o.release, entry: o.entry, files, created: o.created });
  const sig = await signManifest(bytes, await loadKey(o.key));
  for (const [p, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), b); }
  fs.writeFileSync(path.join(dir, MANIFEST), bytes);
  fs.writeFileSync(path.join(dir, SIGNATURE), sig + "\n");
  return sha256Hex(bytes);
}

/**
 * The app's build into <out>/v/<sha>/. Returns what releases.json lists.
 * @param {{ dist: string, release: string, key: string, out: string, created?: number }} o
 */
export async function build(o) {
  const files = readTree(o.dist);
  const entry = entriesOf(files["index.html"] ? Buffer.from(files["index.html"]).toString() : "", files);
  if (!entry.length) throw new Error(`${o.dist}/index.html loads no local script`);
  const tmp = path.join(o.out, `.v-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  const manifest = await sealed(files, tmp, { ...o, entry });
  const sha = folderOf(manifest);
  const dir = path.join(o.out, "v", sha);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(tmp, dir);
  return { release: o.release, sha, manifest };
}

/**
 * The fixed loader into <out>/, with sw.js stamped with the release public key.
 * @param {{ release: string, key: string, out: string, created?: number }} o
 */
export async function loader(o) {
  /** @type {Record<string, Uint8Array>} */
  const files = {};
  for (const f of LOADER_FILES) {
    const src = f.startsWith("client/") ? path.join(HERE, "..", f) : path.join(HERE, "loader", f === "manifest.js" ? "../manifest.js" : f);
    let text = fs.readFileSync(src, "utf8");
    // In the served tree the loader's modules sit beside the client's: fix the one relative import.
    if (f === "manifest.js") text = text.replace('"../client/bytes.js"', '"./client/bytes.js"');
    files[f] = new Uint8Array(Buffer.from(text));
  }
  const pub = Buffer.from(publicOf(o.key)).toString("base64url");
  files["loader.js"] = new Uint8Array(Buffer.from(Buffer.from(files["loader.js"]).toString().replace("{{RELEASE_PUB}}", pub)));
  // index.html pins loader.js (stamped) and loader.css by SRI.
  let html = Buffer.from(files["index.html"]).toString();
  html = html.replace("{{loader.js}}", await sri(files["loader.js"])).replace("{{loader.css}}", await sri(files["loader.css"]));
  files["index.html"] = new Uint8Array(Buffer.from(html));
  const manifest = await sealed(files, o.out, { ...o, entry: ["loader.js"] });
  const sw = fs.readFileSync(path.join(HERE, "sw.js"), "utf8").replace("{{RELEASE_PUB}}", pub);
  fs.writeFileSync(path.join(o.out, "sw.js"), sw);
  return { release: o.release, manifest };
}

/** Check a sealed folder against a public key. Resolves with the manifest's sha256, or throws. */
export async function verify(dir, pub) {
  const { manifest, sha256 } = await verifyManifest(new Uint8Array(fs.readFileSync(path.join(dir, MANIFEST))), fs.readFileSync(path.join(dir, SIGNATURE), "utf8"), pub);
  for (const [p, h] of Object.entries(manifest.files)) {
    if (await sri(new Uint8Array(fs.readFileSync(path.join(dir, p)))) !== h) throw new Error(`${p} does not match the manifest`);
  }
  return sha256;
}

async function main(argv) {
  const [cmd, arg] = argv;
  const flag = n => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : undefined; };
  const key = flag("key") || process.env.VYRE_RELEASE_KEY || "";
  const out = flag("out") || "app-out";
  if (cmd === "keygen" && arg) return console.log(keygen(arg));
  if (cmd === "build" && arg && flag("release")) return console.log(JSON.stringify(await build({ dist: arg, release: String(flag("release")), key, out })));
  if (cmd === "loader" && flag("release")) return console.log(JSON.stringify(await loader({ release: String(flag("release")), key, out })));
  if (cmd === "verify" && arg && flag("pub")) return console.log(await verify(arg, new Uint8Array(Buffer.from(fs.readFileSync(String(flag("pub")), "utf8").trim(), "base64url"))));
  console.error("usage: release.js keygen <file> | build <dist> --release x.y.z | loader --release x.y.z | verify <folder> --pub <file>  (--key, --out)");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(e => { console.error(`release: ${e.message}`); process.exitCode = 1; });
}
