// kernel/remote/run/real.mjs: the remote kernel call on real machines. A Space homed on one machine, a device on another, the real sealing process verifying presence, the
// real peer wire (admit proof, framing, fair queue) over a real TCP connection. Not part of the suite: it is run by hand (team/0.3/reviews/kernel-remote-run.md).
//
//   node real.mjs init-device DIR WINK                 on the device: two person keys (alice, bob), a device secret and a relay (Noise) key each; DIR/device.json, DIR/enrol.json
//   node real.mjs relay DIR WINK PORT                  a relay (relay/node/server.js) on PORT
//   node real.mjs home DIR ENROL WINK PORT [RELAYURL]  the home: sealing process, kernel, Space; enrols ENROL; direct peers on PORT; also behind the relay at RELAYURL; DIR/invite.json, DIR/relay.json
//   node real.mjs device DIR WINK direct HOST PORT     on the device: members.list, accept an invite, change a role, over the direct path
//   node real.mjs device DIR WINK relay RELAYURL       the same, over a `peer` stream through the relay (DIR/relay.json from the home)
// WINK is a checkout of the Wink branch (core/wink/node/peer-wire.js, relay-peer.js, core/relay, relay/node); the kernel does not import the Wink module, so it is taken by path.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startSealer } from "../../seal/client.js";
import { enrolDevice } from "../../seal/testing.js";
import { payloadHash, proofBytes, chainCtx } from "../../seal/wire.js";
import { bootKernel } from "../../boot.js";
import { createRemoteServer } from "../server.js";
import { createRemoteKernel } from "../client.js";
import { winkTransport, withKernelCall } from "../wink.js";
import { proofRequest, acceptProofRequest, proofChainHash } from "../proof.js";

const [cmd, dir, ...rest] = process.argv.slice(2);
const WINK = cmd === "home" ? rest[1] : rest[0];
const wink = f => import(pathToFileURL(path.join(WINK, f)).href);
const SPACE = "spc_realrun00001";
const OWNER = "per_owner0000000000000000000", ALICE = "per_alice0000000000000000000", BOB = "per_bob00000000000000000000000";
const out = (step, v) => console.log(JSON.stringify({ step, ...v }));
const ec = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

