// @ts-check
// releases (core/apps): the Android app, from the box to the owner's phone (ADR 0027, 4a).
//
// CI publishes an unsigned release APK, vyre-<version>-<sha7>.apk, and android.json beside it
// ({ version, versionCode, sha, sha256, size, minSdk, built, file }) into the box's release folder
// (config releases.android, default <home>/releases/android). The box signs that APK with the
// owner's own key and serves:
//
//   GET /v1/releases/android               the manifest (CI's android.json), with sha256 and size
//                                          of the SIGNED file and the certificate's cert_sha256
//                                          (no-store)
//   GET /v1/releases/android?file=<file>   the signed APK (immutable: a new build is a new name)
//
// Only the owner's devices and the owner over the tailnet reach these (the same callers the Deck
// admits); a guest, an agent's node, and a label on the socket get a 404. It is the module's own
// route (ctx.route), so vyred needs nothing for it.
//
// The key: an EC P-256 key and a self-signed certificate (CN=Vyre <box>, 25 years), made the first
// time anything needs them and kept in the box's vault as `android-release-key` (fields value:
// the PKCS#8 key, cert: the certificate), granted to this module alone. The same key signs every
// release, so each update installs over the last. If the key is lost (the vault item deleted, or
// the vault lost without a backup), the next request makes a new one, the manifest's cert_sha256
// changes, and Android will not install the new signature over the old app: re-pairing the phone
// (`vyre phone add`) uninstalls and reinstalls it. The app's own data on the phone goes with it;
// everything that matters lives on the box.
//
// Signing happens once per release: the signed file is cached beside the unsigned one as
// signed-<file>, with signed-<file>.json saying which certificate and which unsigned sha256 it
// came from, so a new key or a replaced build is signed again.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ownerDevice } from "../modules/index.js";
import { sign, certSha256 } from "./apk-sign.js";
import { selfSigned, toPem } from "./x509.js";

export const KEY_ITEM = "android-release-key";
/** A release file name: no slash, no dot-dot, no percent-escapes, ending in .apk. */
export const FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}\.apk$/;
/** Without a v1 signature, Android 7.0 (SDK 24) is the oldest that installs the app. */
export const MIN_SDK = 24;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * CI's android.json, checked. Throws with what is wrong.
 * @param {any} m
 */
