// @ts-check
// The sight module against fake computers, hands-desktop, chrome, hands and screen modules in a
// temp home. Nothing here reads a real screen: every screen is a fake that answers fixed text.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { normalize, bareUrl, cleanSummary, offMac, KEEP } from "./index.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";

// Words that must never reach an event or the table. Built here, so a leak names itself.
const SECRET_TEXT = "Dear Northwind Bakery, the quarterly memo";
const FIELD_VALUE = "hunter-two-" + "x".repeat(3);
const SELECTION = "selected words from Harlow Legal";
const QUERY = "session=abc123";

const screenSrc = (answer = "normal") => `
let calls = 0;
export default { async start(ctx) {
  ctx.tool("screen.context", { effect: "read", input: { type: "object", properties: { text: { type: "boolean" }, textMax: { type: "integer" } } },
    run: async (i, meta) => {
      if (meta && meta.peer) throw Object.assign(new Error("stays on this Mac"), { code: "local_only" });
      calls++;
      globalThis.__screenCalls = calls;
      const mode = ${JSON.stringify(answer)};
      if (mode === "blind") return { app: { name: "1Password", bundle: "com.1password", pid: 7 }, window: { title: "Vault" }, blind: "a password manager" };
      const body = { app: { name: "Mail", bundle: "com.apple.mail", pid: 9 }, window: { title: "Inbox", frame: null },
        url: "https://mail.example.com/inbox/42?${QUERY}#frag", secure: mode === "secure", truncated: false, at: 1000,
        focused: mode === "secure" ? { role: "AXSecureTextField", name: "Password" } : { role: "AXTextField", name: "To", value: ${JSON.stringify(FIELD_VALUE)}, selectedText: ${JSON.stringify(SELECTION)} } };
      return i.text === false ? body : { ...body, text: ${JSON.stringify(SECRET_TEXT)} };
    } });
  return {};
} };`;

const computersSrc = `export default { async start(ctx) {
  const view = a => ({ agent: a, state: a === "kit" ? "running" : "frozen", screen: a === "kit" ? 1 : null, thread: null, viewers: 0,
    takeover: a === "kit" ? "glass:laptop" : null, paused: false });
  ctx.tool("computers.list", { effect: "read", run: async () => ({ driver: "fake", screens: 2, computers: [view("juno"), view("kit")] }) });
  ctx.tool("computers.get", { effect: "read", run: async ({ agent }) => view(agent) });
  ctx.tool("computers.watch", { effect: "read", run: async (i, { caller }) => {
    if (!i.surface) throw new Error("surface must name a person's screen");
    return { ticket: "t-" + i.agent, path: "/v1/streams/computers/glass?ticket=t-" + i.agent, width: 1280, height: 800, asked: caller, slow: i.slow === true };
  } });
  return {};
} };`;

const desktopSrc = `export default { async start(ctx) {
  ctx.tool("hands-desktop.tree", { effect: "read", run: async ({ agent, app }) => ({ app: app || "Files", controls: [
    { path: "0/1", role: "push button", name: "Open", enabled: true, frame: { x: 1, y: 2, w: 3, h: 4 } },
    { path: "0/2", role: "text", name: "Search", enabled: true, value: ${JSON.stringify(FIELD_VALUE)}, focused: true, identifier: "q" },
  ] }) });
  return {};
} };`;

const agentsSrc = `export default { async start(ctx) {
  ctx.tool("agents.list", { effect: "read", run: async () => ([{ name: "kit", kind: "worker" }, { name: "vyre", kind: "assistant" }]) });
  return {};
} };`;

const chromeSrc = `export default { async start(ctx) {
  ctx.tool("chrome.snapshot", { effect: "read", run: async ({ agent }) => {
    ctx.events.emit("chrome.acted", { agent, action: "snapshot", ok: true, summary: "2 controls" });
    return { title: "Harlow Legal", url: "https://harlow.example/intake?${QUERY}", controls: [{ role: "textbox", name: "Email", value: ${JSON.stringify(FIELD_VALUE)} }], named: 1, nameless: 0 };
  } });
  return {};
} };`;

/** @typedef {[string, string[], string[], string]} Fake name, tools, emits, source */

