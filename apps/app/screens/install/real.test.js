import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { identityFrom, nameAnswerChecked, nameStatusReal, nameNoteReal, createInput, createdFrom, setupFrom, savesAt, setupElsewhere, applyClaim, inviteFrom } from "./real.js";

// Shapes captured from a real kernel-on vyred (spaces.identity.status, spaces.list, spaces.setup.*).
const STATUS = { exists: true, name: "devbox.vyre.run", label: "devbox", id: "per_pbiglgp6ji6jzrnbskpuzw77np", eid: "e", keyId: "e", pending: false, seq: 0, store: "file" };

test("identity: a claimed name is read, none is null", () => {
  assert.deepEqual(identityFrom(STATUS), { id: "per_pbiglgp6ji6jzrnbskpuzw77np", label: "devbox", address: "devbox.vyre.run" });
  assert.equal(identityFrom({ exists: false, name: null }), null);
  assert.equal(identityFrom(null), null);
});

test("a name that resolves is taken, not_found is free, an outage is unknown", () => {
  assert.equal(nameAnswerChecked(200, { data: { status: "taken" } }), "taken");
  assert.equal(nameAnswerChecked(200, { data: { status: "ok" } }), "free");
  assert.equal(nameAnswerChecked(0, null), "unknown");
});

test("name status follows the directory, and a free 'alex' is ok", () => {
  assert.equal(nameStatusReal("", null).state, "empty");
  assert.equal(nameStatusReal("al", null).state, "short");
  assert.equal(nameStatusReal("alex", null).state, "checking");
  assert.equal(nameStatusReal("alex", "free").state, "ok");
  assert.equal(nameStatusReal("alex", "taken").state, "taken");
  assert.equal(nameStatusReal("alex", "unknown").state, "unknown");
  assert.equal(nameStatusReal("Jane", "free", ["jane"]).state, "taken");
  assert.equal(nameNoteReal(nameStatusReal("juniper", "taken"), true), "juniper.vyre.run is taken. People and spaces share names.");
  assert.equal(nameNoteReal(nameStatusReal("northwind", "free"), false), "northwind.vyre.run is yours to take.");
});

test("create input: here confirms this computer, a server names its kind", () => {
  assert.deepEqual(createInput({ slug: "northwind", name: "Northwind Bakery", where: "here" }), { name: "northwind", displayName: "Northwind Bakery", home: { kind: "this-computer", confirmed: true } });
  assert.deepEqual(createInput({ slug: "northwind", name: "N", where: "server" }).home, { kind: "server" });
});

test("a created space is done, running or failed", () => {
  assert.deepEqual(createdFrom({ spaceId: "spc_1", status: "done", name: "juniperdev", domain: "juniperdev.vyre.run" }), { state: "done", id: "spc_1", address: "juniperdev.vyre.run", say: "" });
  assert.equal(createdFrom({ spaceId: "spc_1", status: "running" }).state, "running");
  assert.equal(createdFrom({ spaceId: "spc_1", status: "failed", message: "No." }).say, "No.");
});

test("what is saved is the shape the box keeps and nothing else", () => {
  const s = setupFrom({ step: "look", name: "Northwind Bakery", addr: "northwind", look: "sky", where: "here", connectors: ["gmail"], kit: null });
  assert.deepEqual(s, { step: "look", name: "Northwind Bakery", address: "northwind", look: "sky", where: "here", picks: { connectors: ["gmail"], kit: null } });
  assert.deepEqual(Object.keys(s).sort(), ["address", "look", "name", "picks", "step", "where"]);
  assert.ok(savesAt("kit") && !savesAt("done") && !savesAt("where"));
});

test("setup elsewhere lists other devices' unfinished setups, not this one's", () => {
  const list = [
    { id: "spc_a", displayName: "Juniper Studio", label: "juniperdev", setup: null },
    { id: "spc_b", displayName: "Northwind Bakery", label: "northwind", setup: { step: "members", device: { id: "k", name: "iPhone" }, picks: { connectors: [], kit: null } } },
    { id: "spc_c", label: "mine", setup: { step: "look", device: { id: "z", name: "MacBook" } } },
  ];
  assert.deepEqual(setupElsewhere(list, "spc_c").map((x) => [x.space, x.spaceName, x.device]), [["spc_b", "Northwind Bakery", "iPhone"]]);
  assert.equal(setupElsewhere(list, null).length, 2);
  assert.deepEqual(setupElsewhere(undefined, null), []);
});

