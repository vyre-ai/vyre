// @ts-check
// Vault's other pages against a fake box: tool names and inputs, the shapes picked, the words, and that no value ever comes back.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const NOW = Date.parse("2026-10-05T12:00:00Z");

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o.error?.[tool]) return { error: o.error[tool] };
    switch (tool) {
      case "vault.caps": return { data: { reveal: true, breach: "ask", host: "myserver" } };
      case "vault.pass.list": return { data: { passes: [
        { id: "p1", holder: "dana", person: "Dana", items: ["Stripe"], note: "Read reports", mode: "relayed", expires: "2026-10-31T00:00:00Z" },
        { id: "p2", holder: "theo", items: ["Gmail"], mode: "sealed", status: "pending" },
        { id: "p3", holder: "old", items: [], status: "revoked" }], held: [{ id: "h1", owner: "kit", items: ["Drive"], mode: "relayed" }] } };
      case "vault.pending": return { data: { grants: [{ id: "g1", name: "Gmail", module: "watch", watcher: "intake", by: "agent:kit", at: 1 }], passes: [{ id: "p2", holder: "theo", items: ["Gmail"], mode: "sealed", by: "mcp", created: 2 }, { holder: "no id" }] } };
      case "vault.pass.create": return { data: o.create ?? { ticket: "vyre-ticket:abc" } };
      case "vault.pass.revoke": return { data: { rotate: ["Stripe", 3] } };
      case "vault.offboard": return { data: { revoked: ["p1", "p2"], rotate: ["Stripe"] } };
      case "vault.devices": return { data: { devices: [{ id: "d1", name: "Chrome", created: NOW - 5 * 86400_000, lastSeen: NOW - 86400_000, sessions: 2 }, { id: "d2", created: NOW - 90 * 86400_000, revoked: NOW - 10 * 86400_000 }, { name: "no id" }] } };
      case "vault.health": return { data: { checked: 5, counts: { weak: 1, reused: 2, old: 0 }, items: [{ name: "A", kind: "login", reasons: ["weak", "reused"], group: "g1" }, { name: "B", kind: "login", reasons: ["reused"], group: "g1" }, { name: "x" }] } };
      case "vault.emergency.list": return { data: { contacts: [
        { person: "Dana", wait: "7d", wait_ms: 7 * 86400_000, state: "standby", items: "every item except ssh keys and passkeys", created: 1, refreshed: 2 },
        { person: "Theo", wait: "3d", wait_ms: 3 * 86400_000, state: "waiting", requested: Date.parse("2026-10-04T00:00:00Z"), opens: Date.parse("2026-10-07T00:00:00Z"), items: ["Gmail", "Bank"] },
        { person: "Kit", wait: "1d", wait_ms: 86400_000, state: "denied", denied: Date.parse("2026-10-01T00:00:00Z"), items: "x", secret: "never" },
        { person: "Old", wait: "30d", wait_ms: 30 * 86400_000, state: "released", released: Date.parse("2026-09-01T00:00:00Z"), items: [] }] } };
      case "vault.emergency.add": case "vault.emergency.deny": case "vault.emergency.remove": case "vault.emergency.refresh": return { data: { ok: true } };
      case "vault.breach.check": return { data: { checked: 4, breached: ["A", 7] } };
      case "vault.history": return { data: { versions: [{ ver: 2, at: NOW - 86400_000, fields: ["password"], by: "cli" }, { ver: 1, at: NOW - 9 * 86400_000, by: "deck" }, { ver: 9 }], passwords: [{ at: NOW - 5 * 86400_000 }, { at: NOW - 40 * 86400_000 }] } };
      case "vault.update": return { data: o.update ?? { generated: "password" } };
      default: return { data: {} };
    }
  };
  return { call, seen };
}

test("passes: given and held, revoked left out, waiting known; pending lists grants and passes with ids only", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  const b = box();
  const r = await vaultMoreSource(b.call).passes();
  assert.deepEqual(r.passes.map((p) => [p.id, p.direction, p.holder, p.state, p.mode]), [["p1", "to", "dana", "active", "relayed"], ["p2", "to", "theo", "waiting", "sealed"], ["h1", "from", "kit", "active", "relayed"]]);
  assert.equal(r.passes[0].scope, "Read reports");
  assert.deepEqual(r.pending.map((x) => [x.id, x.kind]), [["g1", "grant"], ["p2", "pass"]]);
  const none = await vaultMoreSource(box({ error: { "vault.pending": { code: "no_such_tool", message: "x" } } }).call).passes();
  assert.deepEqual(none.pending, []);
});

