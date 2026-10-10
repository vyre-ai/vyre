import "../scripts/mac-test-guard.mjs";
// One yes: every outward tool says so in its module.json (`outward: true`, or a Gate kind word). The outward moment reads that flag and nothing else,
// so a tool that leaves Vyre without it would go out with no yes. This scans every module.json: a tool whose name carries an outward verb must be marked,
// or sit in NOT_OUTWARD below with the reason it stays inside your own spaces and devices. Unclear means outward (DESIGN-one-yes.md).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERBS = /(^|[.-])(send|post|pay|publish|reply|forward|share|invite|transfer|merge|push|upload|submit|call|checkout|tweet|email|notify|broadcast|book|charge|dispatch|deliver|announce|invoice|refund|bill|deploy)([.-]|$)/;

/** Tools whose name matches a verb but that stay inside your own spaces and devices (or do not act). One line each. */
const NOT_OUTWARD = {
  "appmods.publish.install": "runs the owner's own built image as a site's server; module-only (Publish), called inside the held decision that makes the site public (deploy.publish is the outward act and carries the person's yes; a nested outward call would need a second card for the same act)",
  "appmods.publish.stop": "stops a site's server; module-only (Publish), taking a site down needs no yes",
  "appmods.publish.remove": "removes a site's server and keeps its data; module-only (Publish), taking a site down needs no yes",
  "vault.mcp.agent.call": "the Vault's own tool call as an outside agent: a read runs, anything that changes something outside is held for the person by the same relay as vault.request; only the outside-agents module asks",
  "previews.share": "chooses which people inside the Space (me, the project, everyone) may open a preview; nothing leaves the Space",
  "previews.reply": "the person types the answer a stuck run asked for, on its card; it goes to the person's own agent and nowhere else",
  "work.file.share": "a share record by someone in the chat: it opens one file to the chat's project members inside the Space; nothing leaves the Space",
  "files.drop.push": "the daemon hands a sealed file to the person's own paired device (VyreDrop): module-only, nothing leaves the person's devices",
  "names.directory.publish": "publishes the Space's own signed directory record (its name and keys) through the names module: infrastructure, no content of the person's",
  "wink.home.call": "a call from this home to another home of the same person's (the project move door): stays inside the person's own homes",
  "wink.device.call": "a call to one of the person's own paired devices: stays inside the person's own devices",
  "bridges.merge.links": "a device reads its own Space links and merges them itself; nothing is sent",
  "computers.checkout": "gives an agent a screen on your own computer",
  "files.send": "Taildrop from your Mac to your own box",
  "github.session.review": "reads comments on open pull requests; a read",
  "glass.files.upload": "a one-use path for a file into a folder on your own target",
  "chrome.op.call": "one learned READ in the person's own Chrome for the box: it refuses an operation that submits and points to chrome.op.send, which is marked outward",
  "link.call": "a Mac calls a tool on its own box",
  "link.macs.call": "the box calls a tool on its own paired Mac",
  "link.reply": "a paired Mac answers its own box's question",
  "link.upload": "one chunk of your own sync upload to your own box",
  "mcp.call": "the MCP hub classifies each target tool and holds the outward ones at the Gate; the generic call is not itself a send",
  "memory.merge": "merges memory between your own devices",
  "publish.create": "starts a draft; nothing is public until publish.publish",
  "publish.flow": "a read of the publish flow",
  "publish.list": "a read",
  "publish.plan": "a read",
  "publish.status": "a read",
  "push.devices": "lists your own devices for notifications",
  "push.key": "the key your own devices subscribe with",
  "push.receipt": "your own device confirms a notification arrived",
  "push.seen": "your own device marks a notification seen",
  "push.settings": "settings for notifications to your own devices",
  "push.subscribe": "your own device subscribes",
  "push.test": "a test notification to your own devices",
  "push.unsubscribe": "your own device unsubscribes",
  "relay.code.reply": "the box answers its own new server's pairing code",
  "spaces.code.submit": "the person's own new server sends the code its person typed",
  "spaces.merge-list": "merges the lists of your own spaces",
  "stream.send": "words in a group chat inside Vyre; a person or assistant in the space, not a service outside",
  "sync.send": "your own files to your own box",
  "sync.upload.cancel": "your own sync upload to your own box",
  "sync.upload.chunk": "your own sync upload to your own box",
  "sync.upload.finish": "your own sync upload to your own box",
  "sync.upload.plan": "your own sync upload to your own box",
  "sync.upload.start": "your own sync upload to your own box",
  "tasks.submit": "the doer hands work to the task kernel inside Vyre",
  "team.merge": "the integrator's fast-forward of a project's own branch in its own worktree",
  "threads.post": "words from a module into a thread inside Vyre",
  "threads.send": "types into your own thread inside Vyre",
  "threads.send-now": "queued words into your own running thread",
  "wink.share": "lends one of your own computers to your own space",
  "work.call": "runs another tool; that tool's own flag decides, and an outward act comes back held",
};