/** @param {any} t @param {Fake[]} fakes */
async function world(t, fakes) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, tools, emits, src] of fakes) writeModule(root, name, { roles: ["box", "local"], does: { tools }, watches: { emits } }, src);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "sight");
  await reg.start([...core, ...discover([root], { firstPartyRoots: [root] }) /* the fakes stand in for shipped modules (hands-desktop emits desktop.acted) */], { role: "local" });
  t.after(async () => { await reg.stop?.(); db.close(); delete /** @type {any} */ (globalThis).__screenCalls; });
  const stepped = () => events.since(0).filter(e => e.type === "sight.stepped");
  return { reg, db, events, stepped };
}

/** @type {Record<string, Fake>} */
const FAKES = {
  screen: ["screen", ["screen.context"], [], screenSrc()],
  computers: ["computers", ["computers.list", "computers.get", "computers.watch"], [], computersSrc],
  desktop: ["hands-desktop", ["hands-desktop.tree"], ["desktop.acted"], desktopSrc],
  chrome: ["chrome", ["chrome.snapshot"], ["chrome.acted"], chromeSrc],
  hands: ["hands", [], ["hands.acted"], `export default { async start() { return {}; } };`],
  agents: ["agents", ["agents.list"], [], agentsSrc],
};

const data = r => { assert.ok(!r.error, JSON.stringify(r.error)); return r.data; };

test("bareUrl and cleanSummary: no query or fragment, one short line", () => {
  assert.equal(bareUrl("https://harlow.example/a/b?x=1#y"), "https://harlow.example/a/b");
  assert.equal(bareUrl("not a url?x=1"), "not a url");
  assert.equal(bareUrl(null), null);
  assert.equal(cleanSummary(`open  https://harlow.example/p?${QUERY}#f now`), "open https://harlow.example/p now");
  assert.equal(cleanSummary("a".repeat(400)).length, 200);
  assert.equal(offMac({ caller: "cli" }), false);
  for (const m of [{ caller: "cli", peer: { node: "n" } }, { caller: "tailnet:alex" }, { caller: "tailnet-guest:kit" }, { caller: "device:abcdefghijklmnop" }]) assert.equal(offMac(m), true, JSON.stringify(m));
});

test("normalize: desktop, chrome and hands events become one step shape", () => {
  assert.deepEqual(normalize({ type: "desktop.acted", source: "hands-desktop", at: 5, thread: "th-1", payload: { agent: "kit", action: "press", summary: "Open", ok: true } }),
    { target: "agent:kit", agent: "kit", thread: "th-1", call: null, action: "press", summary: "Open", ok: true, why: null, app: null, at: 5 });
  assert.deepEqual(normalize({ type: "chrome.acted", source: "chrome", at: 6, thread: null, payload: { agent: "juno", action: "open", ok: false, why: `blocked https://x.example/?${QUERY}`, summary: `https://x.example/a?${QUERY}`, call: "call-9" } }),
    { target: "agent:juno", agent: "juno", thread: null, call: "call-9", action: "open", summary: "https://x.example/a", ok: false, why: "blocked https://x.example/", app: "Chrome", at: 6 });
  assert.deepEqual(normalize({ type: "hands.acted", source: "hands", at: 7, payload: { app: "Mail", kind: "press", selector: { role: "AXButton", name: "Send to Harlow Legal", identifier: "send" }, acted: true, verified: true, scope: { thread: "th-2", call: "c-2" } } }),
    { target: "mac", agent: null, thread: "th-2", call: "c-2", action: "press", summary: "press AXButton", ok: true, why: null, app: "Mail", at: 7 });
  assert.equal(normalize({ type: "hands.acted", source: "hands", at: 8, payload: { app: "Mail", kind: "set", selector: {}, acted: true, verified: false } })?.why, "done, but its effect was not seen");
  assert.equal(normalize({ type: "chrome.acted", source: "chrome", at: 1, payload: { agent: "kit", action: "snapshot", ok: true } }), null, "a read is not a step");
  assert.equal(normalize({ type: "desktop.acted", source: "someone-else", at: 1, payload: { agent: "kit", action: "press", ok: true } }), null, "only the acting module's own event counts");
  assert.equal(normalize({ type: "desktop.acted", source: "hands-desktop", at: 1, payload: { agent: "Not An Agent", action: "press", ok: true } }), null);
});

