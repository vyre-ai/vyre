// @ts-check
// All settings and This computer (the Deck's settings-keys.js and settings.js sections, ported) over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const SCHEMA = { groups: [{ id: "general", label: "General" }, { id: "empty", label: "Empty" }, { id: "claude", label: "Claude" }], keys: [
  { key: "a.on", group: "general", label: "Keep going", type: "bool", levels: ["account", "project"], apply: "live", default: false },
  { key: "a.mode", group: "general", label: "Mode", type: "enum", enum: ["ask", "auto"], labels: { ask: "Ask first" }, levels: ["account"] },
  { key: "a.many", group: "general", label: "Many", type: "enum", enum: ["a", "b", "c", "d", "e"], levels: ["account"] },
  { key: "a.n", group: "general", label: "Turns", type: "int", min: 1, max: 10, levels: ["account"], apply: "restart" },
  { key: "a.step", group: "general", label: "Step", type: "int", choices: [5, 15], levels: ["account"] },
  { key: "a.deep", group: "general", label: "Deep", type: "string", advanced: true, levels: ["account"] },
  { key: "a.proj", group: "general", label: "Per project", type: "bool", levels: ["project"] },
  { key: "a.list", group: "claude", label: "Tools", type: "list", levels: ["account"] },
  { key: "a.hid", group: "general", label: "Hidden", type: "bool", hidden: true },
] };

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o[tool]) return o[tool];
    return { data: tool === "settings.schema" ? SCHEMA : {} };
  };
  return { call, seen };
}

test("keys: hidden keys and empty groups are dropped; each type gets its control", { skip: !strip }, async () => {
  const m = await import("./keys-model.ts");
  const s = m.schemaOf(SCHEMA);
  assert.deepEqual(s.keys.map((k) => k.key), ["a.on", "a.mode", "a.many", "a.n", "a.step", "a.deep", "a.proj", "a.list"]);
  assert.deepEqual(s.groups.map((g) => g.id), ["general", "claude"]);
  const c = Object.fromEntries(s.keys.map((k) => [k.key, m.controlOf(k)]));
  assert.deepEqual(c, { "a.on": "switch", "a.mode": "segment", "a.many": "select", "a.n": "number", "a.step": "segment", "a.deep": "text", "a.proj": "switch", "a.list": "readonly" });
  assert.deepEqual(m.choicesOf(s.keys[1]), [["ask", "Ask first"], ["auto", "auto"]]);
  assert.deepEqual(m.choicesOf(s.keys[4]), [["5", "5"], ["15", "15"]]);
});

test("keys: Find matches the label or the key, advanced ones wait unless asked or found, project-only keys are not at account level", { skip: !strip }, async () => {
  const m = await import("./keys-model.ts");
  const s = m.schemaOf(SCHEMA);
  const ids = (/** @type {any} */ v) => v.flatMap((/** @type {any} */ g) => g.keys.map((/** @type {any} */ k) => k.key));
  assert.deepEqual(ids(m.visible(s, "", false)), ["a.on", "a.mode", "a.many", "a.n", "a.step", "a.list"]);
  assert.ok(ids(m.visible(s, "", true)).includes("a.deep"));
  assert.deepEqual(ids(m.visible(s, "DEEP", false)), ["a.deep"]);
  assert.deepEqual(ids(m.visible(s, "a.mo", false)), ["a.mode"]);
  assert.deepEqual(m.visible(s, "zzz", false), []);
});

