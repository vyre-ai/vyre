// @ts-check
// One walk of the new install and pairing flow for one store choice. Each step is a line in the report; a step that needs an earlier one is skipped when that one failed.
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createApp } from "./app.mjs";
import { reserveAnswer } from "../../../site/setup/reserve.js";
import { codeLooksRight } from "../../../apps/app/screens/install/first-run.js";
import { startDaemonServer } from "./server-daemon.mjs";
import { startInstallerServer } from "./server-installer.mjs";
import { startMacServer } from "./server-mac.mjs";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** @param {{ run: ReturnType<typeof import("./run.mjs").createRun>, ins: Awaited<ReturnType<typeof import("./standins.mjs").startStandins>>, server: "daemon" | "installer" | "mac", store: "records" | "plain", out: string, inCI: boolean }} w */
export async function walk(w) {
  const { run, ins, server, store } = w;
  const tag = `${store}`;
  const S = (/** @type {string} */ n) => `${tag}: ${n}`;
  const dir = path.join(w.out, tag);
  fs.rmSync(dir, { recursive: true, force: true });   // a walk starts from nothing: a home left by an earlier run would already have an owner
  fs.mkdirSync(dir, { recursive: true });
  const pick = store === "records" ? "records" : "plain";
  const person = `walker${store === "records" ? "r" : "p"}${Math.random().toString(36).slice(2, 6)}`;
  const mac = createApp({ label: "Proof Mac", dir: path.join(dir, "mac"), directory: ins.names, relay: ins.relay, capsule: server === "mac" });
  /** @type {any} */ let reservation = null, flow = null, srv = null, session = null;

  try {
    await run.step(S("reserve a name on the setup page"), async () => {
      reservation = await mac.reserve(person);
      assert.match(reservation.code, /^VYRE(-[A-Z0-9]{4}){4}$/);
      return `${reservation.name}, code ${reservation.code.slice(0, 9)}...`;
    });
    await run.step(S("the setup page and the app accept every code the directory can make"), async () => {
      // the directory's alphabet (names/worker/ids.js ALPHA32) against the page's parser (site/setup/reserve.js) and the app's paste check (first-run.js codeLooksRight)
      const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const bad = [];
      for (const ch of alpha) {
        const code = `VYRE-${ch.repeat(4)}-${ch.repeat(4)}-${ch.repeat(4)}-${ch.repeat(4)}`;
        const page = reserveAnswer(200, { data: { code, expires: 1 } }).ok, app = codeLooksRight(code);
        if (!page || !app) bad.push(`${ch}${page ? "" : " page"}${app ? "" : " app"}`);
      }
      assert.equal(bad.length, 0, `refused characters the directory uses: ${bad.join(", ")} (site/setup/reserve.js and apps/app/screens/install/first-run.js accept A-Z and 2-7; names/worker/ids.js makes A-Z without I and O, and 2-9)`);
      assert.ok(reservation.page.ok, "the page took this reservation");
    }, { needs: [S("reserve a name on the setup page")] });
    await run.step(S("become yourself in the app (the code is spent)"), async () => {
      const me = await mac.becomeYourself({ name: reservation.name, code: reservation.code });
      assert.ok(me.id && me.recoveryCode, "an identity and a recovery code");
      const r = await fetch(`${ins.names}/v1/ids/resolve?name=${reservation.name}`);
      assert.equal(r.status, 200, "the directory resolves the new name");
      // the code is good once
      await assert.rejects(mac.becomeYourself({ name: reservation.name, code: reservation.code }), /./, "a second use of the code is refused");
      return `${me.id}`;
    }, { needs: [S("reserve a name on the setup page")] });

    await run.step(S("add a server: the app shows the install line"), async () => {
      flow = mac.addServer();
      await flow.begin(pick);
      const line = flow.state.installLine;
      assert.ok(line.includes(`VYRE_CODE=${flow.state.code}`), "the line carries the one-time code");
      assert.ok(line.includes(`VYRE_STORE=${store === "records" ? "auto" : "sqlite"}`), "the line carries the store choice");
      return line.replace(flow.state.code, "<code>");
    }, { needs: [S("become yourself in the app (the code is spent)")] });

    await run.step(S(`the server installs from the line (${server})`), async () => {
      const a = { dir: path.join(dir, "server"), repo, code: flow.state.code, relayForServer: ins.relayForServer, relayPort: ins.relayPort, hostIp: ins.hostIp, namesForServer: ins.namesForServer, store };
      srv = server === "installer" ? await startInstallerServer(a) : server === "mac" ? await startMacServer(a) : await startDaemonServer({ dir: a.dir, code: a.code, relay: a.relayForServer, directory: a.namesForServer, store, ownerId: mac.identity.id });
      return `${srv.kind}`;
    }, { needs: [S("add a server: the app shows the install line")] });

    await run.step(S("the app finds the server"), async () => {
      await mac.until(() => flow.state.stage === "found" || flow.state.stage === "stopped", 60_000, "the app to find the server");
      assert.equal(flow.state.stage, "found", flow.state.error && flow.state.error.message);
      return `${flow.state.box.name || "server"}`;
    }, { needs: [S(`the server installs from the line (${server})`)] });

    await run.step(S("the four words in the app are the ones the server shows"), async () => {
      const held = await srv.words();
      assert.equal(flow.state.box.words.join(" "), held);
      assert.equal(flow.state.box.words.length, 4);
      return held;
    }, { needs: [S("the app finds the server")] });

    await run.step(S("confirm the words in the app: adopt and pair"), async () => {
      await flow.confirmWords();
      assert.equal(flow.state.stage, "done", flow.state.error && flow.state.error.message);
      assert.ok(mac.pairing && mac.pairing.owner, "the server named this identity its owner");
      return `owner ${JSON.stringify(mac.pairing.owner.id || mac.pairing.owner).slice(0, 40)}`;
    }, { needs: [S("the four words in the app are the ones the server shows")] });

    await run.step(S("the app reaches the server and calls a tool"), async () => {
      await mac.openSession();
      const info = await mac.callTool("system.info");
      assert.ok(info, "system.info answered");
      return `system.info ok`;
    }, { needs: [S("confirm the words in the app: adopt and pair")] });

    const CALL = S("the app reaches the server and calls a tool");
    /** @type {any} */ let team = null, invite = null;
    await run.step(S("create a team space on the server (named in the app, signed with the identity)"), async () => {
      team = await mac.createTeamSpace(`team${person.slice(-6)}`);
      assert.match(team.space, /^spc_/);
      const r = await fetch(`${ins.names}/v1/ids/resolve?name=${team.label}`);
      assert.equal(r.status, 200, "the directory resolves the space's name");
      return team.name;
    }, { needs: [CALL] });
    const noTeams = () => Object.assign(new Error("a release server takes the owner's and the joiner's yes only from a hardware key (Touch ID, Face ID); this headless app has software keys, so invites and Join are walked only on the daemon server"), { skip: true });
    if (store === "records") {
      await run.step(S("the record store (Records) answers"), async () => {
        let last = "";
        for (let i = 0; i < 24; i++) { try { await mac.callTool("records.me", {}); return `up after ${i * 10} s`; } catch (e) { last = String(/** @type {Error} */ (e).message); await new Promise(r => setTimeout(r, 10_000)); } }
        throw new Error(`the record store was not up after 4 minutes: ${last}`);
      }, { needs: [CALL] });
    }
    /** @type {any} */ let bob = null, bobName = "";
    await run.step(S("invite a second person to the team (the owner's app asks its own key)"), async () => {
      if (server !== "daemon") throw noTeams();
      bob = createApp({ label: "Proof second Mac", dir: path.join(dir, "second"), directory: ins.names, relay: ins.relay });
      const r = await bob.reserve(`second${store === "records" ? "r" : "p"}${Math.random().toString(36).slice(2, 6)}`);
      await bob.becomeYourself({ name: r.name, code: r.code });
      bobName = r.name;
      const t = srv.team;
      const ownerChain = t.ownerChain(team.space, mac.identity.id);
      const asked = [];
      invite = await mac.makeTeamInvite({ space: team.space, name: team.label, to: bobName, signPresence: async card => { asked.push(card.op); return t.ownerSigner.proof(ownerChain, card.op, card.fields, { extra: { home: card.home, challenge: card.challenge } }); } });
      invite.ownerChain = ownerChain;
      invite.close();
      assert.match(invite.link, /^https:\/\/[a-z0-9-]+\.vyre\.run\/join\/inv_[0-9a-f]{32}\./);
      assert.deepEqual(asked, ["grant.invite"], "the owner's key was asked once, for this invite");
      return "a member invite signed by the owner's app";
    }, { needs: [S("create a team space on the server (named in the app, signed with the identity)")] });
    await run.step(S("a second identity joins the team from its own app, with no server of its own"), async () => {
      const t = srv.team;
      const sg = t.signerFor(bob.identity.id);
      const chain = t.inviteeChain(team.space, bob.identity.id);
      const joined = await bob.joinTeam({ link: invite.link, signPresence: async req => sg.proof(chain, req.op, req.fields), presenceKey: async () => sg.enrolment });
      assert.equal(joined.joined.joined, true);
      const member = await t.memberOf(team.space, invite.ownerChain, bob.identity.id);
      assert.deepEqual([member.person, member.role], [bob.identity.id, "member"]);
      const list = await joined.call("grants.members.list", []);
      const people = (Array.isArray(list) ? list : list.members || []).map((/** @type {any} */ m) => m.person);
      assert.ok(people.includes(bob.identity.id), "the member reaches the space through the member door");
      return `${bobName} is a member`;
    }, { needs: [S("invite a second person to the team (the owner's app asks its own key)")] });

    /** @type {any} */ let code = null, askSeen = null;
    const phone = createApp({ label: "Proof phone", dir: path.join(dir, "phone"), directory: ins.names, relay: ins.relay, about: { kind: "app" } });
    try {
      await run.step(S("add a device: the computer shows a code"), async () => {
        try { code = await mac.showDeviceCode(); } catch (e) {
          // A release server takes presence only from a hardware key (Touch ID, Face ID, a phone's chip); this headless app has a software key, so it cannot answer the server's request. Not a product fault.
          if (/** @type {any} */ (e).code === "presence_required" && /software/.test(String(/** @type {Error} */ (e).message))) throw Object.assign(new Error("a release server wants a hardware presence key (Touch ID, Face ID); this headless app has a software key, so Add a device is walked only on the daemon server"), { skip: true });
          throw e;
        }
        assert.match(code.qr, /^vyre:\/\/wink\/2\?/);
        return "a code for the new device";
      }, { needs: [CALL] });
      await run.step(S("add a device: the phone joins the name and the computer says yes to its three words"), async () => {
        /** @type {string[]} */ const shown = [];
        const joining = phone.addThisDeviceToName({ payload: code.qr, onWords: w => shown.push(w) });
        const failed = new Promise((_, rej) => joining.catch(rej));
        failed.catch(() => {});
        const ask = /** @type {any} */ (await Promise.race([mac.answerDevice(), failed]));
        askSeen = ask.seen;
        await phone.until(() => shown.length, 15_000, "the phone to show its words");
        await mac.sayYes(shown[0].split(" "), ask.raw);
        // the name's key lives in this app, not on the server: the server asks this app to sign the list change (wink.phone.pairing `enrol`), as the Devices screen's serveEnrol does
        await mac.serveEnrol();
        const r = await joining;
        assert.equal(r.id, mac.identity.id, "the phone joined this person's identity");
        return `${shown[0]}`;
      }, { needs: [S("add a device: the computer shows a code")] });
      await run.step(S("the computer's Devices screen sees the phone asking"), async () => {
        // the app reads wink.phone.pairing with screens/devices/real.js phoneAsk; a server answer it cannot read leaves the person with no question to answer
        assert.ok(askSeen && askSeen.asking, "phoneAsk read the server's answer as nobody asking; the server answered {asking, name, choices, until, line} and phoneAsk wants `words` (apps/app/screens/devices/real.js:107, apps/app/screens/pairing/model.ts winkAsking)");
      }, { needs: [S("add a device: the phone joins the name and the computer says yes to its three words")] });
      await run.step(S("the phone is on the name's signed list"), async () => {
        const res = await fetch(`${ins.names}/v1/ids/resolve?name=${mac.identity.name}`);
        const json = await res.json();
        const ops = JSON.stringify(json.data.ops);
        assert.ok(ops.includes(phone.identity.key.eid) || ops.includes(phone.identity.key.publicKey), "the phone's key is on the list");
      }, { needs: [S("add a device: the phone joins the name and the computer says yes to its three words")] });
      await run.step(S("the phone reaches the server and calls a tool"), async () => {
        await phone.openSession();
        const info = await phone.callTool("system.info");
        assert.ok(info, "system.info answered");
      }, { needs: [S("add a device: the phone joins the name and the computer says yes to its three words")] });
    } finally { phone.close(); if (bob) bob.close(); }
  } finally {
    mac.close();
    if (srv) {
      try { fs.writeFileSync(path.join(dir, "server.log"), (srv.logs || []).join("\n") + "\n"); } catch { /* the log is a courtesy */ }
      await srv.stop().catch(() => {});
    }
  }
}