test("the waiting line names who asked and what", { skip: !strip }, async () => {
  const { pickPending, waitingLine, whoAsked } = await import("./more-model.ts");
  const w = pickPending({ grants: [{ id: "g", name: "Gmail", module: "watch", watcher: "intake", by: "agent:kit" }], passes: [{ id: "p", holder: "theo", items: ["Gmail", "Drive"], mode: "sealed", by: "mcp:claude" }] });
  assert.equal(waitingLine(w[0]), "kit asked to let watch/intake use Gmail");
  assert.equal(waitingLine(w[1]), "Claude asked to share Gmail, Drive with theo, sealed");
  assert.equal(whoAsked(""), "An agent");
});

test("approve and deny: a grant is revoked, a pass is ended", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  const b = box();
  const s = vaultMoreSource(b.call);
  await s.approve("g1");
  await s.deny({ kind: "grant", id: "g1", name: "Gmail", module: "watch", watcher: "intake" });
  await s.deny({ kind: "grant", id: "g2", name: "Gmail", module: "mail", watcher: "" });
  await s.deny({ kind: "pass", id: "p2", name: "", module: "", watcher: "" });
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["vault.approve", { id: "g1" }], ["vault.revoke", { name: "Gmail", module: "watch", watcher: "intake" }], ["vault.revoke", { name: "Gmail", module: "mail" }], ["vault.pass.revoke", { id: "p2" }]]);
});

test("make a pass: input only from what was chosen; hosts narrowed only for a relayed pass that switched some off", { skip: !strip }, async () => {
  const { passInput } = await import("./more-model.ts");
  const hostsOf = (/** @type {string} */ i) => ({ Stripe: ["https://api.stripe.com", "https://dashboard.stripe.com"], Gmail: [] })[i] ?? [];
  const base = { holder: " dana ", items: ["Stripe"], mode: /** @type {"relayed"} */ ("relayed"), expires: /** @type {"30d"} */ ("30d"), card: "", note: "", offHosts: [] };
  assert.deepEqual(passInput(base, hostsOf), { input: { holder: "dana", items: ["Stripe"], mode: "relayed", expires: "30d" } });
  assert.deepEqual(passInput({ ...base, card: " vyre-card:x ", note: "Reports", offHosts: ["https://dashboard.stripe.com"] }, hostsOf), { input: { holder: "dana", items: ["Stripe"], mode: "relayed", expires: "30d", card: "vyre-card:x", note: "Reports", hosts: ["https://api.stripe.com"] } });
  assert.equal("hosts" in /** @type {any} */ (passInput({ ...base, mode: "sealed", offHosts: ["https://dashboard.stripe.com"] }, hostsOf)).input, false);
  assert.deepEqual(passInput({ ...base, holder: " " }, hostsOf), { error: "Say who it is for." });
  assert.deepEqual(passInput({ ...base, items: [] }, hostsOf), { error: "Choose at least one item." });
});

test("create, revoke, offboard: tool names, the ticket, and what to rotate", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  const { revokedLine } = await import("./more-model.ts");
  const b = box();
  const s = vaultMoreSource(b.call);
  assert.deepEqual(await s.createPass({ holder: "dana", items: ["Stripe"] }), { ticket: "vyre-ticket:abc", pending: false });
  assert.deepEqual(await vaultMoreSource(box({ create: { pass: { status: "pending" } } }).call).createPass({}), { ticket: "", pending: true });
  assert.deepEqual(await s.revokePass("p1"), ["Stripe"]);
  assert.deepEqual(await s.offboard("dana"), { ended: 2, rotate: ["Stripe"] });
  assert.deepEqual(b.seen.map((x) => x.tool), ["vault.pass.create", "vault.pass.revoke", "vault.offboard"]);
  assert.equal(revokedLine("dana", ["Stripe"]), "Ended. Replace Stripe: they kept a sealed copy.");
  assert.equal(revokedLine("dana", []), "Ended. dana cannot use it any more.");
});

