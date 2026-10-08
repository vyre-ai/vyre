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

export const LIVE = Object.freeze({ names: "https://names.vyre.run", relay: "wss://relay.vyre.run" });
const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

/**
 * Run a command on the server over ssh. With `pty` it gets a terminal like a person's, and answers yes to the installer's [y/N] questions the way the person would.
 * @param {string} host @param {string} cmd @param {{ pty?: boolean, timeoutMs?: number, log?: (s: string) => void, input?: string, user?: string }} [o]
 * @returns {Promise<{ code: number, out: string }>}
 */
export function ssh(host, cmd, o = {}) {
  return new Promise(resolve => {
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", ...(o.user ? ["-l", o.user] : []), o.pty ? "-tt" : "-T", host, cmd];
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", asked = 0;
    const onData = (/** @type {Buffer} */ d) => {
      const s = String(d); out += s; if (o.log) o.log(s);
      if (o.pty && /\[y\/N\]\s*$/.test(strip(out.slice(-200)))) { asked++; child.stdin.write("y\n"); out += `\n[the walk answered y (${asked})]\n`; }
    };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    if (o.input !== undefined) { child.stdin.write(o.input); if (!o.pty) child.stdin.end(); } else if (!o.pty) child.stdin.end();
    const timer = setTimeout(() => { out += "\n[the walk gave up waiting]\n"; child.kill("SIGTERM"); }, o.timeoutMs ?? 30 * 60_000);
    child.on("close", code => { clearTimeout(timer); resolve({ code: code ?? 1, out: strip(out) }); });
  });
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
  await asWalker(host, "command -v vyre >/dev/null 2>&1 && vyre uninstall --delete-data --yes || true", { pty: true, timeoutMs: 10 * 60_000 });
  return ssh(host, "command -v docker >/dev/null 2>&1 && (docker ps -aq | xargs -r docker rm -f; docker system prune -af --volumes) >/dev/null 2>&1; rm -rf /srv/vyre /home/walker/.vyre /usr/local/bin/vyre; echo wiped", { timeoutMs: 15 * 60_000 });
}

/**
 * Install from the line the app showed, on the server, and read what the person reads: the four words on its terminal.
 * @param {string} host @param {string} line @param {string} out
 */
export async function installFromLine(host, line, out) {
  fs.mkdirSync(out, { recursive: true });
  // The installer asks for Docker itself on a fresh server ([y/N]); the walk answers y the way a person would.
  const r = await asWalker(host, line, { pty: true, timeoutMs: 40 * 60_000 });
  fs.writeFileSync(path.join(out, `install-${Date.now()}.log`), r.out.replace(/VYRE_CODE=\S+/g, "VYRE_CODE=<hidden>"));
  const m = r.out.match(/Your four words:\s*([a-z]+(?: [a-z]+){3})/);
  return { code: r.code, words: m ? m[1] : "", tail: r.out.split("\n").filter(Boolean).slice(-6).join(" | ").slice(0, 500) };
}

/**
 * @param {{ run: ReturnType<typeof import("./run.mjs").createRun>, host: string, out: string }} w
 */
export async function walkLive(w) {
  const { run, host } = w;
  const dir = path.join(w.out, "live");
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  /** @type {string[]} */ const names = [];
  const keep = () => fs.writeFileSync(path.join(w.out, "names.json"), JSON.stringify(names));
  const person = `walk${Math.random().toString(36).slice(2, 8)}`;
  const mac = createApp({ label: "Proof Mac", dir: path.join(dir, "mac"), directory: LIVE.names, relay: LIVE.relay });
  /** @type {any} */ let reservation = null, team = null;
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
    await run.step(S("the server installs from that line (the published release)"), async () => {
      installed = await installFromLine(host, flow.state.installLine, dir);
      assert.equal(installed.code, 0, `the installer exited ${installed.code}: ${installed.tail}`);
      const v = await asWalker(host, "vyre --version 2>&1 || vyre version 2>&1");
      const ver = (v.out.match(/\b\d+\.\d+\.\d+\S*/) || [""])[0];
      assert.ok(!ver || /^0\.2\.12/.test(ver), `the server runs ${ver}, not the published 0.2.12`);
      return `installed${ver ? ` ${ver}` : ""}`;
    }, { needs: [S("add a server: the app shows the install line")] });
    await run.step(S("the app finds the server"), async () => {
      await mac.until(() => flow.state.stage === "found" || flow.state.stage === "stopped", 120_000, "the app to find the server");
      assert.equal(flow.state.stage, "found", flow.state.error && flow.state.error.message);
      return `${flow.state.box.name || "server"}`;
    }, { needs: [S("the server installs from that line (the published release)")] });
    await run.step(S("the four words in the app are the ones the server shows"), async () => {
      assert.ok(installed.words, "the installer printed no four words");
      assert.equal(flow.state.box.words.join(" "), installed.words);
      return installed.words;
    }, { needs: [S("the app finds the server")] });
    await run.step(S("confirm the words in the app: adopt and pair"), async () => {
      await flow.confirmWords();
      assert.equal(flow.state.stage, "done", flow.state.error && flow.state.error.message);
      assert.ok(mac.pairing && mac.pairing.owner, "the server named this identity its owner");
    }, { needs: [S("the four words in the app are the ones the server shows")] });
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
    await run.step(R("create a team space on the server (named in the app, signed with the identity)"), async () => {
      const label = `team${person.slice(-6)}`;
      names.push(label); keep();
      team = await mac.createTeamSpace(label);
      assert.match(team.space, /^spc_/);
      const r = await fetch(`${LIVE.names}/v1/ids/resolve?name=${team.label}`);
      assert.equal(r.status, 200, "the directory resolves the space's name");
      return team.name;
    }, { needs: [called] });
    await run.step(R("a second identity joins the team from its own app"), async () => {
      throw Object.assign(new Error("a release server takes the owner's yes for an invite, and the joiner's yes to join, only from a hardware key (Touch ID, Face ID); this headless app has software keys. Walk the invite and Join by hand with two real apps."), { skip: true });
    }, { needs: [R("create a team space on the server (named in the app, signed with the identity)")] });

    await run.step("server: uninstall (keep nothing)", async () => {
      const r = await asWalker(host, "vyre uninstall --delete-data --yes", { pty: true, timeoutMs: 15 * 60_000 });
      assert.equal(r.code, 0, r.out.slice(-300));
      const still = await ssh(host, "docker ps -q | wc -l");
      assert.match(still.out.trim(), /^0$/, `containers still running: ${still.out.trim()}`);
    }, { needs: [called] });
    mac.close();
    const mac2Needs = ["server: uninstall (keep nothing)"];
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