test("a claim puts the saved state back on the screen", () => {
  const a = applyClaim({ space: "spc_b", moved: true, setup: { step: "members", name: "Northwind Bakery", address: "northwind.vyre.run", look: "sky", where: "vps", picks: { connectors: ["gmail"], kit: "estate" } } });
  assert.deepEqual(a, { space: "spc_b", step: "members", name: "Northwind Bakery", addr: "northwind", look: "sky", where: "vps", connectors: ["gmail"], kit: "estate", who: "team" });
  assert.equal(applyClaim({ space: "x", setup: null }), null);
});

test("an invite card reads the space, the role and the sender", () => {
  const c = inviteFrom({ id: "inv_1", role: "member", status: "pending", space: { id: "spc_1", label: "juniper" } }, "juniper.vyre.run/join/x");
  assert.deepEqual([c.space, c.address, c.role, c.status], ["juniper", "juniper.vyre.run", "Member", "pending"]);
});

test("the real invite card: the display name, the address, the role label, what is seen and the check words", () => {
  const real = { space: "juniperdev.vyre.run", label: "Juniper Studio", role: "member", role_label: "Member", sees: { scope: [], expires: null }, valid_until: 1791678820968, fingerprint: "5d57", button: "Join Juniper Studio", fingerprint_words: "front ribbon army more" };
  const c = inviteFrom(real, "https://juniperdev.vyre.run/join/t");
  assert.deepEqual([c.space, c.address, c.role, c.words, c.from], ["Juniper Studio", "juniperdev.vyre.run", "Member", "front ribbon army more", ""]);
  assert.match(c.sees, /Member role/);
  const t = inviteFrom({ ...real, role: "temp", role_label: "Temp", sees: { scope: ["Doe estate plan"], expires: Date.UTC(2026, 9, 14) } }, "l");
  assert.equal(t.sees, "Doe estate plan, until 2026-10-14");
});

test("the directory's check: ok is free, taken and reserved are not, a limit or garbage is unknown (people, spaces and names an older setup gave a server are one namespace)", () => {
  assert.equal(nameAnswerChecked(200, { data: { name: "devbox", status: "taken", why: "someone else has that name" } }), "taken");
  assert.equal(nameAnswerChecked(200, { data: { name: "devbox", status: "reserved" } }), "taken");
  assert.equal(nameAnswerChecked(200, { data: { name: "devbox", status: "ok" } }), "free");
  assert.equal(nameAnswerChecked(200, { data: { name: "devbox", status: "mine" } }), "free");
  assert.equal(nameAnswerChecked(429, { error: { code: "rate_limited" } }), "unknown");
  assert.equal(nameAnswerChecked(200, null), "unknown");
  assert.equal(nameAnswerChecked(500, undefined), "unknown");
});

test("the done page says what is still pending: a Kit waiting in Now, a Kit not asked for, connectors never connected", async () => {
  const { pendingLines } = await import("./real.js");
  const kit = { id: "estate-planning", label: "Estate planning" };
  assert.deepEqual(pendingLines({ kit, kitResult: { ok: true, text: "waiting" }, connectors: ["Gmail", "Stripe"] }), ["Estate planning is waiting for your yes in Now. Nothing is installed until you approve it.", "Not connected yet: Gmail, Stripe. Each one asks for its own sign-in when you set it up."]);
  assert.match(pendingLines({ kit, kitResult: { ok: false, text: "no_such_tool" }, connectors: [] })[0], /was not asked for: no_such_tool. Install it later from Kits./);
  assert.deepEqual(pendingLines({ kit: null, kitResult: null, connectors: [] }), []);
});

test("a failed space says the box's own reason, from failed.reason", () => {
  assert.deepEqual(createdFrom({ spaceId: "spc_1", status: "failed", failed: { step: "claim", reason: "too many names claimed from this address today" } }), { state: "failed", id: "spc_1", address: "", say: "too many names claimed from this address today" });
  assert.equal(createdFrom({ status: "failed" }).say, "Setting up the space did not finish.");
});
