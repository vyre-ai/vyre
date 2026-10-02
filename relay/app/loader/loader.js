// @ts-check
// loader: the fixed entry of the hosted web app at app.vyre.run (ADR 0026 section 10, ADR 0027
// section 4), and its trust root. It pairs or connects to the person's box through the relay,
// asks the box which build it trusts (relay.web.release), checks that build's manifest against the
// Vyre release key and the hash the box named, and only then loads the build's entry files, each
// under Subresource Integrity. The app finds the open connection at globalThis.vyre.
//
// Nothing about the box is sent to app.vyre.run: the pairing offer stays in the URL fragment, the
// device key is a non-extractable CryptoKey in IndexedDB, and the box record in localStorage
// holds no secret. release.js stamps the release public key below.

import { pair, pairTicket, connect, PAIR_BASE } from "./client/client.js";
import { webCrypto, indexedDbKeyStore } from "./client/webcrypto.js";
import { verifyManifest, folderOf, MANIFEST, SIGNATURE } from "./manifest.js";
import { fromBase64url } from "./client/bytes.js";
import { registerWorker, adoptInWorker } from "./adopt.js";
import { pairTicketFrom, HOSTED_RELAY } from "./fragment.js";

const RELEASE_PUB = "{{RELEASE_PUB}}";
const BOX = "vyre.box";
const LAST = "vyre.release";

const status = (text, warn = false) => {
  const p = document.getElementById("vyre-status");
  if (p) { p.textContent = text; p.className = warn ? "warn" : ""; }
};
const load = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/** A short, honest name for this browser, shown in the box's device list. */
function browserName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "a computer";
  return `Browser on ${os}`;
}

async function bytesOf(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Load the build the box trusts, or throw. */
async function loadBuild(conn) {
  const res = await conn.fetch("/v1/tools/relay.web.release", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = await res.json();
  if (res.status !== 200 || !body.data) throw new Error((body.error && body.error.message) || `the box answered ${res.status}`);
  const want = body.data;
  if (!/^[a-f0-9]{40}$/.test(want.sha) || !/^[a-f0-9]{64}$/.test(want.manifest) || folderOf(want.manifest) !== want.sha) throw new Error("the box named a build this loader cannot check");
  const base = `/v/${want.sha}/`;
  const [bytes, sig] = await Promise.all([bytesOf(base + MANIFEST), bytesOf(base + SIGNATURE)]);
  const { manifest, sha256 } = await verifyManifest(bytes, new TextDecoder().decode(sig), fromBase64url(RELEASE_PUB));
  if (sha256 !== want.manifest || manifest.release !== want.release) throw new Error("the build at app.vyre.run is not the one your box trusts");
  store(LAST, { release: manifest.release, manifest: sha256 });
  return { base, manifest, want };
}

/** Add the build's entry files in order, each pinned by its hash. */
function inject(base, manifest) {
  for (const f of manifest.entry) {
    const integrity = manifest.files[f];
    if (f.endsWith(".css")) {
      const l = document.createElement("link");
      l.rel = "stylesheet"; l.href = base + f; l.integrity = integrity; l.crossOrigin = "anonymous";
      document.head.appendChild(l);
    } else {
      const s = document.createElement("script");
      s.src = base + f; s.integrity = integrity; s.crossOrigin = "anonymous"; s.async = false;
      if (f.endsWith(".mjs")) s.type = "module";
      document.body.appendChild(s);
    }
  }
}

async function main() {
  const registered = registerWorker();
  const crypto = webCrypto();
  const keyStore = indexedDbKeyStore();
  const last = load(LAST) || {};
  const about = { kind: /** @type {"web"} */ ("web"), ...(last.release ? { release: last.release, manifest: last.manifest } : {}) };
  let box = load(BOX);
  // The camera page (wink.vyre.run) hands a scanned ticket over as `#pair=<ticket>`: take it out of the address at once, then
  // redeem it here, with this origin's own device key. The passkey is enrolled here too, by the app, once it is connected.
  const handed = pairTicketFrom(location.hash);
  if (handed) {
    history.replaceState(null, "", "/");
    status("Pairing this device with your server");
    box = await pairTicket(handed, { relay: HOSTED_RELAY, name: browserName(), about, keyStore, crypto });
    store(BOX, box);
  } else if (location.pathname === "/pair" && location.hash.length > 1) {
    status("Pairing this browser with your box");
    box = await pair(PAIR_BASE + location.hash, { name: browserName(), about, keyStore, crypto });
    store(BOX, box);
    history.replaceState(null, "", "/");
  }
  // No server yet: the loader only says so. The installed app opens the scanner inside itself (the app bundle's piece, on
  // app.vyre.run), never by navigating to wink.vyre.run, which on iOS leaves the installed app for a browser sheet.
  if (!box) { status("This browser is not paired with a box yet. On your box, open Settings, Devices, and scan the code with this device's camera."); return; }
  status(`Connecting to ${box.name || "your box"}`);
  const conn = connect({ ...box, about, keyStore, crypto });
  const { base, manifest, want } = await loadBuild(conn);
  /** @type {any} */ (globalThis).vyre = { conn, box, release: { ...want } };
  const shell = document.getElementById("vyre-loader");
  if (shell) shell.hidden = true;
  // Tell the worker which build this is, so it can answer the app's own /app/<path> requests
  // from that build, hash-checked, after it re-verifies the signed manifest itself.
  await adoptInWorker(want, registered);
  inject(base, manifest);
}

main().catch(e => status(`Could not open your box: ${e && e.message ? e.message : e}`, true));
