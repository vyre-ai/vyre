// What the Switchboard hands the sandbox as a session's sign-in: the credential PICKED for the thread (an agent's vault item, a member's own account) wins over the machine's own sign-in answered
// by the daemon's credentials port, and a person's own account run never gets the machine's login file. The Switchboard's own sandboxFor, with a recording sandbox in place of bubblewrap.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Switchboard } from "./index.js";

const calls = /** @type {any[]} */ ([]);
const sandbox = {
  planHome: (/** @type {any} */ o) => { calls.push(o); return { argv: [], env: o.env, secret: o.secret, cleanup() {} }; },
  selfTest: async () => ({ ok: true, failures: [] }),
  launch: () => ({ pid: 1 }),
};
const probes = { personSocket: "/h/.vyre/vyred.sock", otherSocket: "/run/o.sock", daemonPorts: [7300], keyFile: "/h/.vyre/keys/core.key" };
const MACHINE = "machine-owner-token-xxxxxxxxxxxx", PICKED = "picked-for-the-thread-yyyyyyyyyyyy";

/** @param {any} over @param {any} o */
async function start(over, o) {
  const sb = Object.create(Switchboard.prototype);
  Object.assign(sb, {
    deps: { sandbox: { sandbox, platform: "darwin", home: "/h", probes, temp: "/tmp/x", credentials: async () => MACHINE, ...over } },
    socks: new Map([["t1", { path: "/run/t1.sock" }]]), confinedBy: new Map(), releases: new Map(), bin: "/usr/local/bin/claude",
    sessionTemp: () => "/tmp/x/t1", emit() {}, firstOnMachine: () => false,
  });
  calls.length = 0;
  const spawn = await sb.sandboxFor("t1", { cwd: "/h/work", provider: "claude" }, { provider: "claude", ...o });
  spawn("/usr/local/bin/claude", ["-p"], {}, "/h/work");
  return calls.at(-1);
}

test("a thread's picked credential is the one handed to the session, not the machine's own", async () => {
  const picked = await start({}, { env: { CLAUDE_CODE_OAUTH_TOKEN: PICKED } });
  assert.equal(picked.secret && picked.secret.value, PICKED, "the picked one goes on the pipe");
  const none = await start({}, { env: {} });
  assert.equal(none.secret && none.secret.value, MACHINE, "with none picked the machine's own answers, as before");
});

test("a person's own account run never gets the machine's login file; the owner's run does", async () => {
  const mine = await start({}, { env: {}, accountRun: { uid: 40001 } });
  assert.equal(mine.noLoginCopy, true);
  const owner = await start({}, { env: {} });
  assert.equal(owner.noLoginCopy, undefined);
});

test("an agent in a project: its own agent folder is the one read-only folder the sandbox gets; anything else is ignored", async () => {
  const mine = await start({}, { env: {}, read_only: ["/h/Vyre/agents/agt_01a1-b2"] });
  assert.ok(mine.readOnly.includes("/h/Vyre/agents/agt_01a1-b2"), "its own folder is read-only visible");
  assert.equal(mine.readOnly.filter(/** @param {string} x */ x => x.includes("/agents/")).length, 1, "and it is the only agent folder");
  for (const bad of [["/h/Vyre/agents/agt_1/../../etc"], ["/etc"], ["/h/Vyre/agents/other"], ["a/relative"], ["/h/Vyre/agents/agt_1", "/h/Vyre/agents/agt_2"], ["/h/work"], []]) {
    const c = await start({}, { env: {}, read_only: bad });
    assert.ok(!(c.readOnly || []).some(/** @param {string} x */ x => x.includes("/agents/") || x === "/etc" || x === "/h/work" || x.startsWith("a/")), `ignored: ${JSON.stringify(bad)}`);
  }
});

test("read_only on a launch is honoured only from the agents module", async () => {
  const { trustedLaunch } = await import("./asker-account.js");
  const input = { agent: "x", read_only: ["/h/Vyre/agents/agt_1"], for_person: "per_a" };
  assert.deepEqual(trustedLaunch(input, { firstParty: true, caller: "module:agents" }).read_only, ["/h/Vyre/agents/agt_1"]);
  assert.equal(trustedLaunch(input, { firstParty: true, caller: "module:team" }).read_only, undefined);
  assert.equal(trustedLaunch(input, { caller: "cli" }).read_only, undefined);
  assert.equal(trustedLaunch(input, { firstParty: true, caller: "module:team" }).for_person, "per_a", "for_person still rides from any first-party module");
});
