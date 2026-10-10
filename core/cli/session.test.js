// @ts-check
// The limited `vyre` of a session sandbox (core/cli/session.js), over a fake socket: three verbs, the session's own identity, a held send said plainly, the person's own tools refused before they leave.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { run, inSession } from "./session.js";

const TOOLS = [
  { name: "comms.send", description: "Send an email or a text as the person; it is held for their approval.", input: { type: "object", properties: { to: { type: "string", description: "who gets it" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] } },
  { name: "memory.ask", description: "Ask the memory a question in plain words.", input: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
  { name: "vault.reveal", description: "Show a secret to a person.", input: { type: "object", properties: { name: { type: "string" } } } },
  { name: "harness.check", description: "internal", input: { type: "object" } },
];
/** @param {Record<string, any>} [over] */
function rig(over = {}) {
  const seen = /** @type {any[]} */ ([]), outs = /** @type {string[]} */ ([]), errs = /** @type {string[]} */ ([]);
  const request = async (/** @type {string} */ method, /** @type {string} */ path, /** @type {any} */ body, /** @type {any} */ opts) => {
    seen.push({ method, path, body, opts });
    if (method === "GET" && path === "/v1/tools") return { data: TOOLS };
    if (over.call) return over.call(path, body);
    return { data: { ok: true } };
  };
  const env = { VYRE_SOCKET: "/run/vyre-threads/x.sock", ...(over.env || {}) };
  return { seen, outs, errs, go: (/** @type {string[]} */ argv) => run(argv, { env, request: /** @type {any} */ (request), out: s => outs.push(s), err: s => errs.push(s) }) };
}

test("tools find: the send tool is found for words about sending, with a ready call", async () => {
  const r = rig();
  assert.equal(await r.go(["tools", "find", "send an email to Dana"]), 0);
  assert.match(r.outs.join("\n"), /comms\.send/);
  assert.match(r.outs.join("\n"), /vyre call comms\.send '/);
  assert.equal(r.seen[0].opts.caller, "mcp", "the session's own label; the socket binds the rest");
});

test("tools describe: what the tool does and the input it needs; an unknown or person-only tool is not offered", async () => {
  const r = rig();
  assert.equal(await r.go(["tools", "describe", "comms.send"]), 0);
  assert.match(r.outs.join("\n"), /to \(required\): string - who gets it/);
  assert.equal(await r.go(["tools", "describe", "vault.reveal"]), 1, "the person's own tool is not in the catalogue");
  assert.equal(await r.go(["tools", "describe", "nope.thing"]), 1);
});

test("call: runs through the session's route; a held send says nothing was sent; the answer is the tool's data", async () => {
  const r = rig({ call: (/** @type {string} */ path) => (path.endsWith("comms.send") ? { data: { held: "gate_7", message: "Held at the Gate until the user approves it in Vyre." } } : { data: { answer: "ten" } }) });
  assert.equal(await r.go(["call", "comms.send", '{"to":"a@b.c","body":"hi"}']), 0);
  assert.match(r.outs.at(-1) || "", /Held at the Gate.*gate_7.*nothing has been sent/);
  assert.equal(r.seen.at(-1).method, "POST"); assert.equal(r.seen.at(-1).path, "/v1/tools/comms.send");
  assert.deepEqual(r.seen.at(-1).body, { to: "a@b.c", body: "hi" });
  assert.equal(await r.go(["call", "memory.ask", '{"question":"how many?"}']), 0);
  assert.match(r.outs.at(-1) || "", /ten/);
});

test("call: a person's own tool never leaves the shell; a refusal from vyred comes back as code and words; bad input is said", async () => {
  const r = rig({ call: () => ({ error: { code: "denied", message: "comms.send is not available to this session" } }) });
  const before = r.seen.length;
  assert.equal(await r.go(["call", "vault.reveal", '{"name":"x"}']), 1);
  assert.equal(await r.go(["call", "presence.person.start", "{}"]), 1);
  assert.equal(r.seen.length, before, "refused before the socket was touched");
  assert.equal(await r.go(["call", "comms.send", '{"to":"a"}']), 1);
  assert.match(r.errs.at(-1) || "", /^denied: comms\.send is not available/);
  assert.equal(await r.go(["call", "comms.send", "not json"]), 2);
  assert.equal(await r.go(["call", "comms.send", "[1]"]), 2);
  assert.equal(await r.go(["call", "comms.send", "x".repeat(70_000)]), 2);
});

test("only the three verbs exist: anything else is a usage line, and with no session socket nothing is reached", async () => {
  const r = rig();
  for (const argv of [[], ["login"], ["vault", "list"], ["tools"], ["tools", "list"], ["tools", "find"], ["call"], ["call", "Bad Name"], ["call", "a.b", "{}", "extra"], ["mcp"]]) assert.equal(await r.go(argv), 2, argv.join(" "));
  assert.deepEqual(r.seen, [], "no usage line touched the socket");
  const none = rig({ env: { VYRE_SOCKET: "" } });
  assert.equal(await none.go(["tools", "find", "x"]), 1);
  assert.match(none.errs.join(""), /not a Vyre session/);
});

test("an agent's thread calls under its agent label; an agent that is not the assistant is not offered the tools that drive other sessions", async () => {
  const r = rig({ env: { VYRE_AGENT: "kit", VYRE_AGENT_KIND: "agent" } });
  assert.equal(await r.go(["tools", "find", "ask a question"]), 0);
  assert.equal(r.seen[0].opts.caller, "mcp:agent:kit");
});

test("session mode refuses the CLI's own local and human commands before anything runs, and points at tools find", async () => {
  const r = rig();
  for (const argv of [["update"], ["up"], ["down"], ["setup"], ["uninstall"], ["vault", "get", "x"], ["grants", "list"], ["keys"], ["config", "set", "a", "b"], ["box", "status"], ["doctor"], ["--tty", "call", "x.y"]]) {
    assert.equal(await r.go(argv), 2, argv.join(" "));
    assert.match(r.errs.at(-1) || "", /not available inside a session.*vyre tools find/, argv.join(" "));
  }
  assert.equal(r.seen.length, 0, "no socket call was made for any of them");
  assert.equal(await r.go(["help"]), 0);
  assert.match(r.outs.at(-1) || "", /vyre tools find/);
});

test("session mode is on exactly when the session's socket and thread are both set", () => {
  assert.equal(inSession({ VYRE_SOCKET: "/s", VYRE_THREAD: "t" }), true);
  assert.equal(inSession({ VYRE_SOCKET: "/s" }), false, "a Capsule or a daemon child has a socket but no thread");
  assert.equal(inSession({}), false);
});