test("sight: acted events become stored steps and sight.stepped, and sight.steps filters them newest first", async t => {
  const { reg, events, stepped } = await world(t, [FAKES.desktop, FAKES.chrome, FAKES.hands]);
  events.emit("hands-desktop", "desktop.acted", { agent: "kit", action: "press", summary: "Open", ok: true }, { thread: "th-1" });
  events.emit("chrome", "chrome.acted", { agent: "juno", action: "click", ok: false, why: "nothing matches", summary: "Submit" });
  events.emit("hands", "hands.acted", { app: "Notes", kind: "focus", selector: { role: "AXTextArea", name: "Northwind Bakery order" }, acted: true, verified: true });
  const evs = stepped();
  assert.equal(evs.length, 3);
  assert.deepEqual(evs[0].payload, { target: "agent:kit", agent: "kit", thread: "th-1", action: "press", summary: "Open", ok: true, at: evs[0].payload.at });
  assert.equal(evs[0].thread, "th-1", "the thread rides on the event's scope too");
  assert.deepEqual(evs[1].payload, { target: "agent:juno", agent: "juno", action: "click", summary: "Submit", ok: false, why: "nothing matches", app: "Chrome", at: evs[1].payload.at });
  assert.equal(evs[2].payload.summary, "focus AXTextArea");
  assert.ok(!JSON.stringify(evs).includes("Northwind"), "a Mac selector's name never reaches the event");

  const all = data(await reg.call("sight.steps", {}, "cli")).steps;
  assert.deepEqual(all.map(s => s.target), ["mac", "agent:juno", "agent:kit"]);
  assert.deepEqual(data(await reg.call("sight.steps", { target: "agent:kit" }, "deck")).steps.map(s => s.summary), ["Open"]);
  assert.deepEqual(data(await reg.call("sight.steps", { thread: "th-1" }, "capsule")).steps.map(s => s.target), ["agent:kit"]);
  assert.equal(data(await reg.call("sight.steps", { limit: 1 }, "local")).steps.length, 1);
  assert.equal((await reg.call("sight.steps", { target: "phone" }, "cli")).error?.code, "bad_input");

  // Over the tailnet the Mac's steps are left out, and asking for them by name is refused.
  assert.deepEqual(data(await reg.call("sight.steps", {}, "tailnet:alex")).steps.map(s => s.target), ["agent:juno", "agent:kit"]);
  assert.equal((await reg.call("sight.steps", { target: "mac" }, "tailnet:alex")).error?.code, "local_only");
  assert.equal((await reg.call("sight.steps", {}, "mcp")).error?.code, "denied", "no agent reads another's steps through sight");
});

test("sight: steps keep only the newest 500", async t => {
  const { reg, db, events } = await world(t, [FAKES.desktop]);
  for (let i = 0; i < KEEP + 25; i++) events.emit("hands-desktop", "desktop.acted", { agent: "kit", action: "press", summary: `step ${i}`, ok: true });
  assert.equal(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM sight_steps").get()).n, KEEP);
  const steps = data(await reg.call("sight.steps", { limit: KEEP }, "cli")).steps;
  assert.equal(steps.length, KEEP);
  assert.equal(steps[0].summary, `step ${KEEP + 24}`);
  assert.equal(steps.at(-1).summary, "step 25");
});

test("sight: steps survive a restart, so a reopened view shows history", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "sight");
  const boot = async () => { const events = new Events(db); const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} }); await reg.start(core, { role: "local" }); return { reg, events }; };
  const first = await boot();
  first.events.emit("hands-desktop", "desktop.acted", { agent: "kit", action: "press", summary: "Open", ok: true });
  await first.reg.stop?.();
  const second = await boot();
  t.after(async () => { await second.reg.stop?.(); });
  assert.deepEqual(data(await second.reg.call("sight.steps", {}, "cli")).steps.map(s => s.summary), ["Open"]);
});

