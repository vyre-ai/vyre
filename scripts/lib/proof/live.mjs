// @ts-check
// The live walk (scripts/proof-install.mjs --live --host <ssh host>): the real services and a real server, no stand-ins.
//   names directory   https://names.vyre.run   a throwaway name is reserved through /v1/ids/reserve, exactly as vyre.run/setup does, then claimed by the app's paste-code claim
//   relay             wss://relay.vyre.run
//   server            a droplet reached over ssh, installed with the EXACT line the app's Add a server shows (curl -fsSL vyre.run/i | VYRE_CODE=... VYRE_STORE=... sh), so it is the published
//                     release and not a checkout
//   app               the headless app driver (scripts/lib/proof/app.mjs)
// It never runs Vyre on the machine it runs from: run it on a test box. Every name it makes is written to <out>/names.json so scripts/proof-live-drop.mjs can free them with the support
// admin drop; with VYRE_NAMES_ADMIN_SECRET in the environment the walk frees them itself at the end. The secret is never printed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "./app.mjs";
import { startChat } from "../../journeys/lib/chat.mjs";

export const LIVE = Object.freeze({ names: "https://names.vyre.run", relay: "wss://relay.vyre.run" });
const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

/**
 * Run a command on the server over ssh. With `pty` it gets a terminal like a person's, and answers yes to the installer's [y/N] questions the way the person would.
 * @param {string} host @param {string} cmd @param {{ pty?: boolean, timeoutMs?: number, log?: (s: string) => void, input?: string, user?: string }} [o]
 * @returns {Promise<{ code: number, out: string }>}
 */
export function ssh(host, cmd, o = {}) { return sshStart(host, cmd, o).done; }

/**
 * The same, but running: `out()` is what the terminal has shown so far, `done` settles when the command ends. The install uses this, because the app is waiting while the installer runs.
 * @param {string} host @param {string} cmd @param {{ pty?: boolean, timeoutMs?: number, log?: (s: string) => void, input?: string, user?: string }} [o]
 */
export function sshStart(host, cmd, o = {}) {
  const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", ...(o.user ? ["-l", o.user] : []), o.pty ? "-tt" : "-T", host, cmd];
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  let out = "", asked = 0;
  const onData = (/** @type {Buffer} */ d) => {
    const s = String(d); out += s; if (o.log) o.log(s);
    if (o.pty && /\[y\/N\]\s*$/.test(strip(out.slice(-200)))) { asked++; child.stdin.write("y\n"); out += `\n[the walk answered y (${asked})]\n`; }
  };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  if (o.input !== undefined) { child.stdin.write(o.input); if (!o.pty) child.stdin.end(); } else if (!o.pty) child.stdin.end();
  /** @type {Promise<{ code: number, out: string }>} */
  const done = new Promise(resolve => {
    const timer = setTimeout(() => { out += "\n[the walk gave up waiting]\n"; child.kill("SIGTERM"); }, o.timeoutMs ?? 30 * 60_000);
    child.on("close", code => { clearTimeout(timer); resolve({ code: code ?? 1, out: strip(out) }); });
  });
  return { out: () => strip(out), done };
}

/** The user a person would install as: not root, with sudo. @param {string} host */
export async function ensureWalker(host) {
  const r = await ssh(host, `id walker >/dev/null 2>&1 || (adduser --disabled-password --gecos '' walker >/dev/null && echo 'walker ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/walker && chmod 440 /etc/sudoers.d/walker); install -d -m 700 -o walker -g walker /home/walker/.ssh && cp /root/.ssh/authorized_keys /home/walker/.ssh/authorized_keys && chown walker:walker /home/walker/.ssh/authorized_keys && chmod 600 /home/walker/.ssh/authorized_keys; id walker`);
  if (r.code !== 0) throw new Error(`could not make the install user on ${host}: ${r.out.slice(-200)}`);
}

/** Run `cmd` as walker over its own ssh login, so it has a real terminal (the installer reads /dev/tty to ask its questions) and the PATH a person has. @param {string} host @param {string} cmd @param {any} [o] */
export const asWalker = (host, cmd, o = {}) => ssh(host, cmd, { ...o, user: "walker" });

