// @ts-check
// Server install pairing. The creator's app issues one code bound to the identity chain's id and this device's key.
// An agent's issue or complete waits at the Gate. The person's own call runs now. The private key never leaves the identity store, and never appears in a tool result.
// Redeem reads the published chain for that person id (the directory's ii/ index, the same chain identity.create stores) and adopts only when the key in the code is a current device key. A miss, or a directory that cannot be reached, leaves the server unowned.

import { mintPairCode, verifyPairCode, installCommand } from "../../lib/pair-code.js";
import { idDirectory, memorySeen } from "../../lib/identity/directory.js";
import { assertPublishedKey, publishedDeviceKeys } from "../../lib/identity/published-key.js";
import { createSetupKey, setupFingerprint } from "../../relay/client/setup.js";
import { createSetupPage } from "./setup-http.js";

export { publishedDeviceKeys };

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const SPACE_ID = /^spc_[a-z2-7]{8,}$/;

/** The one directory client. A test passes `directory`. Otherwise this is `names.directory` on the kernel config, the same host identity.create published to. @param {any} o */
function directoryClient(o) {
  if (o.directory) return o.directory;
  const raw = o.ctx && o.ctx.config && o.ctx.config.names && o.ctx.config.names.directory;
  const base = typeof raw === "string" && /^https?:\/\//.test(raw) ? raw : undefined;
  return idDirectory({ ...(base ? { base } : {}), seen: memorySeen() });
}

/** The home space id, once this server has a kernel. Empty until then. @param {any} ctx */
function kernelSpace(ctx) {
  const id = ctx && ctx.kernel && typeof ctx.kernel.space === "string" ? ctx.kernel.space : "";
  return SPACE_ID.test(id) ? id : "";
}
const str = { type: "string" };
const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });

/**
 * Redeem one install code on this server. The one published-key check runs before anything is written. The owner record is written before spaces.owner.adopt. A second redeem is refused.
 * `directory` is the test seam. Production asks the directory this computer is configured to use, through assertPublishedKey. There is no second check.
 * @param {{ ctx: { call: Function, events?: { emit: Function }, log?: Function, kernel?: { space?: string, owner?: string }, config?: { names?: { directory?: string } } }, meta: { get: Function, set: Function, del: Function }, now?: () => number, directory?: { resolveById: (id: string) => Promise<any> } }} o
 * @param {string} code
 */
export async function redeemInstallCode(o, code) {
  const now = o.now || Date.now;
  const v = verifyPairCode(String(code || ""), now);
  if (!v.ok) throw fail(v.code, v.message);
  const pub = Buffer.from(v.pub).toString("base64url");
  try { await assertPublishedKey(directoryClient(o), v.person, pub, { fullDevice: true }); }
  catch (e) {
    const c = /** @type {any} */ (e).code;
    throw fail(c === "unavailable" ? "unavailable" : "denied", c === "unavailable" ? "The directory could not confirm this key. Wait a minute and run the install line again." : "That install code is not signed by a key this person has published. Make a new install line in the Vyre app.");
  }
  const meta = o.meta;
  const spent = `install-nonce:${v.nonceHash}`;
  if (meta.get("install_setup_locked") || meta.get(spent)) throw fail("locked", "This code was already used. Make a new install line in the Vyre app and run it again.");
  const cur = meta.get("owner");
  if (cur && cur.identity && cur.identity !== v.person) throw fail("denied", "This server already belongs to someone. Reset it from its own screen before pairing another person.");
  const mine = await creatorAlreadyOwns(o, v.person);
  if (mine) {
    meta.set(spent, { at: now() });
    if (!cur) meta.set("owner", { kind: "identity", id: mine, identity: mine });
    if (!meta.get("adopter")) meta.set("adopter", "install");
    return finishInstall(o, meta, mine, now);
  }
  meta.set(spent, { at: now() });
  if (!cur) meta.set("owner", { kind: "identity", id: v.person, identity: v.person });
  if (!meta.get("adopter")) meta.set("adopter", "install");
  meta.set("pair_to", v.person);
  /** @type {any} */ let adopted;
  try { adopted = await o.ctx.call("spaces.owner.adopt", { person: v.person }); }
  catch (e) { adopted = { error: { code: /** @type {any} */ (e).code || "unavailable", message: /** @type {any} */ (e).message } }; }
  const err = adopted && adopted.error;
  if (err && err.code !== "already_adopted") {
    if (!cur) meta.del("owner");
    meta.del(spent);
    meta.del("pair_to");
    throw fail(err.code === "no_such_tool" ? "unavailable" : (err.code || "unavailable"), "This server could not be made yours. Make a new install line in the Vyre app and run it again.");
  }
  return finishInstall(o, meta, v.person, now);
}

/**
 * This device already owns the server under its identity id, and the install code was signed by this device's key.
 * Adopting again would name a second id (per_ plus the key id) and be refused. @param {any} o @param {string} person
 */