test("sight.targets: the Mac when screen runs, one row per computer, and nothing when neither runs", async t => {
  const empty = await world(t, []);
  assert.deepEqual(data(await empty.reg.call("sight.targets", {}, "cli")), { targets: [] });

  const { reg } = await world(t, [FAKES.screen, FAKES.computers]);
  const { targets } = data(await reg.call("sight.targets", {}, "capsule"));
  assert.deepEqual(targets, [
    { target: "mac", kind: "mac", label: "This Mac", live: true },
    { target: "agent:juno", kind: "agent", label: "juno", live: false },
    { target: "agent:kit", kind: "agent", label: "kit", live: true, holder: "glass:laptop" },
  ]);
  assert.equal(/** @type {any} */ (globalThis).__screenCalls, undefined, "listing never woke the screen helper");
  assert.deepEqual(data(await reg.call("sight.targets", {}, "tailnet:alex")).targets.map(x => x.target), ["agent:juno", "agent:kit"], "the Mac is not offered over the tailnet");
});

test("sight.now for the Mac: app, window and bare URL; text only when asked; never over the tailnet", async t => {
  const { reg, events, stepped, db } = await world(t, [FAKES.screen, FAKES.hands]);
  events.emit("hands", "hands.acted", { app: "Mail", kind: "set", selector: { role: "AXTextField", name: SELECTION, identifier: FIELD_VALUE }, acted: true, verified: true, value: FIELD_VALUE });
  const now = data(await reg.call("sight.now", { target: "mac" }, "cli"));
  assert.equal(now.target, "mac");
  assert.equal(now.kind, "mac");
  assert.equal(now.app, "Mail");
  assert.equal(now.window, "Inbox");
  assert.equal(now.url, "https://mail.example.com/inbox/42");
  assert.equal(now.step.summary, "set AXTextField");
  assert.equal(now.text, undefined);
  assert.equal(now.focused, undefined);

  const withText = data(await reg.call("sight.now", { target: "mac", parts: ["text"] }, "capsule"));
  assert.equal(withText.text, SECRET_TEXT);
  assert.equal(withText.focused.value, FIELD_VALUE, "the person who asked sees it");
  assert.ok(!withText.url.includes(QUERY));

  for (const [caller, meta] of [["cli", { peer: { node: "juno", user: "alex" } }], ["tailnet:alex", {}], ["device:abcdefghijklmnop", {}]]) {
    const r = await reg.call("sight.now", { target: "mac", parts: ["text"] }, caller, meta);
    assert.equal(r.error?.code, "local_only", `${caller} ${JSON.stringify(r)}`);
  }

  // Nothing the screen said, and nothing from the selector but its role, went into an event or a row.
  const stored = JSON.stringify(db.prepare("SELECT * FROM sight_steps").all()) + JSON.stringify(stepped());
  for (const no of [SECRET_TEXT, FIELD_VALUE, SELECTION, QUERY, "Inbox"]) assert.ok(!stored.includes(no), no);
});

test("sight.now for the Mac: a secure field and a blind place stay that way", async t => {
  const secure = await world(t, [["screen", ["screen.context"], [], screenSrc("secure")]]);
  const s = data(await secure.reg.call("sight.now", { target: "mac", parts: ["text"] }, "cli"));
  assert.equal(s.secure, true);
  assert.ok(!("value" in s.focused) && !("selectedText" in s.focused));

  const blind = await world(t, [["screen", ["screen.context"], [], screenSrc("blind")]]);
  const b = data(await blind.reg.call("sight.now", { target: "mac", parts: ["text", "controls"] }, "cli"));
  assert.deepEqual({ ...b, at: 0 }, { target: "mac", kind: "mac", step: null, app: "1Password", window: "Vault", url: null, blind: "a password manager", at: 0 });
  assert.ok(blind.stepped().length === 0);
});