test("keys: a typed number is whole for an int and inside min and max, and says which", { skip: !strip }, async () => {
  const m = await import("./keys-model.ts");
  const k = m.schemaOf(SCHEMA).keys.find((x) => x.key === "a.n");
  assert.deepEqual(m.numberInput(/** @type {any} */ (k), " 4 "), { value: 4 });
  assert.match(/** @type {any} */ (m.numberInput(/** @type {any} */ (k), "2.5")).problem, /whole/);
  assert.match(/** @type {any} */ (m.numberInput(/** @type {any} */ (k), "0")).problem, /at least 1/);
  assert.match(/** @type {any} */ (m.numberInput(/** @type {any} */ (k), "11")).problem, /at most 10/);
  assert.match(/** @type {any} */ (m.numberInput(/** @type {any} */ (k), "")).problem, /not a number/);
  assert.equal(m.APPLY.restart, "After restart");
  assert.equal(m.valueLine(/** @type {any} */ (k), true), "On");
  assert.equal(m.valueLine(/** @type {any} */ (k), ["x", "y"]), "x, y");
  assert.match(m.refusal(new Error("no passkey is enrolled for this person")), /passkey/);
});

test("keys: set and reset go to the account level by key; values are read by key", { skip: !strip }, async () => {
  const { keysSource } = await import("./keys-source.ts");
  const b = box({ "settings.get": { data: { settings: [{ key: "a.on", value: true, source: "account", account: true }] } } });
  const s = keysSource(b.call);
  assert.equal((await s.values()).get("a.on")?.value, true);
  await s.set("a.n", 4);
  await s.reset("a.n");
  await s.one("a.n");
  assert.deepEqual(b.seen.slice(1).map((x) => [x.tool, x.input]), [["settings.set", { key: "a.n", level: "account", value: 4 }], ["settings.reset", { key: "a.n", level: "account" }], ["settings.get", { key: "a.n" }]]);
  const m = await import("./keys-model.ts");
  assert.equal(m.canReset({ key: "a.n", account: 4 }), true);
  assert.equal(m.canReset({ key: "a.n", value: 1, source: "default" }), false);
  assert.equal(m.sourceLine({ key: "a.n", source: "account" }), "Changed");
});

test("system: the machine lines, the hosted app, and a name only when the box names itself", { skip: !strip }, async () => {
  const m = await import("./system-model.ts");
  const info = { host: "atlas", role: "box", version: "0.2.9", platform: "linux", node: "v22", serverName: "Atlas", network: { origins: ["https://app.vyre.run"] } };
  assert.deepEqual(m.machineRows(info).map(([k]) => k), ["Host", "Role", "Vyre", "Platform", "Node"]);
  assert.equal(m.nameOf(info), "Atlas");
  assert.equal(m.nameOf({ serverName: "" }), null);
  assert.match(/** @type {string} */ (m.hostedLine(info)), /app\.vyre\.run can reach your home/);
  assert.equal(m.hostedLine({ network: { origins: [] } }), "No hosted app can reach your home.");
  assert.equal(m.hostedLine({}), null);
});

test("system: history says what is indexed and why search by meaning is off", { skip: !strip }, async () => {
  const m = await import("./system-model.ts");
  const v = m.recallView({ sessions: 1, turns: 2, folders: ["/a"], last: { at: 1000, added: 3, skipped: 4 }, vectors: { on: false, why: "the model is not installed" }, indexing: true }, 3600_000 + 1000);
  assert.deepEqual(v.lines, [["Indexed", "1 session, 2 turns"], ["Folders", "/a"], ["Last pass", "1 hour ago: 3 added, 4 unchanged"], ["Search by meaning", "Off. The model is not installed."]]);
  assert.equal(v.indexing, true);
  assert.equal(m.recallView({}).lines[2][1], "Not yet");
});

test("system: webhooks off shows the one command, on lists routes, mismatches and the fixes", { skip: !strip }, async () => {
  const m = await import("./system-model.ts");
  const off = m.hooksCard({ enabled: false }, null);
  assert.equal(off.state, "Off");
  assert.deepEqual(off.commands.map((c) => c.line), ["vyre hooks on"]);
  const on = m.hooksCard({ enabled: true, listening: false, error: "port busy", routes: [{ name: "stripe", path: "/hooks/stripe", verify: { scheme: "hmac-sha256" }, deliveries: 2, funnel: { open: "tailscale funnel 443" } }] },
    { mismatches: [{ message: "stripe is not published", fix: "tailscale funnel --bg 443" }, { message: "443 is used", harmless: true }] });
  assert.equal(on.state, "On, 1 open route");
  assert.deepEqual(on.warn, ["The webhook listener is not answering (port busy).", "Funnel and Vyre disagree: stripe is not published.", "443 is used. Harmless."]);
  assert.ok(on.commands.some((c) => c.line === "vyre hooks close stripe"));
  assert.ok(on.commands.some((c) => c.line === "tailscale funnel --bg 443"));
});