async function creatorAlreadyOwns(o, person) {
  let self = null, dev = null;
  try { self = await o.ctx.call("spaces.identity.self", {}); } catch { self = null; }
  try { dev = await o.ctx.call("spaces.identity.device", {}); } catch { dev = null; }
  const mine = self && self.data && typeof self.data.id === "string" ? self.data.id : "";
  const eid = dev && dev.data && typeof dev.data.deviceId === "string" ? dev.data.deviceId : "";
  const ownerNow = o.ctx && o.ctx.kernel && typeof o.ctx.kernel.owner === "string" ? o.ctx.kernel.owner : "";
  return mine && eid && person === `per_${eid}` && ownerNow === mine ? mine : "";
}

/** @param {any} o @param {{ set: Function }} meta @param {string} person @param {() => number} now */
function finishInstall(o, meta, person, now) {
  meta.set("install_setup_locked", { at: now(), person });
  const space = kernelSpace(o.ctx);
  if (space) meta.set("install_space", space);
  try { o.ctx.events && o.ctx.events.emit("wink.server-adopted", { owner: { kind: "identity", id: person } }); } catch { /* the owner record stands either way */ }
  return { ok: true, person, ...(space ? { space } : {}) };
}

/**
 * The install tools (one definition each: MCP, HTTP and CLI) and the setup page.
 * Issue and complete are outward, so an agent is held at the Gate. The person's own call runs now. Status is a read.
 * `wink.install.issue` is the mint. The Create step's name, `spaces.pair.install`, lives on the spaces module and calls this mint.
 * @param {{ ctx: any, meta: { get: Function, set: Function, del: Function }, now?: () => number, log?: Function, pair?: (qr: string, person: string) => any, ticket?: (session: any) => Promise<string>, directory?: { resolveById: (id: string) => Promise<any> }, askServer?: () => Promise<{ space?: string, owned?: boolean, locked?: boolean, person?: string } | null> }} o
 */