/**
 * The server's own terminal path (IR-35, the pairing bug): a server installed with no setup code shows a long code and a typed code, and the app pairs it from them. A fresh server used to refuse the
 * app's hello ("not a paired device") on both. Each way is a fresh server and a fresh identity, then a tool call as the paired app.
 * @param {{ run: ReturnType<typeof import("./run.mjs").createRun>, ins: Awaited<ReturnType<typeof import("./standins.mjs").startStandins>>, server: "daemon" | "installer" | "mac", out: string }} w
 */
export async function walkTerminal(w) {
  const { run, ins, server } = w;
  if (server !== "daemon") {
    // One setup: the installers no longer pair from their own terminal. A line run with no code from the app says where to go and starts no pairing.
    const dir = path.join(w.out, "no-code");
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    await run.step("no code: the install line without the app's code sends the person to the app and starts no pairing", async () => {
      const a = { dir, repo, code: "", relayForServer: ins.relayForServer, relayPort: ins.relayPort, hostIp: ins.hostIp, namesForServer: ins.namesForServer, store: /** @type {const} */ ("plain"), noCodeProbe: true };
      const r = /** @type {any} */ (server === "installer" ? await startInstallerServer(a) : await startMacServer(a));
      const out = String(r.output || "");
      fs.writeFileSync(path.join(dir, "output.txt"), out);
      assert.match(out, /Open the Vyre app, choose "Add a server", and run the line it shows/, "the installer says where to go");
      assert.doesNotMatch(out, /WINK-[A-Z0-9]{4}|vyre:\/\/wink\/|run vyre call wink\.server\.code/, "it printed a pairing code of its own");
      return "sent to the app, no pairing code";
    });
    return;
  }
  for (const way of /** @type {("long code" | "typed code" | "typed code in a browser")[]} */ (["long code", "typed code", "typed code in a browser", "typed code, no identity proof"])) {
    const browser = way === "typed code in a browser" || way === "typed code, no identity proof";   // a plain web page, not the Mac or Windows app
    const noProof = way === "typed code, no identity proof";   // a stranger with only the typed code and no identity proof
    const tag = `terminal ${way}`;
    const S = (/** @type {string} */ n) => `${tag}: ${n}`;
    const dir = path.join(w.out, tag.replace(/[ ,]+/g, "-"));
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const mac = createApp({ label: "Proof Mac", dir: path.join(dir, "mac"), directory: ins.names, relay: ins.relay, capsule: server === "mac" });
    /** @type {any} */ let srv = null, made = null;
    try {
      await run.step(S("the app has an identity"), async () => {
        const r = await mac.reserve(`walkert${Math.random().toString(36).slice(2, 7)}`);
        await mac.becomeYourself({ name: r.name, code: r.code });
      });
      await run.step(S("a fresh server with no setup code shows its code"), async () => {
        const a = { dir: path.join(dir, "server"), repo, code: "", relayForServer: ins.relayForServer, relayPort: ins.relayPort, hostIp: ins.hostIp, namesForServer: ins.namesForServer, store: /** @type {const} */ ("plain") };
        srv = server === "installer" ? await startInstallerServer(a) : server === "mac" ? await startMacServer(a) : await startDaemonServer({ dir: a.dir, code: "", relay: a.relayForServer, directory: a.namesForServer, store: "plain" });
        // the relay link of a fresh server can still be coming up; the server says "try again in a minute", so try for half of one
        for (let i = 0; ; i++) { try { made = await srv.operator("wink.server.code", { qr: true }); break; } catch (e) { if (i >= 15 || !/relay gave no code/.test(String(/** @type {Error} */ (e).message))) { let st = ""; try { st = JSON.stringify(await srv.operator("relay.status", {})).slice(0, 500); } catch (e2) { st = String(/** @type {Error} */ (e2).message).slice(0, 200); } throw Object.assign(new Error(`${/** @type {Error} */ (e).message} relay.status: ${st}`), { code: /** @type {any} */ (e).code }); } await new Promise(r => setTimeout(r, 2000)); } }
        assert.ok(made && (way === "long code" ? /^vyre:\/\/wink\/2\?/.test(made.qr) : /^WINK-/.test(made.code)), `the server showed a ${way}`);
        return way === "long code" ? "a long code" : String(made.code).slice(0, 9) + "...";
      }, { needs: [S("the app has an identity")] });
      await run.step(S("the app pairs the server and the server names this identity its owner"), async () => {
        if (way === "long code") {
          const pairing = mac.pairWithServer(made.qr);
          pairing.catch(() => {});
          const ask = await mac.until(async () => { const x = await srv.operator("wink.server.pairing", {}); return x && x.asking ? x : null; }, 30_000, "the server to ask who is pairing");
          const shown = await mac.until(() => mac.lastWords(), 15_000, "the app to show its three words");
          assert.ok(ask.choices.includes(shown), "the server offers the words the app shows");
          await srv.operator("wink.server.pair.answer", { yes: true, pick: ask.choices.indexOf(shown) + 1 });
          const r = await pairing;
          assert.ok(r.owner, "the server named an owner");
        } else {
          const r = await (noProof ? mac.pairByTypedCodeNoProof : mac.pairByTypedCode)({ input: made.code, typedAck: async ack => { await srv.operator("wink.server.confirm", { offer: made.offer, typed: ack }); } });
          if (!noProof) assert.ok(r.owner, "the server named an owner");
        }
      }, { needs: [S("a fresh server with no setup code shows its code")] });
      if (browser) {
        if (noProof) {
          await run.step(S("a browser with no owner proof gets no signed-in session"), async () => {
            let said = "";
            try { await mac.openSession(); } catch (e) { said = String(/** @type {Error} */ (e).message); }
            assert.ok(said, "a device that redeemed the typed code without the owner's identity proof got a signed-in session");
            return `refused: ${said.slice(0, 80)}`;
          }, { needs: [S("the app pairs the server and the server names this identity its owner")] });
        } else {
          await run.step(S("a browser that paired with the owner's identity proof is a device like any other: it has a signed-in session"), async () => {
            await mac.openSession();
            assert.ok(await mac.callTool("system.info"), "system.info answered");
          }, { needs: [S("the app pairs the server and the server names this identity its owner")] });
        }
        continue;
      }
      await run.step(S("the server made this app a signed-in session"), async () => {
        const p = mac.pairing;
        assert.notEqual(p.session, false, "the server paired the app but made it no session (adopt answered session:false), so the app cannot sign in and calls to the server are refused; the long code path gives the same app a session");
      }, { needs: [S("the app pairs the server and the server names this identity its owner")] });
      await run.step(S("the paired app reaches the server and calls a tool"), async () => {
        await mac.openSession();
        const info = await mac.callTool("system.info");
        assert.ok(info, "system.info answered");
      }, { needs: [S("the server made this app a signed-in session")] });
    } finally {
      mac.close();
      if (srv) await srv.stop().catch(() => {});
    }
  }
}