test("lines for a pass and a device", { skip: !strip }, async () => {
  const { pickPasses, passLine, expiryWord, pickDevices, deviceLines } = await import("./more-model.ts");
  const [p1, p2, h1] = pickPasses({ passes: [{ id: "p1", holder: "dana", person: "Dana", items: ["Stripe", "Gmail"], note: "Read reports", expires: "2026-10-31T00:00:00Z" }, { id: "p2", holder: "theo", status: "pending", mode: "sealed" }], held: [{ id: "h1", owner: "kit" }] });
  assert.deepEqual(passLine(p1), { title: "To dana, Dana", sub: "Stripe, Gmail, Read reports", state: "Relayed, until 31 oct" });
  assert.equal(passLine(p2).state, "Waiting, no end date");
  assert.equal(passLine(h1).title, "From kit");
  assert.equal(expiryWord(null), "No end date");
  assert.equal(expiryWord("whenever"), "whenever");
  const [d1, d2] = pickDevices({ devices: [{ id: "d1", name: "Chrome", created: NOW - 5 * 86400_000, lastSeen: NOW - 86400_000, sessions: 2 }, { id: "d2", created: NOW - 90 * 86400_000, revoked: NOW - 10 * 86400_000 }] });
  assert.deepEqual(deviceLines(d1, NOW), { sub: "Paired 5 days ago, last seen yesterday", sessions: "2 open sessions" });
  assert.deepEqual(deviceLines(d2, NOW), { sub: "Revoked 10 days ago", sessions: "" });
  assert.equal(d2.name, "A browser");
});

test("devices: ones without an id are dropped; revoke sends the id", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  const b = box();
  const s = vaultMoreSource(b.call);
  assert.deepEqual((await s.devices()).map((d) => d.id), ["d1", "d2"]);
  await s.revokeDevice("d1");
  assert.deepEqual(b.seen[1], { tool: "vault.device.revoke", input: { id: "d1" } });
});

test("Watchtower: groups in the Deck's order, only reasons with items, reused kept together; breach check words", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  const { healthGroups, breachLine, pickCaps } = await import("./more-model.ts");
  const b = box();
  const s = vaultMoreSource(b.call);
  const h = await s.health();
  assert.equal(h.checked, 5);
  const g = healthGroups(h);
  assert.deepEqual(g.map((x) => [x.code, x.title]), [["weak", "Weak, 1"], ["reused", "Reused, 2"]]);
  assert.deepEqual(g[1].rows.map((r) => [r.name, r.others]), [["A", ["B"]], ["B", ["A"]]]);
  const br = await s.breachCheck();
  assert.deepEqual(br, { checked: 4, breached: ["A"] });
  assert.equal(breachLine(br), "1 of 4 passwords appear in known breaches. Replace them.");
  assert.equal(breachLine({ checked: 4, breached: [] }), "None of 4 passwords appear in known breaches.");
  assert.deepEqual(await s.caps(), { reveal: true, breach: "ask", host: "myserver" });
  assert.deepEqual(pickCaps(null), { reveal: false, breach: "off", host: "" });
});

test("history: versions with who and when, earlier passwords counted, never shown; a box without it is null", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  const { versionLine } = await import("./more-model.ts");
  const b = box();
  const s = vaultMoreSource(b.call);
  const h = /** @type {any} */ (await s.history("Gmail"));
  assert.deepEqual(b.seen[0], { tool: "vault.history", input: { name: "Gmail" } });
  assert.equal(h.versions.length, 2);
  assert.equal(versionLine(h.versions[0], NOW), "v2, Changed password, You, in a terminal, 4 Oct");
  assert.equal(versionLine(h.versions[1], NOW), "v1, Added, You, 26 Sep");
  assert.deepEqual({ count: h.earlier.count, last: h.earlier.last }, { count: 2, last: NOW - 5 * 86400_000 });
  assert.equal(await vaultMoreSource(box({ error: { "vault.history": { code: "no_such_tool", message: "x" } } }).call).history("Gmail"), null);
  assert.equal(JSON.stringify(h).includes("value"), false);
});