/** Every module.json under core, local and modules, at any depth. @param {string} dir @returns {string[]} */
function manifests(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.name === "node_modules" ? [] : e.isDirectory() ? manifests(path.join(dir, e.name)) : e.name === "module.json" ? [path.join(dir, e.name)] : []));
}

/** @returns {{ module: string, name: string, outward: any, asks: boolean }[]} */
function allTools() {
  const out = [];
  for (const dir of ["core", "local", "modules"]) {
    for (const f of manifests(path.join(ROOT, dir))) {
      const m = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const t of (m.does && m.does.tools) || []) out.push(typeof t === "string" ? { module: m.name || path.basename(path.dirname(f)), name: t, outward: undefined, asks: false } : { module: m.name || path.basename(path.dirname(f)), name: t.name, outward: t.outward, asks: t.asks === true });
    }
  }
  return out;
}

/** What each `asks: true` tool's declared ask flow is proven by: a test where an agent's call is held (or refused) and never runs. The file must hold the named test. A tool that does not say `asks` is held in the approvals queue by the registry (core/modules/modules.test.js, the held_for_approval case). */
const ASKS_PROOF = {
  "chrome.op.send": ["test/site-mac-rung.test.js", "an outward operation runs on the Mac only with the box's signed assertion for exactly that call, from the connectors module alone, and once"],
  "publish.approve": ["core/publish/publish.test.js", "a model chain can create, preview and request, never decide, approve or publish"],
  "publish.publish": ["core/publish/publish.test.js", "a model chain can create, preview and request, never decide, approve or publish"],
  "publish.go": ["lib/publish/index.test.js", "one tap: a previewed version goes live on one decision that also approves the preview"],
  "publish.quick": ["core/publish/publish.test.js", "publish: quick takes a folder of ready files to live on one decision"],
  "publish.rollback": ["core/publish/publish.test.js", "create, preview, plan, approve held then decided, publish held then decided, rollback"],
  "publish.secret.grant": ["core/publish/publish.test.js", "a secret granted to deployment A is absent from B"],
  "github.project.pr.open": ["core/github/registry.test.js", "reach asked - an agent is refused not_asked"],
  "github.project.pr.merge": ["core/github/registry.test.js", "reach asked - an agent is refused not_asked"],
  "github.project.pr.review": ["core/github/registry.test.js", "reach asked - an agent is refused not_asked"],
  "google.mail.send": ["core/google/module.test.js", "holds sends and invites"],
  "google.calendar.create": ["core/google/module.test.js", "holds sends and invites"],
  "google.calendar.update": ["core/google/module.test.js", "holds sends and invites"],
  "apps.send": ["local/apps/module.test.js", "apps.send needs a person's proof from every non-module caller"],
  "vault.api.send": ["core/vault/api-credential.test.js", "vault.request and its Gate sender: who may call"],
  "vault.forward": ["core/vault/api-credential.test.js", "vault.request and its Gate sender: who may call"],
  "vault.forward.file": ["core/vault/api-credential.test.js", "vault.request and its Gate sender: who may call"],
  "vault.service.forward": ["core/vault/api-credential.test.js", "vault.request and its Gate sender: who may call"],
};

const tools = allTools();

test("every tool with an outward verb is marked outward or listed as not outward", () => {
  const missing = tools.filter(t => VERBS.test(t.name) && !t.outward && !NOT_OUTWARD[t.name]).map(t => t.name);
  assert.deepEqual(missing, [], `mark these \`outward: true\` in their module.json, or add each to NOT_OUTWARD with a reason: ${missing.join(", ")}`);
});

test("a tool is never both marked outward and listed as not outward", () => {
  const both = tools.filter(t => t.outward && NOT_OUTWARD[t.name]).map(t => t.name);
  assert.deepEqual(both, []);
});