/**
 * The update walk (--update): an app with its own identity pairs a server that is the OLD release (v0.2.11 by default, installed by that release's own installer, which has no setup-code flow: it shows its
 * long code), then asks for the update from the app. The steps are in updateSteps.
 * @param {{ run: ReturnType<typeof import("./run.mjs").createRun>, ins: Awaited<ReturnType<typeof import("./standins.mjs").startStandins>>, out: string, update: { oldVersion: string, newVersion: string, oldBox: string, oldUrl: string, newUrl: string, pub: string } }} w
 */
export async function walkUpdate(w) {
  const { run, ins, update } = w;
  const tag = "update";
  const S = (/** @type {string} */ n) => `${tag}: ${n}`;
  const dir = path.join(w.out, tag);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const mac = createApp({ label: "Proof Mac", dir: path.join(dir, "mac"), directory: ins.names, relay: ins.relay });
  /** @type {any} */ let srv = null, made = null;
  try {
    await run.step(S("the app has an identity"), async () => {
      const r = await mac.reserve(`walkeru${Math.random().toString(36).slice(2, 7)}`);
      await mac.becomeYourself({ name: r.name, code: r.code });
    });
    await run.step(S(`the old release (${update.oldVersion}) installs with its own installer and shows its code`), async () => {
      const a = { dir: path.join(dir, "server"), repo, code: "", relayForServer: ins.relayForServer, relayPort: ins.relayPort, hostIp: ins.hostIp, namesForServer: ins.namesForServer, store: /** @type {const} */ ("plain"), release: update };
      srv = await startInstallerServer(a);
      for (let i = 0; ; i++) { try { made = await srv.operator("wink.server.code", { qr: true }); break; } catch (e) { if (i >= 200 || !/relay gave no code/.test(String(/** @type {Error} */ (e).message))) { let st = ""; try { st = JSON.stringify(await srv.operator("relay.connected", {})); } catch (x) { st = String(/** @type {Error} */ (x).message); } throw new Error(`${/** @type {Error} */ (e).message} (relay.connected: ${st.slice(0, 200)})`); } await new Promise(r => setTimeout(r, 2000)); } }
      assert.ok(made && /^vyre:\/\/wink\/2\?/.test(made.qr), "the server showed a long code");
      return "a long code";
    }, { needs: [S("the app has an identity")] });
    const PAIR = S("the app pairs the server and the server names this identity its owner");
    await run.step(PAIR, async () => {
      const pairing = mac.pairWithServer(made.qr);
      pairing.catch(() => {});
      const ask = await mac.until(async () => { const x = await srv.operator("wink.server.pairing", {}); return x && x.asking ? x : null; }, 30_000, "the server to ask who is pairing");
      const shown = await mac.until(() => mac.lastWords(), 15_000, "the app to show its three words");
      assert.ok(ask.choices.includes(shown), "the server offers the words the app shows");
      await srv.operator("wink.server.pair.answer", { yes: true, pick: ask.choices.indexOf(shown) + 1 });
      const r = await pairing;
      assert.ok(r.owner, "the server named an owner");
    }, { needs: [S(`the old release (${update.oldVersion}) installs with its own installer and shows its code`)] });
    await run.step(S("the app reaches the server and calls a tool"), async () => {
      await mac.openSession();
      assert.ok(await mac.callTool("system.info"), "system.info answered");
    }, { needs: [PAIR] });
    await updateSteps({ w: { update }, run, S, mac, srv: () => srv, CALL: S("the app reaches the server and calls a tool") });
  } finally {
    try { if (srv) await srv.stop(); } catch { /* gone */ }
  }
}

