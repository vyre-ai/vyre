// @ts-check
// The world every journey starts in: the repo's own names Worker code and relay (scripts/lib/proof/standins.mjs), one person with an identity and the app's own modules driven headless, and a REAL server
// that person has added and adopted the way the app's Add a server does. Two kinds of server:
//   box     scripts/install-box.sh run from this checkout (signed with a throwaway key), in docker: a real box. Takes the owner's and a joiner's yes only from a hardware key, so it cannot walk invites.
//   daemon  a real vyred (core/daemon start, the code the box runs) in this process with a development sealing process: the one that takes software keys, so invites and Join can be walked.
// Nothing here replaces a Vyre part. The people's clicks are the app modules called directly, as scripts/lib/proof does.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../lib/proof/app.mjs";
import { startStandins } from "../../lib/proof/standins.mjs";
import { startDaemonServer } from "../../lib/proof/server-daemon.mjs";
import { startInstallerServer } from "../../lib/proof/server-installer.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * @param {{ run: ReturnType<typeof import("../../lib/proof/run.mjs").createRun>, out: string, kind: "box" | "daemon", store: "records" | "plain", devBuild?: boolean, person?: string }} o
 */
export async function bringUp(o) {
  const { run } = o;
  const dir = path.join(o.out, `world-${o.kind}`);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const S = (/** @type {string} */ n) => `world (${o.kind}): ${n}`;
  // A box in a container reaches this runner's stand-ins at the address of Docker's bridge (its gateway), unless the runner says otherwise.
  const bridge = () => { try { return String(spawnSync("docker", ["network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"], { encoding: "utf8" }).stdout || "").trim(); } catch { return ""; } };
  const hostIp = process.env.PROOF_HOST_IP || (o.kind === "box" ? bridge() : "");
  const ins = await startStandins({ out: dir, ...(o.kind === "box" ? { host: "0.0.0.0", ...(hostIp ? { publicHost: hostIp } : {}) } : {}) });
  const person = o.person || `journey${Math.random().toString(36).slice(2, 7)}`;
  const mac = createApp({ label: "Journey Mac", dir: path.join(dir, "mac"), directory: ins.names, relay: ins.relay });
  /** @type {any} */ let reservation = null, flow = null, srv = null;
  const first = run.results.length;
  const w = {
    ready: false,
    kind: o.kind, store: o.store, dir, ins, mac, person, S,
    get srv() { return srv; },
    /** A tool call as the person's app, over its paired session. @param {string} tool @param {any} [input] */
    call: (tool, input = {}) => mac.callTool(tool, input),
    /** A tool call as the server's own operator (the terminal on that machine). @param {string} tool @param {any} [input] */
    operator: (tool, input = {}) => srv.operator(tool, input),
    until: mac.until,
    async stop() {
      mac.close();
      if (srv) {
        try { fs.writeFileSync(path.join(dir, "server.log"), (srv.logs || []).join("\n") + "\n"); } catch { /* a courtesy */ }
        await srv.stop().catch(() => {});
      }
      await ins.stop();
    },
  };
  await run.step(S("reserve a name and become yourself in the app"), async () => {
    reservation = await mac.reserve(person);
    const me = await mac.becomeYourself({ name: reservation.name, code: reservation.code });
    assert.ok(me.id && me.recoveryCode, "an identity and a recovery code");
    const r = await fetch(`${ins.names}/v1/ids/resolve?name=${reservation.name}`);
    assert.equal(r.status, 200, "the directory resolves the new name");
    return reservation.name;
  });
  const NAME = S("reserve a name and become yourself in the app");
  await run.step(S("add a server: the app shows the install line"), async () => {
    flow = mac.addServer();
    await flow.begin(o.store);
    assert.ok(flow.state.installLine.includes(`VYRE_CODE=${flow.state.code}`), "the line carries the one-time code");
  }, { needs: [NAME] });
  await run.step(S(`the server installs from that line (${o.kind})`), async () => {
    const a = { dir: path.join(dir, "server"), repo: REPO, code: flow.state.code, relayForServer: ins.relayForServer, relayPort: ins.relayPort, hostIp: ins.hostIp, namesForServer: ins.namesForServer, store: o.store , ...(o.devBuild ? { devBuild: true, ownerId: mac.identity.id } : {}) };
    srv = o.kind === "box" ? await startInstallerServer(a) : await startDaemonServer({ dir: a.dir, code: a.code, relay: a.relayForServer, directory: a.namesForServer, store: o.store, ownerId: mac.identity.id });
    return srv.kind;
  }, { needs: [S("add a server: the app shows the install line")] });
  await run.step(S("the app finds the server and the four words match"), async () => {
    await mac.until(() => flow.state.stage === "found" || flow.state.stage === "stopped", 120_000, "the app to find the server");
    assert.equal(flow.state.stage, "found", flow.state.error && flow.state.error.message);
    assert.equal(flow.state.box.words.join(" "), await srv.words());
  }, { needs: [S(`the server installs from that line (${o.kind})`)] });
  await run.step(S("confirm the words in the app: adopt and pair"), async () => {
    await flow.confirmWords();
    assert.equal(flow.state.stage, "done", flow.state.error && flow.state.error.message);
    assert.ok(mac.pairing && mac.pairing.owner, "the server named this identity its owner");
  }, { needs: [S("the app finds the server and the four words match")] });
  await run.step(S("the app reaches the server and calls a tool"), async () => {
    if (srv.yesFor) mac.setYes(srv.yesFor(mac.identity.id));
    await mac.openSession();
    assert.ok(await mac.callTool("system.info"), "system.info answered");
  }, { needs: [S("confirm the words in the app: adopt and pair")] });
  if (o.store === "records") {
    await run.step(S("the record store answers"), async () => {
      let last = "";
      // A first start with no saved database (stores/twenty/golden, built per Twenty image by the golden refresh) makes Twenty's database and every core type: 165 s to a healthy Twenty and about 260 s more for the types
      // (183 field creates at 0.9 s each) on a quiet 4-core box, so 8 minutes was not enough. 20 minutes, and the last answer is in the failure.
      for (let i = 0; i < 120; i++) { try { await mac.callTool("records.types", {}); return `up after ${i * 10} s`; } catch (e) { last = String(/** @type {Error} */ (e).message); await new Promise(r => setTimeout(r, 10_000)); } }
      throw new Error(`the record store was not up after 20 minutes: ${last}`);
    }, { needs: [S("the app reaches the server and calls a tool")] });
  }
  w.ready = run.results.slice(first).every(r => r.ok === true);
  return w;
}