test("every NOT_OUTWARD entry names a real tool and gives a reason", () => {
  const names = new Set(tools.map(t => t.name));
  for (const [n, why] of Object.entries(NOT_OUTWARD)) {
    assert.ok(names.has(n), `${n} is listed as not outward but no module.json declares it`);
    assert.ok(typeof why === "string" && why.length > 4, `${n} needs a reason`);
  }
});

test("the outward flag is true or a Gate kind word", () => {
  for (const t of tools) if (t.outward !== undefined) assert.ok(t.outward === true || ["send", "post", "pay", "delete"].includes(t.outward), `${t.name}: outward ${JSON.stringify(t.outward)}`);
});

test("a tool that says `asks: true` is outward and names the test that proves its own flow holds an agent", () => {
  for (const t of tools.filter(x => x.asks)) {
    assert.ok(t.outward, `${t.name}: asks without outward`);
    const p = ASKS_PROOF[t.name];
    assert.ok(p, `${t.name}: add it to ASKS_PROOF with the test where an agent's call is held and never runs`);
    const src = fs.readFileSync(path.join(ROOT, p[0]), "utf8");
    assert.ok(src.includes(p[1]), `${t.name}: ${p[0]} has no test named "${p[1]}"`);
    // a test that is skipped proves nothing: its title must not be followed by a skip option
    const at = src.indexOf(p[1]);
    assert.ok(!/^["'`]\s*,\s*\{[^}]*\bskip\b/.test(src.slice(at + p[1].length, at + p[1].length + 200)), `${t.name}: the test "${p[1]}" in ${p[0]} is skipped`);
  }
  for (const n of Object.keys(ASKS_PROOF)) assert.ok(tools.some(t => t.name === n && t.asks), `${n} is in ASKS_PROOF but does not say asks: true`);
});

/** A valid-looking input from a tool's own schema: enough to get past validation, nothing real. @param {any} schema @returns {any} */
function sample(schema) {
  if (!schema || typeof schema !== "object") return "x";
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object" || schema.properties) {
    /** @type {Record<string, any>} */ const o = {};
    for (const k of schema.required || []) o[k] = sample((schema.properties || {})[k]);
    return o;
  }
  if (type === "array") return schema.minItems ? [sample(schema.items)] : [];
  if (type === "integer" || type === "number") return Math.max(1, Number(schema.minimum) || 1);
  if (type === "boolean") return true;
  const base = "x@example.com";
  return schema.minLength && schema.minLength > base.length ? "x".repeat(schema.minLength) : base;
}

test("an outward tool called by a model is held or refused and never runs: every tool the registry flags outward, called as a bare model with a valid input, leaves no side effect", { timeout: 240_000 }, async t => {
  const { start } = await import("../core/daemon/index.js");
  const { tempHome } = await import("./helpers.js");
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const outward = [...d.registry.tools].filter(([, def]) => def.outward).map(([name]) => name);
  assert.ok(outward.length > 30, `the registry flags its outward tools (${outward.length})`);
  /** @type {string[]} */ const ran = [];
  for (const name of outward) { const def = d.registry.tools.get(name); const run = def.run; def.run = async (/** @type {any[]} */ ...a) => { ran.push(name); return run(...a); }; }
  /** @type {Record<string, number>} */ const outcomes = {};
  for (const name of outward) {
    const def = d.registry.tools.get(name);
    const r = await d.registry.call(name, sample(def.input), "mcp:agent:kit").catch((/** @type {any} */ e) => ({ error: { code: "threw:" + String(e && e.message).slice(0, 40) } }));
    const how = r && r.error ? String(r.error.code) : "answered";
    outcomes[how] = (outcomes[how] || 0) + 1;
    assert.notEqual(how, "answered", `${name}: a model's call to an outward tool was answered, not held`);
  }
  // a tool that says `asks: true` runs and holds inside its own flow (proven by ASKS_PROOF above); every other outward tool is held by the registry before it runs
  const own = new Set(tools.filter(x => x.asks).map(x => x.name));
  const leaked = ran.filter(n => !own.has(n));
  assert.deepEqual(leaked, [], `these outward tools ran for a bare model: ${leaked.join(", ")}`);
  // the check bites: a good share of them reached the hold itself (the rest were refused earlier, by who may call them or by their input)
  assert.ok((outcomes.held_for_approval || 0) >= 3 && (outcomes.held_for_approval || 0) + (outcomes.held_unavailable || 0) >= 10, `the hold was reached by some of them: ${JSON.stringify(outcomes)}`);
});
