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

import { pair, resolveTicket, pairOffer, connect, PAIR_BASE } from "./client/client.js";
import { webCrypto, indexedDbKeyStore } from "./client/webcrypto.js";
import { verifyManifest, folderOf, MANIFEST, SIGNATURE } from "./manifest.js";
import { fromBase64url } from "./client/bytes.js";
import { registerWorker, adoptInWorker } from "./adopt.js";
import { pairTicketFrom, HOSTED_RELAY, cardWords, pairWithCard } from "./fragment.js";

const RELEASE_PUB = "{{RELEASE_PUB}}";
// The box holds a redeem until the screen it came from confirms (up to 60 s): the handshake must outlast the person's tap.
const PAIR_WAIT_MS = 90000;
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

/**
 * The confirm card: who the code says it is, the box key's fingerprint, and two buttons. Text only, never markup.
 * Resolves true only on the tap on Pair.
 * @param {{ says: string, fingerprint: string }} w @returns {Promise<boolean>}
 */
function confirmCard(w) {
  return new Promise(resolve => {
    const root = document.getElementById("vyre-loader");
    if (!root) return resolve(false);
    const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
    const card = el("div", "", "card");
    card.setAttribute("role", "dialog");
    card.append(el("p", `This code says it is ${w.says}.`), el("p", `Its key fingerprint is ${w.fingerprint}. Pair only if you started this on your own server and the fingerprint matches what it shows.`));
    const pairBtn = el("button", "Pair this device", "primary"), notNow = el("button", "Not now", "quiet");
    pairBtn.type = notNow.type = "button";
    pairBtn.addEventListener("click", () => { card.remove(); resolve(true); }, { once: true });
    notNow.addEventListener("click", () => { card.remove(); resolve(false); }, { once: true });
    card.append(pairBtn, notNow);
    status("");
    root.append(card);
    pairBtn.focus();
  });
}

async function main() {
  const registered = registerWorker();
  const crypto = webCrypto();
  const keyStore = indexedDbKeyStore();
  const last = load(LAST) || {};
  const about = { kind: /** @type {"web"} */ ("web"), ...(last.release ? { release: last.release, manifest: last.manifest } : {}) };
  let box = load(BOX);
  // The camera page (wink.vyre.run) hands a scanned ticket over as `#pair=<ticket>`; the installed app with no server yet scans one
  // itself (pairing.js, the same scanner, no lookup). Anyone can send a person such a link, so nothing is redeemed on arrival: the
  // fragment is read once and scrubbed from the address and history at once, the ticket is resolved ONCE (read only; it uses the
  // ticket up), and the person sees who it says it is, with the key's fingerprint, and must tap Pair. The pairing then uses the
  // record already held (a second lookup would find the ticket gone). A tap on Not now, or leaving, pairs nothing.
  let handed = pairTicketFrom(location.hash);
  if (handed) history.replaceState(null, "", "/");
  if (!handed && !box && location.pathname !== "/pair") {
    // No server yet: the scanner opens right here, never by navigating to wink.vyre.run, which on iOS leaves the installed app.
    const { scanTicket } = await import("./pairing.js");
    handed = await scanTicket({ relay: HOSTED_RELAY, crypto });
  }
  if (handed) {
    box = await pairWithCard(handed, {
      resolve: () => { status("Looking up this pairing code"); return resolveTicket(handed, { relay: HOSTED_RELAY, crypto }); },
      confirm: found => confirmCard(cardWords(found)),
      pair: found => { status("Pairing this device with your server"); return pairOffer(found.offer, { name: browserName(), about, keyStore, crypto, timeout: PAIR_WAIT_MS }); },
    });
    if (!box) { status("Nothing was paired."); return; }
    store(BOX, box);
  } else if (location.pathname === "/pair" && location.hash.length > 1) {
    status("Pairing this browser with your box");
    box = await pair(PAIR_BASE + location.hash, { name: browserName(), about, keyStore, crypto });
    store(BOX, box);
    history.replaceState(null, "", "/");
  }
  if (!box) { status("This browser is not paired with a server yet. On your server, open Settings, Devices, and scan the code with this device's camera."); return; }
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