test("system: guests, agent nodes, egress and lock say on or off and what is wrong", { skip: !strip }, async () => {
  const m = await import("./system-model.ts");
  const g = m.guestsCard({ enabled: true, safe: ["threads.list"], people: [{ login: "sam@x.example", tools: ["threads.list", "vault.reveal"], allowed: ["threads.list"] }] });
  assert.equal(g.state, "On, 1 person");
  assert.deepEqual(g.warn, ["Listed for sam@x.example but not guest-safe, so refused: vault.reveal."]);
  assert.equal(m.guestsCard({ enabled: false }).state, "Off");
  const t = m.tailnetCard({ enabled: true, tag: "tag:a", computers: [{ agent: "kit", node: "kit-1", running: true }], vault: { item: "ts-key", exists: true, granted: false } });
  assert.deepEqual(t.lines, ["Tagged tag:a.", "Auth key ts-key in the Vault: there, not granted yet.", "kit (kit-1), running"]);
  const e = m.egressCard({ enabled: true, sites: ["a.com"], sidecar: { answers: false, why: "refused" } });
  assert.equal(e.state, "On, 1 site");
  assert.match(e.warn[0], /does not answer \(refused\)/);
  assert.equal(m.lockCard({ enabled: true, signed: false, trusted: 2 }).lines[0].includes("not signed yet"), true);
  const off = m.lockCard({ enabled: false, key: "tlpub:abc" });
  assert.equal(off.commands[1].line, "tlpub:abc");
  assert.match(m.lockCard({ enabled: false, why: "no tailscale" }).warn[0], /no tailscale/);
});

test("system: hand-back keeps its choices; shares flip between read only and read and write; the audit names what it found", { skip: !strip }, async () => {
  const m = await import("./system-model.ts");
  const { systemSource } = await import("./system-source.ts");
  assert.deepEqual(m.handbackOf({ minutes: 5, warn_s: 8, choices: [0, 2, 5] }), { minutes: 5, choices: [0, 2, 5], warn: 8 });
  assert.deepEqual(m.handbackOf({}).choices, [0, 2, 5, 15]);
  assert.equal(m.handbackLabel(0), "Off");
  assert.equal(m.handbackLabel(2), "After 2 min idle");
  assert.equal(m.flipAccess("ro"), "rw");
  assert.equal(m.flipAccess("rw"), "ro");
  assert.equal(m.accessWord("rw"), "Read and write");
  assert.deepEqual(m.auditLines({ checked: 3 }), { ok: true, lines: ["Only your paired Macs can reach them. Checked 3 online devices."] });
  const bad = m.auditLines({ unsafe: [{ share: "docs", found: [".env"] }, { share: "x", why: "unreadable" }], findings: [{ node: "phone" }] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.lines.slice(0, 2), ["docs has secrets inside: .env", "x could not be checked for secrets: unreadable."]);
  assert.match(bad.lines[2], /^1 device outside your paired Macs can reach these shares: phone\./);
  const b = box({ "recall.status": { error: { code: "no_such_tool", message: "no" } } });
  const s = systemSource(b.call);
  assert.equal(await s.recall(), null, "a tool the box lacks leaves its card out");
  await s.setHandback(5);
  await s.setAccess("docs", "rw");
  await s.rename("  Atlas ");
  assert.deepEqual(b.seen.slice(1).map((x) => [x.tool, x.input]), [["computers.handback.set", { minutes: 5 }], ["files.drive.access", { name: "docs", mode: "rw" }], ["system.rename", { name: "Atlas" }]]);
});