/** A device key that signs presence proofs the way the person's signer does (kernel/seal/testing.js, with the key kept on disk between runs). */
function signerOf(person, key_id, privPem, spki) {
  const priv = crypto.createPrivateKey(privPem);
  return {
    key_id, enrolment: { person, key_id, signer: "secure_enclave", spki },
    proof(space, op, fields) {
      const ch = { space, hops: [{ actor: { kind: "person", id: person, space } }] };
      const p = { signer: "secure_enclave", key_id, payload_hash: payloadHash(op, space, fields), decision: op, chain_hash: chainCtx(ch).chain_hash, issued_at: Date.now(), expires_at: Date.now() + 60_000, nonce: crypto.randomBytes(8).toString("base64url") };
      return { ...p, signature: crypto.sign("sha256", proofBytes(p), { key: priv, dsaEncoding: "ieee-p1363" }).toString("base64url") };
    },
  };
}
const newKey = (person, tag) => { const { publicKey, privateKey } = ec(); return { person, key_id: `dk_${tag}`, priv: privateKey.export({ type: "pkcs8", format: "pem" }), spki: publicKey.export({ type: "spki", format: "der" }).toString("base64") }; };
const loadSigner = k => signerOf(k.person, k.key_id, k.priv, k.spki);
const tbl = fs.existsSync(path.join(dir || ".", "device.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "device.json"), "utf8")) : null;

if (cmd === "init-device") {
  fs.mkdirSync(dir, { recursive: true });
  const keys = { alice: newKey(ALICE, "alice"), bob: newKey(BOB, "bob") };
  const secrets = { dev_alice: crypto.randomBytes(32).toString("hex"), dev_bob: crypto.randomBytes(32).toString("hex") };
  const { keyPair } = await wink("core/relay/noise.js");
  const noise = Object.fromEntries(["dev_alice", "dev_bob"].map(d => { const k = keyPair(); return [d, { priv: k.priv.toString("hex"), pub: k.pub.toString("hex") }]; }));
  fs.writeFileSync(path.join(dir, "device.json"), JSON.stringify({ keys, secrets, noise }), { mode: 0o600 });
  // what the home needs: the PUBLIC halves, and the shared secrets for the admit proof (carried once, by hand, as a pairing would)
  fs.writeFileSync(path.join(dir, "enrol.json"), JSON.stringify({ enrol: Object.values(keys).map(k => ({ person: k.person, key_id: k.key_id, spki: k.spki, signer: "secure_enclave" })), secrets, noise: Object.fromEntries(Object.entries(noise).map(([d, k]) => [d, k.pub])) }));
  out("init-device", { ok: true });
} else if (cmd === "relay") {
  const { createRelay } = await wink("relay/node/server.js");
  const url = await createRelay().listen(Number(rest[1]), "0.0.0.0");
  out("relay", { listening: url });
} else if (cmd === "home") {
  const [enrolFile, , port, relayUrl] = rest;
  const { admitPeer, socketPipe, peerSession, streamPipe } = await wink("core/wink/node/peer-wire.js");
  fs.mkdirSync(dir, { recursive: true });
  const { enrol, secrets, noise } = JSON.parse(fs.readFileSync(enrolFile, "utf8"));
  const sealer = startSealer({ dir: path.join(dir, "seal"), dev: true, unattested: true });
  const ownerKey = newKey(OWNER, "owner"), owner = loadSigner(ownerKey);
  for (const e of [...enrol, ownerKey]) await enrolDevice(sealer, { enrolment: { person: e.person, key_id: e.key_id, signer: "secure_enclave", spki: e.spki } });
  const k = await bootKernel({ db: new DatabaseSync(path.join(dir, "kernel.db")), space: SPACE, owner: OWNER, owner_uid: process.getuid(), sealer });
  const oc = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: 1, inside_model_process: false, capsule_verified: true });
  const signed = (call, ...a) => { const r = proofRequest(SPACE, call, ...a); return { presence: owner.proof(SPACE, r.op, r.fields) }; };
  const g = k.gateway.grants;
  await g.setRole(oc, { person: ALICE, role: "admin" }, signed("setRole", { person: ALICE, role: "admin" }));
  const inv = await g.invites.create(oc, { role: "member", invitee: BOB }, signed("inviteCreate", { role: "member", invitee: BOB }));
  fs.writeFileSync(path.join(dir, "invite.json"), JSON.stringify({ id: inv.id }));
  out("home", { space: SPACE, invite: inv.id, members: (await g.members.list(oc)).map(m => `${m.person}:${m.role}`) });
  const server = createRemoteServer({ space: SPACE, kernel: k });
  const people = { dev_alice: ALICE, dev_bob: BOB };
  const none = async () => { throw Object.assign(new Error("no such tool"), { code: "no_such_tool" }); };
  const opts = { serverFor: s => (s === SPACE ? server : null), personOf: d => people[d] };
  const serve = withKernelCall(none, { ...opts, pathOf: () => "wink" });         // the direct listener
  const serveRelay = withKernelCall(none, { ...opts, pathOf: () => "relay" });   // the relay's peer door
  if (relayUrl) {
    // Behind the relay: the home holds a box link to it; a device that is paired (its Noise key is listed) opens a `peer` stream and is the caller `device:<id>` (bridge peer door).
    const { relayLink } = await wink("core/relay/link.js"), { bridge } = await wink("core/relay/bridge.js"), { newRouteKey, routeId } = await wink("core/relay/wire.js"), { keyPair } = await wink("core/relay/noise.js");
    const rk = newRouteKey(), route = routeId(rk.pub), box = keyPair();
    const byPub = new Map(Object.entries(noise).map(([d, pub]) => [pub, d]));
    const link = relayLink({ url: relayUrl, route, routeKey: rk, boxKey: box, log: m => out("relay-log", { m }),
      admit: async pub => { const d = byPub.get(pub.toString("hex")); if (!d) throw new Error("not paired"); return { device: d }; },
      onchannel: (channel, { reply }) => bridge(channel, { handler: () => {}, caller: `device:${reply.device}`, peer: {},
        peers: { space: SPACE, allow: () => true, accept: (stream, who) => { peerSession(streamPipe(stream), { first: 2, serve: async (tool, input) => {
          const r = await serveRelay(`device:${who.deviceId}`, tool, input);
          out("served", { via: "relay", caller: `device:${who.deviceId}`, call: input && input.call, ok: r && r.ok, ...(r && r.ok === false ? { error: r.error.code } : {}) });
          return r;
        } }); } } }) });
    fs.writeFileSync(path.join(dir, "relay.json"), JSON.stringify({ route, box: box.pub.toString("hex") }));
    await link.ready(10_000);
    out("relay-link", { connected: true, route });
  }
  const nodeKey = `nodekey:${"a".repeat(64)}`;
  net.createServer(sock => {
    admitPeer(socketPipe(sock), { id: { nodeKey }, box: "realrun-box", shared: d => (secrets[d] ? Buffer.from(secrets[d], "hex") : null), serve: async (c, tool, input) => {
      const r = await serve(c, tool, input);
      out("served", { caller: c, call: input && input.call, ok: r && r.ok, ...(r && r.ok === false ? { error: r.error.code } : {}) });
      return r;
    } }).then(({ caller }) => out("admitted", { caller }), e => out("refused", { why: e.message }));
  }).listen(Number(port), "0.0.0.0", () => out("listening", { port: Number(port) }));
  process.on("SIGUSR1", async () => out("state", { members: (await g.members.list(oc)).map(m => `${m.person}:${m.role}`), events: k.log.read({}).filter(e => /^(member|owner|invite)\./.test(e.type)).map(e => e.type) }));
} else if (cmd === "device") {
  const [, how, a1, a2] = rest;
  const { joinPeer, socketPipe, peerSession } = await wink("core/wink/node/peer-wire.js");
  const nodeKey = `nodekey:${"a".repeat(64)}`; // the home's node key, which the device knows from pairing
  const connect = async device => {
    if (how === "relay") {
      const { relayPeer } = await wink("core/wink/node/relay-peer.js"), { deviceSide } = await wink("core/relay/channel.js");
      const rj = JSON.parse(fs.readFileSync(path.join(dir, "relay.json"), "utf8")), n = tbl.noise[device];
      const peer = relayPeer({ deviceSide, url: a1, route: rj.route, box: Buffer.from(rj.box, "hex"), keys: { priv: Buffer.from(n.priv, "hex"), pub: Buffer.from(n.pub, "hex") } });
      return peerSession(await peer.open(SPACE), { first: 1 });
    }
    const [host, port] = [a1, a2];
    const sock = net.connect(Number(port), host);
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    return joinPeer(socketPipe(sock), { device, nodeKey, shared: () => Buffer.from(tbl.secrets[device], "hex") });
  };
  const remoteFor = async device => { const session = await connect(device); return { session, remote: createRemoteKernel({ space: SPACE, transport: winkTransport({ sessionFor: async () => session }) }) }; };
  const alice = loadSigner(tbl.keys.alice), bob = loadSigner(tbl.keys.bob);
  const { id: inviteId } = JSON.parse(fs.readFileSync(path.join(dir, "invite.json"), "utf8"));
  const A = await remoteFor("dev_alice");
  // 1. read members.list as a member (alice, an admin)
  out("members.list", { as: "alice", result: (await A.remote.gateway.grants.members.list({})).map(m => `${m.person}:${m.role}`) });
  // 2. a person who is not a member yet reads the join card and accepts it with their own presence proof
  const B = await remoteFor("dev_bob");
  const card = await B.remote.gateway.grants.invites.get({}, inviteId);
  out("invites.get", { as: "bob", card });
  try { await B.remote.gateway.grants.members.list({}); } catch (e) { out("members.list", { as: "bob (not yet a member)", refused: e.code }); }
  const ar = acceptProofRequest(SPACE, card, BOB);
  const accepted = await B.remote.gateway.grants.invites.accept({}, inviteId, { seen: ar.seen, proof: bob.proof(SPACE, ar.op, ar.fields) });
  out("invites.accept", { as: "bob", role: accepted.membership.role, person: accepted.membership.person });
  // 3. a role change with a fresh presence proof bound to exactly this input
  const input = { person: BOB, role: "manager" }, rq = proofRequest(SPACE, "setRole", input);
  const used = { presence: alice.proof(SPACE, rq.op, rq.fields) };
  const changed = await A.remote.gateway.grants.setRole({}, input, used);
  out("grants.setRole", { as: "alice", result: `${changed.membership.person}:${changed.membership.role}` });
  out("members.list", { as: "alice", result: (await A.remote.gateway.grants.members.list({})).map(m => `${m.person}:${m.role}`) });
  // 4. the refusals that matter
  try { await A.remote.gateway.grants.setRole({}, input, used); out("replay", { ok: "UNEXPECTED" }); } catch (e) { out("setRole again with the same, used proof", { refused: e.code }); }
  try { await A.remote.gateway.grants.setRole({}, { person: BOB, role: "admin" }, {}); } catch (e) { out("setRole without a proof", { refused: e.code }); }
  A.session.close(); B.session.close();
  out("device", { done: true });
  process.exit(0);
} else { console.error("usage: see the header"); process.exit(2); }