/** Take everything off the server: Vyre, its containers and volumes, its folders. Safe on a server that has nothing. @param {string} host */
export async function wipeServer(host) {
  await asWalker(host, "command -v vyre >/dev/null 2>&1 && sudo vyre uninstall --delete-data --yes || true", { pty: true, timeoutMs: 10 * 60_000 });
  return ssh(host, "command -v docker >/dev/null 2>&1 && (docker ps -aq | xargs -r docker rm -f; docker system prune -af --volumes) >/dev/null 2>&1; rm -rf /srv/vyre /home/walker/.vyre /usr/local/bin/vyre; echo wiped", { timeoutMs: 15 * 60_000 });
}

/**
 * Start the install from the line the app showed, on the server, and keep it running: the app is waiting for the server while the installer waits for the app, as it is for a person. The
 * installer asks for Docker itself on a fresh server ([y/N]) and the walk answers y the way a person would.
 * @param {string} host @param {string} line @param {string} out
 */
export function startInstall(host, line, out) {
  fs.mkdirSync(out, { recursive: true });
  const run = sshStart(host, line, { pty: true, user: "walker", timeoutMs: 40 * 60_000 });
  const finished = run.done.then(r => { fs.writeFileSync(path.join(out, `install-${Date.now()}.log`), r.out.replace(/VYRE_CODE=\S+/g, "VYRE_CODE=<hidden>")); return r; });
  return {
    /** The four words the installer printed, once it has. */
    async words(/** @type {number} */ ms = 25 * 60_000) {
      const end = Date.now() + ms;
      for (;;) {
        const m = run.out().match(/Your four words:\s*([a-z]+(?: [a-z]+){3})/);
        if (m) return m[1];
        // The installer can end before the server has the words ("The four words did not show yet. To see them, run: sudo vyre words"). A person runs that, in a second terminal, so the walk does.
        if (/did not show yet/.test(run.out())) {
          for (let i = 0; i < 24; i++) {
            const w = await asWalker(host, "sudo vyre words 2>&1", { pty: true, timeoutMs: 60_000 });
            const line = w.out.split("\n").map(l => l.trim()).find(l => /^[a-z]+( [a-z]+){3}$/.test(l));
            if (line) return line;
            await new Promise(r => setTimeout(r, 5000));
          }
          throw new Error("`sudo vyre words` showed no four words in two minutes");
        }
        const r = await Promise.race([finished, new Promise(res => setTimeout(() => res(null), 1000))]);
        // The installer prints the words and ends at once (it does not wait for the app), so it can end inside this second: read what it printed before calling that an end without words.
        if (r) { const last = run.out().match(/Your four words:\s*([a-z]+(?: [a-z]+){3})/); if (last) return last[1]; }
        if (r) throw new Error(`the installer ended before it showed four words (exit ${/** @type {any} */ (r).code}): ${tailOf(/** @type {any} */ (r).out)}`);
        if (Date.now() > end) throw new Error(`the installer showed no four words in ${Math.round(ms / 60000)} minutes: ${tailOf(run.out())}`);
      }
    },
    /** The installer's end: its exit code and the last lines it printed. */
    async finish() { const r = await finished; return { code: r.code, tail: tailOf(r.out), out: r.out }; },
  };
}
const tailOf = (/** @type {string} */ s) => s.split("\n").filter(l => l.trim() && !/█|▀|▄/.test(l)).slice(-6).join(" | ").slice(0, 500);

/**
 * @param {{ run: ReturnType<typeof import("./run.mjs").createRun>, host: string, out: string, expectVersion?: string, channel?: string }} w
 *   expectVersion: the release under test. The first server installs whatever vyre.run serves now (the previous release, until the new one is published and deployed), then the walk waits for
 *   the box to see expectVersion and updates from the app as the Settings button does. A second install, after the new release is out, must land on expectVersion at once.
 */