test("update: only what changed is sent; a typed value and a generated one together is refused; nothing changed says so", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  const { updateInput, savedLine } = await import("./more-model.ts");
  assert.deepEqual(updateInput({ name: "Gmail", description: "mail", was: "mail", replace: { password: "" } }), { error: "Nothing changed." });
  assert.deepEqual(updateInput({ name: "Gmail", description: "intake mail", was: "mail", replace: { password: "pw", username: "" } }), { input: { name: "Gmail", description: "intake mail", fields: { password: "pw" } } });
  assert.deepEqual(updateInput({ name: "Gmail", description: "mail", was: "mail", replace: {}, generate: { field: "password", length: 200, symbols: true } }), { input: { name: "Gmail", generate: { field: "password", length: 64, symbols: true } } });
  assert.deepEqual(updateInput({ name: "Gmail", description: "mail", was: "mail", replace: { password: "x" }, generate: { field: "password", length: 24, symbols: false } }), { error: "Type a new password or make one, not both." });
  const b = box();
  const s = vaultMoreSource(b.call);
  assert.deepEqual(await s.update({ name: "Gmail", generate: { field: "password", length: 24, symbols: true } }), { generated: "password" });
  assert.equal(savedLine("Gmail", "password"), "Saved Gmail. A new password was made on your server.");
  assert.equal(savedLine("Gmail"), "Saved Gmail. The values are sealed on your server.");
});

test("ssh key: tool names; a bad name is caught before anything is sent", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  const { sshNameError } = await import("./more-model.ts");
  const b = box();
  const s = vaultMoreSource(b.call);
  await s.sshGenerate("deploy", " for CI ");
  await s.sshGenerate("deploy2");
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["vault.ssh.generate", { name: "deploy", description: "for CI" }], ["vault.ssh.generate", { name: "deploy2" }]]);
  assert.equal(sshNameError("deploy"), "");
  assert.match(sshNameError("my key"), /no spaces/);
});

test("refusals: a proof not given is 'Not done', never an error", { skip: !strip }, async () => {
  const { refusalWord } = await import("./more-model.ts");
  assert.equal(refusalWord({ code: "cancelled" }, "saved"), "Not saved. Nothing was sent.");
  assert.equal(refusalWord({ code: "presence_refused" }, "shared"), "Not shared. Nothing was sent.");
  assert.match(refusalWord({ code: "presence_required" }, "x"), /needs you/);
  assert.match(refusalWord({ code: "locked" }, "x"), /locked/);
  assert.match(refusalWord({ code: "no_such_tool" }, "x"), /cannot do that/);
  assert.equal(refusalWord({ code: "e", message: "Boom" }, "x"), "Boom");
});

test("errors keep their code", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  await assert.rejects(vaultMoreSource(box({ error: { "vault.devices": { code: "locked", message: "Locked." } } }).call).devices(), (e) => /** @type {any} */ (e).code === "locked");
});

test("a pass for an outside agent: its input, what is wrong in words, and the lines it answers with", async () => {
  const { mcpPassInput, pickMcpMade } = await import("./more-model.ts");
  const hostsOf = (/** @type {string} */ i) => (i === "Stripe" ? ["https://api.stripe.com", "https://dashboard.stripe.com"] : []);
  const base = { name: "Dana's Claude", items: ["Stripe"], days: /** @type {7} */ (7), budget: "", offHosts: [], reveal: false };
  assert.deepEqual(mcpPassInput(base, hostsOf), { input: { name: "Dana's Claude", items: ["Stripe"], days: 7 } });
  assert.deepEqual(mcpPassInput({ ...base, budget: "50", offHosts: ["https://dashboard.stripe.com"], reveal: true }, hostsOf), { input: { name: "Dana's Claude", items: ["Stripe"], days: 7, budget: 50, hosts: ["https://api.stripe.com"], reveal: true } });
  assert.deepEqual(mcpPassInput({ ...base, name: " " }, hostsOf), { error: "Say who or what it is for." });
  assert.deepEqual(mcpPassInput({ ...base, items: [] }, hostsOf), { error: "Choose at least one credential." });
  assert.deepEqual(mcpPassInput({ ...base, budget: "many" }, hostsOf), { error: "The calls it may make is a whole number, or leave it empty." });
  assert.deepEqual(mcpPassInput({ ...base, offHosts: ["https://api.stripe.com", "https://dashboard.stripe.com"] }, hostsOf), { error: "Leave at least one host switched on." });
  assert.deepEqual(pickMcpMade({ token: "vmcp_x", name: "Dana", expires: 5, lines: { claude: "claude mcp add a", codex: "codex mcp add a" } }), { token: "vmcp_x", name: "Dana", expires: 5, claude: "claude mcp add a", codex: "codex mcp add a" });
  assert.deepEqual(pickMcpMade(null), { token: "", name: "", expires: null, claude: "", codex: "" });
});