export function checkManifest(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("android.json is not an object");
  const bad = [];
  if (typeof m.version !== "string" || !m.version) bad.push("version");
  if (!Number.isInteger(m.versionCode) || m.versionCode < 1) bad.push("versionCode");
  if (typeof m.sha !== "string" || !/^[0-9a-f]{7,40}$/.test(m.sha)) bad.push("sha");
  if (typeof m.sha256 !== "string" || !SHA256.test(m.sha256)) bad.push("sha256");
  if (!Number.isInteger(m.size) || m.size < 1) bad.push("size");
  if (!Number.isInteger(m.minSdk)) bad.push("minSdk");
  if (typeof m.file !== "string" || !FILE.test(m.file) || m.file.includes("..")) bad.push("file");
  if (bad.length) throw new Error(`android.json has a bad or missing ${bad.join(", ")}`);
  if (m.minSdk < MIN_SDK) throw new Error(`minSdk ${m.minSdk} is below ${MIN_SDK}: the box signs with v2 and v3 only`);
  return m;
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {any} body @param {Record<string, string>} [headers] */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}
const fail = (res, status, code, message, headers) => json(res, status, { error: { code, message } }, { "cache-control": "no-store", ...headers });
const sha256 = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const root = ctx.paths.root;
    const dir = () => {
      const c = ctx.config && ctx.config.releases && ctx.config.releases.android;
      return c ? path.resolve(root, String(c)) : path.join(root, "releases", "android");
    };
    const box = String((ctx.config && ctx.config.name) || "box");

    /** The owner's key and certificate, made on first need. Held in memory once fetched. */
    /** @type {Promise<{ key: string, cert: string, cert_sha256: string }> | null} */
    let owner = null;
    const ownerKey = () => {
      if (!owner) owner = load().catch(e => { owner = null; throw e; });
      return owner;
    };
    async function load() {
      const listed = await ctx.call("vault.list", {});
      if (listed.error) throw new Error(`the vault did not answer: ${listed.error.message}`);
      const items = (listed.data && listed.data.items) || [];
      if (items.some(i => i.name === KEY_ITEM)) {
        // It exists: any failure here (a locked vault, a revoked grant) is the owner's to see, never a reason to make a new key.
        const key = String(await ctx.vault.fetch(KEY_ITEM));
        const cert = String(await ctx.vault.fetch(KEY_ITEM, { field: "cert" }));
        return { key, cert, cert_sha256: certSha256(cert) };
      }
      const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const key = /** @type {string} */ (pair.privateKey.export({ type: "pkcs8", format: "pem" }));
      const cert = toPem(selfSigned({ privateKey: pair.privateKey, publicKey: pair.publicKey, cn: `Vyre ${box}` }));
      const put = await ctx.call("vault.put", { name: KEY_ITEM, kind: "secret", description: "The owner's Android release signing key, made by the box (releases module)",
        fields: { value: key, cert }, grants: ["releases"] });
      if (put.error) throw new Error(`the vault did not take the release key: ${put.error.message}`);
      ctx.log(`made the Android release key (cert ${certSha256(cert).slice(0, 16)})`);
      return { key, cert, cert_sha256: certSha256(cert) };
    }

    const readManifest = () => {
      let raw;
      try { raw = fs.readFileSync(path.join(dir(), "android.json"), "utf8"); }
      catch { return null; }
      return checkManifest(JSON.parse(raw));
    };

    /** The signed APK for this manifest: made once per unsigned build and key. */
    /** @type {Map<string, Promise<{ file: string, sha256: string, size: number }>>} */
    const signing = new Map();
    async function signed(m) {
      const o = await ownerKey();
      const out = path.join(dir(), `signed-${m.file}`), meta = out + ".json";
      try {
        const was = JSON.parse(fs.readFileSync(meta, "utf8"));
        const st = fs.statSync(out);
        if (was.cert_sha256 === o.cert_sha256 && was.source_sha256 === m.sha256 && st.size === was.size) return { file: out, sha256: was.sha256, size: was.size };
      } catch {}
      const k = `${m.file}:${m.sha256}:${o.cert_sha256}`;
      if (!signing.has(k)) {
        signing.set(k, (async () => {
          const unsigned = fs.readFileSync(path.join(dir(), m.file));
          if (unsigned.length !== m.size || sha256(unsigned) !== m.sha256) throw Object.assign(new Error(`${m.file} does not match android.json's sha256 and size`), { code: "release_mismatch" });
          const apk = sign(unsigned, { key: o.key, cert: o.cert });
          const done = { sha256: sha256(apk), size: apk.length };
          fs.writeFileSync(out + ".tmp", apk);
          fs.renameSync(out + ".tmp", out);
          fs.writeFileSync(meta, JSON.stringify({ ...done, cert_sha256: o.cert_sha256, source_sha256: m.sha256 }));
          ctx.log(`signed ${m.file} (${m.version}, ${done.size} bytes)`);
          return { file: out, ...done };
        })().finally(() => signing.delete(k)));
      }
      return /** @type {Promise<{ file: string, sha256: string, size: number }>} */ (signing.get(k));
    }

    ctx.tool("releases.cert", {
      description: "The SHA-256 of the owner's Android release certificate, made on first use. `vyre phone add` pins it.",
      callers: ["cli", "local", "deck", "device", "space", "agent"],
      input: { type: "object", properties: {} },
      run: async () => ({ cert_sha256: (await ownerKey()).cert_sha256, subject: `CN=Vyre ${box}` }),
    });

    ctx.tool("releases.sign", {
      description: "Sign the Android release now in the release folder (CI's unsigned APK named by android.json) with the owner's key, so the first download is instant. `vyre update` calls it after it places a new build. Idempotent.",
      callers: ["cli", "local", "module"],
      input: { type: "object", properties: {} },
      run: async () => {
        const m = readManifest();
        if (!m) throw Object.assign(new Error("no Android release on this box yet"), { code: "no_release" });
        const s = await signed(m);
        return { file: m.file, version: m.version, versionCode: m.versionCode, sha256: s.sha256, size: s.size, cert_sha256: (await ownerKey()).cert_sha256 };
      },
    });

    ctx.route("android", async (req, res, { caller, url }) => {
      // A guest or anyone who is not the owner learns nothing about what is here.
      if (!ownerDevice(caller)) return fail(res, 404, "not_found", url.pathname);
      if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "method_not_allowed", "GET only", { allow: "GET, HEAD" });
      const head = req.method === "HEAD";
      const want = url.searchParams.get("file");
      const apk = want === null ? null : [want, want];
      if (apk && (!FILE.test(apk[1]) || apk[1].includes(".."))) return fail(res, 404, "not_found", "not a release file name");
      try {
        const m = readManifest();
        if (!m) return fail(res, 404, "no_release", "no Android release on this box yet");
        if (apk && apk[1] !== m.file) return fail(res, 404, "not_found", `${apk[1]} is not the current release`);
        const s = await signed(m);
        if (!apk) {
          const body = JSON.stringify({ ...m, sha256: s.sha256, size: s.size, cert_sha256: (await ownerKey()).cert_sha256 });
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": Buffer.byteLength(body) });
          return res.end(head ? undefined : body);
        }
        res.writeHead(200, { "content-type": "application/vnd.android.package-archive", "content-length": s.size,
          "cache-control": "private, max-age=31536000, immutable", etag: `"${s.sha256}"`, "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename="${m.file}"` });
        if (head) return res.end();
        fs.createReadStream(s.file).on("error", () => res.destroy()).pipe(res);
      } catch (e) {
        const err = /** @type {any} */ (e);
        ctx.log(`apps: ${err.message}`);
        return fail(res, err.code === "release_mismatch" ? 409 : 500, err.code === "release_mismatch" ? "release_mismatch" : "release_failed", err.message);
      }
    }, { readOnly: true });

    return { async stop() {} };
  },
};