export function registerInstallPair(o) {
  const now = o.now || Date.now;
  const ctx = o.ctx;
  /** @type {{ person: string, exp: number, os: string, secret: Uint8Array, key: any } | null} */
  let session = null;
  const locked = () => Boolean(o.meta.get("install_setup_locked") || o.meta.get("owner"));
  const fromLine = () => process.env.VYRE_INSTALL_FROM_LINE === "1";
  const page = createSetupPage({ redeem: (code) => redeemInstallCode(o, code), locked, hidePaste: fromLine });

  ctx.tool("wink.server.install-redeem", {
    internal: true,
    description: "Redeem an install code on this server and make that person the owner. The install boot and the setup page only.",
    input: obj({ code: str }, ["code"]),
    run: async (input, meta = {}) => {
      if (String(meta.caller || "") !== "module:relay") throw fail("denied", "Only the install on this server can redeem a pairing code. Use the setup page, or run the install line again.");
      return redeemInstallCode(o, String(input.code || ""));
    },
  });

  const issue = {
    input: obj({
      os: { type: "string", enum: ["linux", "mac"] },
      kind: { type: "string", enum: ["linux", "mac"] },
      name: str,
      store: str,
    }),
    run: async (input) => {
      const dev = await ctx.call("spaces.identity.device", {});
      const self = await ctx.call("spaces.identity.self", {});
      const pub = dev && dev.data && dev.data.deviceKey;
      const person = self && self.data && self.data.id;
      if (!pub || !/^per_[a-z2-7]{26}$/.test(String(person || ""))) throw fail("unavailable", "This device has no identity yet. Open the Vyre app and finish starting, then ask again.");
      const key = await createSetupKey();
      const secret = new Uint8Array(16);
      cryptoRandom(secret);
      const fp = await setupFingerprint(key.spki);
      const minted = await mintPairCode({
        person: String(person),
        publicKey: String(pub),
        secret, fingerprint: fp, now,
        sign: async (m) => {
          const r = await ctx.call("spaces.identity.sign", { message: Buffer.from(m).toString("base64url") });
          if (!r || r.error || !r.data || !r.data.sig) throw fail("unavailable", "This device could not sign the install line. Try again from the Vyre app.");
          return Buffer.from(String(r.data.sig), "base64url");
        },
      });
      if (minted.person !== person) throw fail("denied", "The identity on this device does not match the key it signed with. Open the Vyre app and try again.");
      const os = input && (input.kind === "mac" || input.os === "mac") ? "mac" : "linux";
      session = { person, exp: minted.exp, os, secret, key };
      o.meta.set("install_client", { person, exp: minted.exp, os, at: now() });
      const line = installCommand(os, minted.code);
      return { command: line, code: minted.code, line, expires: minted.exp, person, os };
    },
  };
  ctx.tool("wink.install.issue", {
    description: "Make a one-time install line bound to your identity. Returns the line and when it expires. Your signing key stays on this device.",
    ...issue,
  });

  ctx.tool("wink.install.status", {
    description: "Read whether an install line is outstanding, when it expires, and whether this server is owned.",
    input: obj(),
    run: async () => {
      const row = o.meta.get("install_client");
      const owner = o.meta.get("owner");
      const person = owner && owner.identity ? String(owner.identity) : (row && row.person) || null;
      const stored = o.meta.get("install_space");
      let space = (typeof stored === "string" && SPACE_ID.test(stored) ? stored : "") || (owner ? kernelSpace(ctx) : "");
      let owned = Boolean(owner);
      let lockedNow = Boolean(o.meta.get("install_setup_locked"));
      // The computer that issued the line does not hold the space. Once it is paired, it asks the adopting server.
      if (!space && row && !owner && typeof o.askServer === "function") {
        try {
          const remote = await o.askServer();
          const remoteSpace = remote && typeof remote.space === "string" && SPACE_ID.test(remote.space) ? remote.space : "";
          if (remoteSpace) { space = remoteSpace; o.meta.set("install_space", remoteSpace); }
          if (remote && (remote.owned || remote.locked || remoteSpace)) { owned = owned || Boolean(remote.owned || remoteSpace); lockedNow = lockedNow || Boolean(remote.locked); }
        } catch { /* the server is not paired yet; the next read asks again */ }
      }
      return { issued: Boolean(row && row.exp * 1000 > now()), expires: row ? row.exp : null, os: row ? row.os : null, owned, person, locked: lockedNow, space: space || null };
    },
  });

  ctx.tool("wink.install.complete", {
    description: "Finish pairing this device after the server has taken the install line. Your signing key stays on this device.",
    input: obj(),
    run: async () => {
      const owner = o.meta.get("owner");
      if (owner && owner.identity) return { ok: true, owned: true, person: String(owner.identity) };
      if (!session) throw fail("bad_state", "Make an install line first, run it on the server, then ask again.");
      const qr = typeof o.ticket === "function" ? await o.ticket(session) : await offerTicket(ctx, session);
      if (typeof o.pair !== "function") throw fail("unavailable", "This computer could not finish pairing. Open the Vyre app and it will finish.");
      const started = await o.pair(String(qr || ""), session.person);
      return { ok: true, person: session.person, expires: session.exp, ...(started && started.pairing ? { pairing: String(started.pairing) } : {}) };
    },
  });

  const wantPage = process.env.VYRE_SETUP_HTTP === "1" || process.env.VYRE_SUPERVISOR === "docker";
  if (wantPage) {
    try { page.start({ port: Number(process.env.VYRE_SETUP_PORT || 8080) }); }
    catch (e) { (o.log || (() => {}))(`wink: the setup page did not start: ${/** @type {any} */ (e).message}`); }
  }
  return { redeem: (code) => redeemInstallCode(o, code), page, stop: () => page.stop() };
}

/**
 * The server's pairing ticket, from the setup offer the install line registered. The identity key is not used here.
 * @param {any} ctx @param {{ secret: Uint8Array, key: any, person: string }} session
 */
async function offerTicket(ctx, session) {
  const st = await ctx.call("relay.status", {});
  const url = st && st.data && (st.data.url || st.data.relay);
  if (!url || (st && st.error)) throw fail("bad_state", "The server has not taken the install line yet. Run the line, then ask again.");
  const setup = await import("../../relay/client/setup.js");
  const channel = await import("../../relay/client/setupchannel.js");
  const client = await import("../../relay/client/client.js");
  const web = await import("../../relay/client/webcrypto.js");
  const bytes = await import("../../relay/client/bytes.js");
  let found;
  try { found = await setup.resolveSetup(session.secret, { relay: String(url) }); }
  catch (e) {
    const code = /** @type {any} */ (e).code;
    if (code === "contested") throw fail("denied", "Two servers used this line. Make a new install line in the Vyre app and run it again.");
    throw fail("bad_state", "The server has not taken the install line yet. Run the line, then ask again.");
  }
  const chan = await channel.connectSetup(
    { openChannel: client.openChannel, request: client.request, setupHello: setup.setupHello, webCrypto: web.webCrypto, utf8: bytes.utf8 },
    { offer: found.offer, key: session.key, secret: session.secret },
  );
  try {
    const offer = await chan.call("wink.server.setup-offer", { identity: session.person });
    const qr = String(offer && offer.qr || "");
    if (!qr) throw fail("bad_state", "The server did not finish pairing. Run the install line again, then ask again.");
    return qr;
  } finally { try { chan.close(); } catch { /* the ticket is already in hand */ } }
}

/** @param {Uint8Array} out */
function cryptoRandom(out) {
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") { globalThis.crypto.getRandomValues(out); return; }
  throw fail("unavailable", "This device could not make an install code. Try again from the Vyre app.");
}