test("sight.now for an agent: its computer and last step, controls without values, from chrome or the desktop", async t => {
  const { reg, events, stepped } = await world(t, [FAKES.computers, FAKES.desktop, FAKES.chrome]);
  events.emit("hands-desktop", "desktop.acted", { agent: "kit", action: "press", summary: "Open", ok: true }, { thread: "th-1" });
  const plain = data(await reg.call("sight.now", { target: "agent:kit" }, "deck"));
  assert.deepEqual({ ...plain, at: 0 }, { target: "agent:kit", kind: "agent", agent: "kit", app: null, window: null, url: null,
    step: { target: "agent:kit", agent: "kit", thread: "th-1", action: "press", summary: "Open", ok: true, at: plain.step.at }, holder: "glass:laptop", at: 0 });

  const desk = data(await reg.call("sight.now", { target: "agent:kit", parts: ["controls"] }, "cli"));
  assert.equal(desk.app, "Files");
  assert.deepEqual(desk.controls, [
    { path: "0/1", role: "push button", name: "Open", enabled: true, frame: { x: 1, y: 2, w: 3, h: 4 } },
    { path: "0/2", role: "text", name: "Search", enabled: true, focused: true },
  ]);

  events.emit("chrome", "chrome.acted", { agent: "juno", action: "click", ok: true, summary: "Continue" });
  const web = data(await reg.call("sight.now", { target: "agent:juno", parts: ["controls"] }, "cli"));
  assert.equal(web.app, "Chrome");
  assert.equal(web.window, "Harlow Legal");
  assert.equal(web.url, "https://harlow.example/intake");
  assert.deepEqual(web.controls, [{ role: "textbox", name: "Email", enabled: true }]);
  assert.equal(web.holder, null);
  assert.ok(!JSON.stringify([desk, web]).includes(FIELD_VALUE));
  assert.equal(stepped().filter(e => e.payload.action === "snapshot").length, 0, "sight's own look at the page is not the agent's step");

  assert.equal((await reg.call("sight.now", { target: "agent:Bad Name" }, "cli")).error?.code, "bad_input");
  assert.equal((await reg.call("sight.now", { target: "agent:kit" }, "mcp")).error?.code, "denied");
});

test("sight.now and sight.watch degrade when no computers, hands or screen module runs", async t => {
  const { reg } = await world(t, []);
  const a = data(await reg.call("sight.now", { target: "agent:kit", parts: ["controls"] }, "cli"));
  assert.deepEqual({ ...a, at: 0 }, { target: "agent:kit", kind: "agent", agent: "kit", app: null, window: null, url: null, step: null, holder: null, at: 0, controls: null });
  const m = data(await reg.call("sight.now", { target: "mac", parts: ["text"] }, "cli"));
  assert.deepEqual({ ...m, at: 0 }, { target: "mac", kind: "mac", step: null, app: null, window: null, url: null, at: 0 });
  assert.deepEqual(data(await reg.call("sight.watch", { target: "agent:kit", surface: "glass:laptop" }, "cli")), { target: "agent:kit", ticket: null, why: "this machine runs no agent computers" });
});

test("sight.watch: an agent's ticket from computers.watch; the Mac answers local_only", async t => {
  const { reg } = await world(t, [FAKES.computers]);
  const w = data(await reg.call("sight.watch", { target: "agent:kit", surface: "glass:laptop", slow: true }, "deck"));
  assert.deepEqual(w, { target: "agent:kit", ticket: "t-kit", path: "/v1/streams/computers/glass?ticket=t-kit", width: 1280, height: 800, asked: "module:sight", slow: true });
  assert.equal((await reg.call("sight.watch", { target: "agent:kit" }, "cli")).error?.message.includes("surface"), true, "computers' own refusal comes through");
  assert.equal((await reg.call("sight.watch", { target: "mac" }, "cli")).error?.code, "local_only");
  assert.equal((await reg.call("sight.watch", { target: "agent:kit", surface: "glass:laptop" }, "mcp")).error?.code, "denied");
});

test("sight.watch refuses an ordinary agent's real caller even once a module has relabeled it", async t => {
  // computers.watch's own ownSurface floor only ever sees "module:sight" once sight has forwarded
  // the call (core/modules/index.js's call wrapper); this is sight checking meta.caller itself,
  // before that relabeling happens, so an agent proxied behind any caller kind sight.watch is open
  // to (here "module", which "module:agent:kit" carries) still cannot claim a person's screen.
  const { reg } = await world(t, [FAKES.computers, FAKES.agents]);
  const r = await reg.call("sight.watch", { target: "agent:kit", surface: "glass:laptop" }, "module:agent:kit");
  assert.equal(r.error?.code, "denied");
  assert.match(r.error?.message, /"kit" is an agent|not available to mcp callers/);
  // The assistant is exempt, same as computers' own floor: it is how the user reaches this tool.
  const ok = data(await reg.call("sight.watch", { target: "agent:kit", surface: "glass:laptop" }, "module:agent:vyre"));
  assert.equal(ok.ticket, "t-kit");
});