test("an outside agent's ask to see a value: read from vault.pending, and the line it shows", async () => {
  const { pickReveals, revealLine } = await import("./more-model.ts");
  const rows = pickReveals({ mcpReveals: [{ id: "vr_1", item: "stripe-live", pass: "Dana's Claude", why: "to debug" }, { item: "x" }], grants: [] });
  assert.deepEqual(rows, [{ id: "vr_1", item: "stripe-live", pass: "Dana's Claude", why: "to debug" }]);
  assert.equal(revealLine(rows[0]), "Dana's Claude's agent asks to see stripe-live: to debug");
  assert.deepEqual(pickReveals(null), []);
});

test("emergency access: contacts as names, waits and dates; each state has a plain line, only a waiting request can be denied, and the tool inputs are the choices made", { skip: !strip }, async () => {
  const { vaultMoreSource } = await import("./more-source.ts");
  const { emergencyLine, EMERGENCY_WAITS } = await import("./more-model.ts");
  const b = box();
  const src = vaultMoreSource(b.call);
  const list = await src.emergency();
  assert.deepEqual(list.map((c) => [c.person, c.waitDays, c.state]), [["Dana", 7, "standby"], ["Theo", 3, "waiting"], ["Kit", 1, "denied"], ["Old", 30, "released"]]);
  assert.ok(!JSON.stringify(list).includes("never"), "a stray field in an answer does not reach the screen");
  const lines = list.map(emergencyLine);
  assert.equal(lines[0].sub, "Can ask. 7 days after they ask, the items open to them unless you deny it.");
  assert.equal(lines[1].sub, "Asked on 2026-10-04. It opens on 2026-10-07 unless you deny it.");
  assert.equal(lines[2].sub, "You denied their request on 2026-10-01. They may ask again, and wait again.");
  assert.equal(lines[3].sub, "Opened for them on 2026-09-01. Remove them to end it.");
  assert.deepEqual(lines.map((l) => l.canDeny), [false, true, false, false]);
  assert.equal(list[1].items, "Gmail, Bank");
  await src.emergencyAdd("Dana", "7d"); await src.emergencyDeny("Theo"); await src.emergencyRemove("Kit"); await src.emergencyRefresh();
  assert.deepEqual(b.seen.slice(1).map((s) => [s.tool, s.input]), [["vault.emergency.add", { person: "Dana", wait: "7d" }], ["vault.emergency.deny", { person: "Theo" }], ["vault.emergency.remove", { person: "Kit" }], ["vault.emergency.refresh", {}]]);
  assert.deepEqual(EMERGENCY_WAITS.map((w) => w[0]), ["1d", "3d", "7d", "14d", "30d"]);
});

test("health on the home: a count and the biggest reasons in one line, nothing when all is well, and 2fa hints are not counted as trouble", { skip: !strip }, async () => {
  const { healthSummary } = await import("./more-model.ts");
  const h = { checked: 5, counts: { weak: 1, reused: 2, "2fa-available": 3 }, items: [
    { name: "A", kind: "login", reasons: ["weak", "reused"], group: "g" }, { name: "B", kind: "login", reasons: ["reused"], group: "g" }, { name: "C", kind: "login", reasons: ["2fa-available"], group: "" }] };
  assert.deepEqual(healthSummary(h), { total: 2, line: "2 items need attention: 1 weak, 2 reused." });
  assert.deepEqual(healthSummary({ checked: 3, counts: {}, items: [] }), { total: 0, line: "" });
  assert.equal(healthSummary({ checked: 1, counts: { old: 1 }, items: [{ name: "Z", kind: "login", reasons: ["old"], group: "" }] }).line, "1 item needs attention: 1 old.");
});