/**
 * The update, from the app. The server was installed from the OLD release (v0.2.11 by default); the app asks for the update the way its Settings button does (update.status, then update.apply over its paired session, no ssh), and the box's own
 * root unit downloads the candidate, checks its signature, backs up, swaps and restarts. Then the same app, with no new pairing, finds the new version and everything it wrote before.
 * @param {{ w: any, run: any, S: (n: string) => string, mac: any, srv: () => any, CALL: string }} a
 */
async function updateSteps({ w, run, S, mac, srv, CALL }) {
  const u = w.update;
  const U = (/** @type {string} */ n) => S(n);
  /** @type {any} */ let before = null, notice = null;
  const sorted = (/** @type {any} */ l) => JSON.stringify((Array.isArray(l) ? l : (l && (l.items || l.entries || l.notes)) || []).map((/** @type {any} */ x) => (typeof x === "string" ? x : JSON.stringify({ name: x.name, kind: x.kind, text: x.text, id: x.id }))).sort());
  await run.step(U("the server runs the old release and the app shows its notice"), async () => {
    notice = await mac.callTool("update.status");
    assert.equal(notice.current, u.oldVersion, `the server runs ${notice.current}, not ${u.oldVersion}`);
    // what the app's Settings notice needs to show (apps/app/screens/settings/update-model.js showNotice): a newer version out, and an update the server can take from here
    assert.equal(notice.available, u.newVersion, "the notice names the candidate");
    assert.equal(notice.canApply, true, "the server takes the request from the app (the host's update unit is installed)");
    assert.ok(!notice.pending && !(notice.run && notice.run.state === "running"), "no update is running yet");
    return `${notice.current} -> ${notice.available}`;
  }, { needs: [CALL] });
  await run.step(U("write a vault item and records, and read them back"), async () => {
    await mac.callTool("vault.put", { name: "proof-update-secret", kind: "secret", value: "update-proof-value-1" });
    // a 0.2.11 server keeps its records in the Twenty store its installer chose, which can take minutes to come up after the install
    for (let i = 0; ; i++) { try { await mac.callTool("planner.add", { kind: "note", text: "written before the update" }); break; } catch (e) { if (i >= 40) throw e; await new Promise(r => setTimeout(r, 10_000)); } }
    const vault = await mac.callTool("vault.list", {}), plan = await mac.callTool("planner.list", {});
    assert.match(JSON.stringify(vault), /proof-update-secret/, "the vault lists the item");
    assert.match(JSON.stringify(plan), /written before the update/, "the planner lists the note");
    const info = await mac.callTool("system.info");
    before = { vault: sorted(vault), plan: sorted(plan), owner: JSON.stringify(mac.pairing.owner), device: JSON.stringify(mac.pairing.device && mac.pairing.device.id || null), info: info && info.version };
    return `vault ${JSON.parse(before.vault).length} item(s), planner ${JSON.parse(before.plan).length}`;
  }, { needs: [U("the server runs the old release and the app shows its notice")] });
  await run.step(U("the app asks for the update (update.apply, the Settings button's call)"), async () => {
    const r = await mac.callTool("update.apply");
    assert.equal(r.requested, true, `the request was not taken: ${JSON.stringify(r).slice(0, 200)}`);
    return "requested";
  }, { needs: [U("write a vault item and records, and read them back")] });
  await run.step(U("the host's unit installs the candidate and the server comes back as it"), async () => {
    // the container restarts under the app: the old session is gone, so the app opens its next one the way it does after any restart
    let last = "", st = null;
    for (let i = 0; i < 120 && !st; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try { await mac.openSession(); const s = await mac.callTool("update.status"); if (s.current === u.newVersion) st = s; else last = `still ${s.current}, run ${JSON.stringify(s.run && { state: s.run.state, stage: s.run.stage, message: s.run.message })}`; }
      catch (e) { last = String(/** @type {Error} */ (e).message).slice(0, 160); }
    }
    assert.ok(st, `the server did not come back on ${u.newVersion} within 10 minutes: ${last}`);
    assert.equal(st.current, u.newVersion, "the version changed");
    return `${notice.current} -> ${st.current}`;
  }, { needs: [U("the app asks for the update (update.apply, the Settings button's call)")] });
  const BACK = U("the host's unit installs the candidate and the server comes back as it");
  await run.step(U("the notice is gone"), async () => {
    const st = await mac.callTool("update.status");
    assert.equal(st.available, null, "no newer version is offered any more");
    assert.deepEqual(st.notes, [], "no notes are left to show");
    assert.ok(!st.pending, "no request is waiting");
    assert.ok(!st.run || st.run.state === "ok", `the host says the run ${st.run && st.run.state}: ${st.run && st.run.message}`);
    return `current ${st.current}, available null`;
  }, { needs: [BACK] });
  await run.step(U("the vault, the records and the app's sign-in are untouched"), async () => {
    // the same pairing (no code, no words, no new owner) opened this session; the owner and the device are the ones from before
    assert.equal(JSON.stringify(mac.pairing.owner), before.owner, "the owner is unchanged");
    const vault = await mac.callTool("vault.list", {}), plan = await mac.callTool("planner.list", {});
    assert.equal(sorted(vault), before.vault, "the vault lists exactly what it listed before");
    assert.equal(sorted(plan), before.plan, "the planner lists exactly what it listed before");
    const info = await mac.callTool("system.info");
    assert.ok(info, "the signed-in app is still answered");
    return "vault, planner and sign-in as before";
  }, { needs: [BACK] });
}
