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
const VERBS = /(^|[.-])(send|post|pay|publish|reply|forward|share|invite|transfer|merge|push|upload|submit|call|checkout|tweet|email)([.-]|$)/;

/** Tools whose name matches a verb but that stay inside your own spaces and devices (or do not act). One line each. */
const NOT_OUTWARD = {
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
  "previews.reply": "the person types the answer a stuck run asked for on its card; it reaches the agent that asked, inside Vyre",
  "previews.share": "sets which people of the Space may open a preview (me, project, team); anyone-with-the-link is refused until the public door exists, and will go through Publish and the Gate then",
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

/** @returns {{ module: string, name: string, outward: any }[]} */
function allTools() {
  const out = [];
  for (const dir of ["core", "local", "modules"]) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, "module.json");
      if (!fs.existsSync(f)) continue;
      const m = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const t of (m.does && m.does.tools) || []) out.push(typeof t === "string" ? { module: m.name || d, name: t, outward: undefined, asks: false } : { module: m.name || d, name: t.name, outward: t.outward, asks: t.asks === true });
    }
  }
  return out;
}

/** What each `asks: true` tool's declared ask flow is proven by: a test where an agent's call is held (or refused) and never runs. The file must hold the named test. A tool that does not say `asks` is held in the approvals queue by the registry (core/modules/modules.test.js, the held_for_approval case). */
const ASKS_PROOF = {
  "chrome.op.send": ["test/site-mac-rung.test.js", "an outward operation runs on the Mac only with the box's signed assertion for exactly that call, from the connectors module alone, and once"],
  "publish.approve": ["core/publish/publish.test.js", "a model chain can create, preview and request, never decide, approve or publish"],
  "publish.publish": ["core/publish/publish.test.js", "a model chain can create, preview and request, never decide, approve or publish"],
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

test("the reviewer's 70 candidates each end up marked or listed", () => {
  const f = path.join(ROOT, "..", "team", "0.3", "reviews", "repros", "r3-outward-candidates.txt");
  if (!fs.existsSync(f)) return;
  const byName = new Map(tools.map(t => [t.name, t]));
  const loose = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const n = line.trim();
    if (!n || n.startsWith("#")) continue;
    const t = byName.get(n);
    if (!(t && t.outward) && !NOT_OUTWARD[n]) loose.push(n);
  }
  assert.deepEqual(loose, []);
});

test("a tool that says `asks: true` is outward and names the test that proves its own flow holds an agent", () => {
  for (const t of tools.filter(x => x.asks)) {
    assert.ok(t.outward, `${t.name}: asks without outward`);
    const p = ASKS_PROOF[t.name];
    assert.ok(p, `${t.name}: add it to ASKS_PROOF with the test where an agent's call is held and never runs`);
    const src = fs.readFileSync(path.join(ROOT, p[0]), "utf8");
    assert.ok(src.includes(p[1]), `${t.name}: ${p[0]} has no test named "${p[1]}"`);
  }
  for (const n of Object.keys(ASKS_PROOF)) assert.ok(tools.some(t => t.name === n && t.asks), `${n} is in ASKS_PROOF but does not say asks: true`);
});

test("every outward tool the registry holds is bound to its exact input: a card carries a digest of the whole input, and a changed input has another digest", async () => {
  const { holdFields } = await import("../core/modules/index.js");
  const held = tools.filter(t => t.outward === true && !t.asks).map(t => t.name);
  assert.ok(held.length > 10, `found the registry-held outward tools (${held.length})`);
  for (const name of held) {
    const a = holdFields({ tool: name, to: "x@example.com", body: "one", nested: { n: [1, 2] } }), b = holdFields({ tool: name, to: "x@example.com", body: "two", nested: { n: [1, 2] } });
    const c = holdFields({ nested: { n: [1, 2] }, body: "one", to: "x@example.com", tool: name });
    assert.match(a.input_sha256, /^[0-9a-f]{32}$/, `${name}: a digest of the whole input`);
    assert.notEqual(a.input_sha256, b.input_sha256, `${name}: a changed input is another act`);
    assert.equal(a.input_sha256, c.input_sha256, `${name}: key order is not a different act`);
  }
});