export async function walkLive(w) {
  const { run, host } = w;
  const expectVersion = w.expectVersion || "";
  // channel "beta": the server installs the stable release the line serves, then is put on the beta channel (VYRE_CHANNEL in its .env, the way a person opts in), so its update offers the release candidate.
  const channel = w.channel === "beta" ? "beta" : "";
  const dir = path.join(w.out, "live");
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  /** @type {string[]} */ const names = [];
  const keep = () => fs.writeFileSync(path.join(w.out, "names.json"), JSON.stringify(names));
  const person = `walk${Math.random().toString(36).slice(2, 8)}`;
  const mac = createApp({ label: "Proof Mac", dir: path.join(dir, "mac"), directory: LIVE.names, relay: LIVE.relay });
  /** @type {any} */ let reservation = null, team = null;
  let installedVersion = "";
  const R = (/** @type {string} */ n) => `records: ${n}`, P = (/** @type {string} */ n) => `without records: ${n}`;

  /** The Add a server walk for one store choice, from the app's install line to a tool call. */
  const server = async (/** @type {"records" | "plain"} */ store, /** @type {(n: string) => string} */ S, /** @type {string[]} */ needs) => {
    /** @type {any} */ let flow = null, installed = null;
    const pick = store === "records" ? "records" : "plain";
    await run.step(S("add a server: the app shows the install line"), async () => {
      flow = mac.addServer();
      await flow.begin(pick);
      const line = flow.state.installLine;
      assert.ok(line.includes(`VYRE_CODE=${flow.state.code}`), "the line carries the one-time code");
      assert.ok(line.includes(`VYRE_STORE=${store === "records" ? "auto" : "sqlite"}`), "the line carries the store choice");
      assert.match(line, /^curl -fsSL vyre\.run\/i \| /, "the line is the published installer");
      return line.replace(flow.state.code, "<code>");
    }, { needs });
    await run.step(S("the server installs from that line (the published release): it shows four words"), async () => {
      installed = startInstall(host, flow.state.installLine, dir);
      const words = await installed.words();
      return words;
    }, { needs: [S("add a server: the app shows the install line")] });
    await run.step(S("the app finds the server"), async () => {
      await mac.until(() => flow.state.stage === "found" || flow.state.stage === "stopped", 120_000, "the app to find the server");
      assert.equal(flow.state.stage, "found", flow.state.error && flow.state.error.message);
      return `${flow.state.box.name || "server"}`;
    }, { needs: [S("the server installs from that line (the published release): it shows four words")] });
    await run.step(S("the four words in the app are the ones the server shows"), async () => {
      const held = await installed.words();
      assert.equal(flow.state.box.words.join(" "), held);
      assert.equal(flow.state.box.words.length, 4);
      return held;
    }, { needs: [S("the app finds the server")] });
    await run.step(S("confirm the words in the app: adopt and pair"), async () => {
      await flow.confirmWords();
      assert.equal(flow.state.stage, "done", flow.state.error && flow.state.error.message);
      assert.ok(mac.pairing && mac.pairing.owner, "the server named this identity its owner");
    }, { needs: [S("the four words in the app are the ones the server shows")] });
    await run.step(S("the installer finishes on the server once the app has adopted it"), async () => {
      const r = await installed.finish();
      assert.equal(r.code, 0, `the installer exited ${r.code}: ${r.tail}`);
      const v = await asWalker(host, "sudo vyre --version 2>&1 || sudo vyre version 2>&1");
      const ver = (v.out.match(/\b\d+\.\d+\.\d+\S*/) || [""])[0];
      installedVersion = ver;
      if (expectVersion && store === "plain") assert.equal(ver, expectVersion, `the server runs ${ver || "no version"}, not ${expectVersion}`);
      return `exit 0${ver ? `, ${ver}` : ""}`;
    }, { needs: [S("confirm the words in the app: adopt and pair")] });
    await run.step(S("the app reaches the server and calls a tool"), async () => {
      await mac.openSession();
      assert.ok(await mac.callTool("system.info"), "system.info answered");
      return "system.info ok";
    }, { needs: [S("confirm the words in the app: adopt and pair")] });
    return S("the app reaches the server and calls a tool");
  };

  try {
    await run.step("live: the real names directory and relay answer", async () => {
      const h = await fetch(`${LIVE.names}/health`);
      assert.equal(h.status, 200, `names.vyre.run /health answered ${h.status}`);
      const s = await ssh(host, "echo up");
      assert.match(s.out, /up/, `ssh ${host}: ${s.out.slice(-120)}`);
      await ensureWalker(host);
      return "names.vyre.run, relay.vyre.run, and the server over ssh";
    });
    const up = "live: the real names directory and relay answer";
    await run.step("server: start from nothing", async () => { const r = await wipeServer(host); assert.match(r.out, /wiped/, r.out.slice(-200)); }, { needs: [up] });
    await run.step(R("reserve a throwaway name on the real directory"), async () => {
      reservation = await mac.reserve(person);
      names.push(reservation.name); keep();
      assert.match(reservation.code, /^VYRE(-[A-Z0-9]{4}){4}$/);
      assert.ok(reservation.page.ok, "the setup page took this reservation");
      return `${reservation.name}, code ${reservation.code.slice(0, 9)}...`;
    }, { needs: ["server: start from nothing"] });
    await run.step(R("become yourself in the app (the code is spent)"), async () => {
      const me = await mac.becomeYourself({ name: reservation.name, code: reservation.code });
      assert.ok(me.id && me.recoveryCode, "an identity and a recovery code");
      const r = await fetch(`${LIVE.names}/v1/ids/resolve?name=${reservation.name}`);
      assert.equal(r.status, 200, "the directory resolves the new name");
      return me.id;
    }, { needs: [R("reserve a throwaway name on the real directory")] });
    const called = await server("records", R, [R("become yourself in the app (the code is spent)")]);

    await run.step(R("the record store (Records) answers"), async () => {
      let last = "";
      for (let i = 0; i < 48; i++) { try { await mac.callTool("records.me", {}); return `up after ${i * 10} s`; } catch (e) { last = String(/** @type {Error} */ (e).message); await new Promise(r => setTimeout(r, 10_000)); } }
      throw new Error(`the record store was not up after 8 minutes: ${last}`);
    }, { needs: [called] });
    await run.step(R("first chat: the assistant's own chat is made the way the app makes it and listed as the pinned one"), async () => {
      const w = { call: (/** @type {string} */ t, /** @type {any} */ i) => mac.callTool(t, i) };
      const have = await mac.callTool("work.chat.persistent", { kind: "assistant" });
      assert.equal(have.allowed, true, "the owner may have an assistant chat");
      const chat = have.chat || await startChat(w, "Assistant");
      if (!have.chat) await mac.callTool("work.chat.pin", { kind: "assistant", chat });
      const list = await mac.callTool("work.chat.list", {});
      const row = (list.chats || []).find((/** @type {any} */ c) => (c.chat || c.id) === chat);
      assert.equal(row && row.pinned, "assistant", "the Chats list marks it pinned");
      return chat;
    }, { needs: [called] });
    // The real model answers (only when the run was given a Claude subscription token: RC_CLAUDE_TOKEN, read from the environment once and removed at once). The token is put on the server's disk for one command
    // at mode 0600 over ssh stdin (never in a command line of the runner, never in a log), the server's own onboarding stores it in the Vault (onboard.claude) and its assistant greets (onboard.finish), and the
    // file is overwritten and removed whether the call worked or not. A release server takes this from its own terminal (root's cli); the app's call would want the owner's hardware key.
    if (process.env.RC_CLAUDE_TOKEN) {
      const token = String(process.env.RC_CLAUDE_TOKEN); delete process.env.RC_CLAUDE_TOKEN;
      const scrub = (/** @type {string} */ t) => String(t).split(token).join("<token>");
      await run.step(R("first chat with the real model: the server signs in to Claude with the subscription token and its assistant greets"), async () => {
        const file = "/root/.vyre-walk-claude.json";
        try {
          const put = await asWalker(host, `sudo sh -c 'umask 077; cat > ${file}'`, { pty: false, input: JSON.stringify({ kind: "subscription", token }) });
          assert.equal(put.code, 0, scrub(put.out.slice(-200)));
          const sign = await asWalker(host, `sudo sh -c 'vyre call onboard.claude "$(cat ${file})"'`, { pty: false, timeoutMs: 120_000 });
          assert.equal(sign.code, 0, `the sign-in was refused: ${scrub(sign.out.slice(-300))}`);
        } finally {
          await asWalker(host, `sudo sh -c 'shred -u ${file} 2>/dev/null || rm -f ${file}'`, { pty: false }).catch(() => {});
        }
        const fin = await asWalker(host, "sudo vyre call onboard.finish '{}'", { pty: false, timeoutMs: 120_000 });
        assert.equal(fin.code, 0, `onboarding did not finish: ${scrub(fin.out.slice(-300))}`);
        const thread = (fin.out.match(/"thread"\s*:\s*"([^"]+)"/) || [])[1];
        assert.ok(thread, `the assistant made no first thread: ${scrub(fin.out.slice(-300))}`);
        let said = "";
        for (const end = Date.now() + 4 * 60_000; Date.now() < end && !said;) {
          await new Promise(r => setTimeout(r, 8000));
          const got = await asWalker(host, `sudo vyre call threads.get '{"thread":"${thread}"}'`, { pty: false, timeoutMs: 60_000 });
          const m = scrub(got.out).match(/"role"\s*:\s*"assistant"[^}]*?"text"\s*:\s*"((?:[^"\\]|\\.){3,})"/);
          if (m) said = m[1];
        }
        assert.ok(said, "the assistant did not answer in 4 minutes");
        return `the assistant answered (${said.length} characters)`;
      }, { needs: [called] });
    }
    await run.step(R("create a team space on the server (named in the app, signed with the identity)"), async () => {
      const label = `team${person.slice(-6)}`;
      names.push(label); keep();
      team = await mac.createTeamSpace(label);
      assert.match(team.space, /^spc_/);
      const r = await fetch(`${LIVE.names}/v1/ids/resolve?name=${team.label}`);
      assert.equal(r.status, 200, "the directory resolves the space's name");
      return team.name;
    }, { needs: [called] });
    if (expectVersion) {
      const U = (/** @type {string} */ n) => R(`update from Settings: ${n}`);
      const sshVersion = async () => { const v = await asWalker(host, "sudo vyre call system.info '{}' 2>&1", { pty: false }); return (v.out.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || ""; };
      await run.step(U("the notice names the release under test"), async () => {
        if (installedVersion === expectVersion) throw Object.assign(new Error(`the server installed ${expectVersion} already (it was published before this walk began), so there is nothing to update`), { skip: true });
        if (channel) {
          // The person opts in to the beta channel the way the docs say: update.channel in the daemon's config and VYRE_CHANNEL for the root updater, then the server starts again.
          const c = await asWalker(host, `echo VYRE_CHANNEL=${channel} | sudo tee -a /srv/vyre/.env >/dev/null && sudo docker exec -u vyre vyre-vyre-1 node -e 'const fs=require("fs"),p=process.env.HOME+"/.vyre/config.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.update={...(c.update||{}),channel:"${channel}"};fs.writeFileSync(p,JSON.stringify(c))' && sudo docker restart vyre-vyre-1 >/dev/null && echo set`, { pty: false });
          assert.match(c.out, /set/, `could not set the ${channel} channel: ${c.out.slice(-160)}`);
          let back = false;
          for (let i = 0; i < 30 && !back; i++) { await new Promise(r => setTimeout(r, 6000)); try { await mac.reconnect(); await mac.callTool("system.info", {}); back = true; } catch { /* still starting */ } }
          assert.ok(back, "the server did not come back after the channel was set");
        }
        // The box looks at the releases once a day; update.check is the button's "look now". The walk waits for the release to be tagged, published and deployed.
        const end = Date.now() + 90 * 60_000;
        let st = null;
        for (;;) {
          st = await mac.callTool("update.check", {});
          if (st && st.available === expectVersion) break;
          if (Date.now() > end) throw new Error(`the box still offers ${st && st.available} after 90 minutes; it runs ${st && st.current}`);
          await new Promise(r => setTimeout(r, 60_000));
        }
        assert.equal(st.current, installedVersion, "the running version is the one the installer put there");
        assert.equal(st.canApply, true, "the server takes the request from the app");
        return `${st.current} -> ${st.available}`;
      }, { needs: [called] });
      await run.step(U("the app asks for the update (the button's call)"), async () => {
        const r = await mac.callTool("update.apply", {});
        assert.equal(r.requested, true, `the request was not taken: ${JSON.stringify(r).slice(0, 200)}`);
        return "requested";
      }, { needs: [U("the notice names the release under test")] });
      await run.step(U("the server comes back on the new version, and the same app signs in again"), async () => {
        const end = Date.now() + 10 * 60_000;
        let v = "";
        while (Date.now() < end && v !== expectVersion) { await new Promise(r => setTimeout(r, 6000)); v = await sshVersion().catch(() => ""); }
        assert.equal(v, expectVersion, `the box says ${v || "nothing"} ten minutes after the request`);
        // ONE sign-in try with the session the app holds, as on reconnecting (more wrong tries lock the device out).
        await mac.reconnect();
        const st = await mac.callTool("update.status", {});
        assert.equal(st.current, expectVersion);
        assert.equal(st.available, null, "no newer version is offered any more");
        return `${installedVersion} -> ${st.current}`;
      }, { needs: [U("the app asks for the update (the button's call)")] });
      await run.step(U("what the app wrote before is still there"), async () => {
        await mac.callTool("records.me", {});
        const r = await fetch(`${LIVE.names}/v1/ids/resolve?name=${reservation.name}`);
        assert.equal(r.status, 200, "the directory still resolves the name");
        return "records answer, the name resolves";
      }, { needs: [U("the server comes back on the new version, and the same app signs in again")] });
    }

    await run.step(R("a second identity joins the team from its own app"), async () => {
      throw Object.assign(new Error("a release server takes the owner's yes for an invite, and the joiner's yes to join, only from a hardware key (Touch ID, Face ID); this headless app has software keys. Walk the invite and Join by hand with two real apps."), { skip: true });
    }, { needs: [R("create a team space on the server (named in the app, signed with the identity)")] });

    await run.step("server: uninstall (keep nothing)", async () => {
      const r = await asWalker(host, "sudo vyre uninstall --delete-data --yes", { pty: true, timeoutMs: 15 * 60_000 });
      assert.equal(r.code, 0, r.out.slice(-300));
      const still = await ssh(host, "docker ps -q | wc -l");
      assert.match(still.out.trim(), /^0$/, `containers still running: ${still.out.trim()}`);
    }, { needs: [called] });
    mac.close();
    const mac2Needs = ["server: uninstall (keep nothing)"];
    if (expectVersion) {
      // The second install is the install line a new person gets: it must serve the release under test. The release is published before vyre.run is deployed (a person approves that), so wait for it.
      const SERVED = "vyre.run serves the release under test to a new install";
      await run.step(SERVED, async () => {
        const end = Date.now() + 90 * 60_000;
        let v = "";
        for (;;) {
          try { v = (await (await fetch("https://vyre.run/box/VERSION", { headers: { "user-agent": "vyre-live-walk" } })).text()).trim(); } catch { v = ""; }
          if (v === expectVersion) return v;
          if (Date.now() > end) throw new Error(`vyre.run still serves ${v || "nothing"} after 90 minutes`);
          await new Promise(r => setTimeout(r, 60_000));
        }
      }, { needs: ["server: uninstall (keep nothing)"] });
      mac2Needs.push(SERVED);
    }
    // the same person adds the same server again, now without Records: a fresh code, a fresh install line
    const called2 = await server("plain", P, mac2Needs);
    void called2;
  } finally {
    mac.close();
    keep();
    await run.step("cleanup: the server is wiped", async () => { const r = await wipeServer(host); assert.match(r.out, /wiped/, r.out.slice(-200)); });
    const secret = process.env.VYRE_NAMES_ADMIN_SECRET || "";
    if (names.length && secret) await run.step(`cleanup: free ${names.length} throwaway name${names.length === 1 ? "" : "s"} (support admin drop)`, async () => {
      const left = [];
      for (const name of names) {
        const r = await fetch(`${LIVE.names}/v1/names/admin/drop`, { method: "POST", headers: { "content-type": "application/json", "x-vyre-admin": secret }, body: JSON.stringify({ name }) });
        const j = await r.json().catch(() => null);
        if (!(r.status === 200 || (j && j.error && j.error.code === "no_such_name"))) left.push(`${name} (${r.status})`);
      }
      assert.equal(left.length, 0, `not freed: ${left.join(", ")}`);
      return names.join(", ");
    });
    else if (names.length) process.stdout.write(`NOTE  names to free (${names.join(", ")}) are in ${path.join(w.out, "names.json")}; run scripts/proof-live-drop.mjs with VYRE_NAMES_ADMIN_SECRET\n`);
  }
}