test("agentCaller: the real caller behind a claim, exempting the assistant and non-claims", async () => {
  const { agentCaller } = await import("./index.js");
  const fakeCtx = { call: async () => ({ data: [{ name: "kit", kind: "worker" }, { name: "vyre", kind: "assistant" }] }) };
  assert.equal(await agentCaller(fakeCtx, { caller: "mcp:agent:kit" }), "kit");
  assert.equal(await agentCaller(fakeCtx, { caller: "harness:agent:kit" }), "kit");
  assert.equal(await agentCaller(fakeCtx, { caller: "mcp:agent:vyre" }), null, "the assistant is exempt");
  assert.equal(await agentCaller(fakeCtx, { caller: "cli" }), null, "not a claim at all");
  assert.equal(await agentCaller(fakeCtx, {}), null);
  const failing = { call: async () => ({ error: { code: "no_such_tool", message: "no agents module" } }) };
  assert.equal(await agentCaller(failing, { caller: "mcp:agent:kit" }), "kit", "cannot check: fail closed");
});

test("sight.frame: one small JPEG of an agent's screen with its last step; never the Mac", async t => {
  const shotSrc = `export default { async start(ctx) {
    ctx.tool("hands-desktop.screenshot", { effect: "read", run: async i => ({ image: Buffer.from(JSON.stringify(i)).toString("base64"), mime: i.format === "jpeg" ? "image/jpeg" : "image/png" }) });
    return {};
  } };`;
  const { reg, events } = await world(t, [["hands-desktop", ["hands-desktop.screenshot"], ["desktop.acted"], shotSrc], FAKES.agents]);
  events.emit("hands-desktop", "desktop.acted", { agent: "kit", action: "press", summary: "Open", ok: true });
  const f = data(await reg.call("sight.frame", { target: "agent:kit", maxWidth: 320 }, "deck"));
  assert.equal(f.mime, "image/jpeg");
  assert.deepEqual(JSON.parse(Buffer.from(f.image, "base64").toString()), { agent: "kit", format: "jpeg", maxWidth: 320 }, "asks hands-desktop for a scaled JPEG");
  assert.equal(f.step.summary, "Open");
  assert.equal(data(await reg.call("sight.frame", { target: "agent:kit" }, "deck")).maxWidth, 480, "480 wide by default");
  assert.equal((await reg.call("sight.frame", { target: "mac" }, "deck")).error?.code, "local_only");
  assert.equal((await reg.call("sight.frame", { target: "agent:kit" }, "mcp")).error?.code, "denied");
  const none = await world(t, []);
  assert.equal(data(await none.reg.call("sight.frame", { target: "agent:kit" }, "cli")).image, null);
});

test("sight.frame refuses a surface-prefixed agent claim, not only \"mcp:agent:\"", async t => {
  // hands-desktop.screenshot's own resolveAgent restricts only "mcp:agent:<name>" (its own
  // docstring); a caller shaped "cli:agent:kit" falls through to its trusted-caller branch there
  // and could name any agent's computer. sight.frame's own agentCaller check must catch this
  // shape itself, the same as sight.watch, since it is what stands between such a caller and a
  // proxied "module:sight" forward.
  const shotSrc = `export default { async start(ctx) {
    ctx.tool("hands-desktop.screenshot", { effect: "read", run: async i => ({ image: Buffer.from("x").toString("base64"), mime: "image/jpeg" }) });
    return {};
  } };`;
  const { reg } = await world(t, [["hands-desktop", ["hands-desktop.screenshot"], ["desktop.acted"], shotSrc], FAKES.agents]);
  const r = await reg.call("sight.frame", { target: "agent:kit" }, "cli:agent:kit");
  assert.equal(r.error?.code, "denied");
  assert.match(r.error?.message, /"kit" is an agent|not available to mcp callers/);
  // The assistant still reaches it under the same shape.
  const ok = data(await reg.call("sight.frame", { target: "agent:kit" }, "cli:agent:vyre"));
  assert.equal(ok.mime, "image/jpeg");
});
