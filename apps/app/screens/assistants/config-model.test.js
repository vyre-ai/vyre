// @ts-check
// The agent page's four parts (instructions, context, models, where it is used): the pure half, then the source over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o[tool]) return typeof o[tool] === "function" ? o[tool](input) : o[tool];
    return { data: {} };
  };
  return { call, seen };
}

const accounts = [
  { id: "acc_1", provider: "claude", label: "Claude (Alex)", kind: "login", signed_in_at: 1, is_default: true },
  { id: "acc_2", provider: "claude", label: "Team key", kind: "api-key", vault_item: "anthropic-api-key" },
  { id: "acc_3", provider: "openrouter", label: "OpenRouter", kind: "api-key" },
];

test("models: the fallback plan reads in order, with the kind of each sign-in said", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  const steps = m.stepsOf({ entries: [{ provider: "claude", account: "acc_1" }, { provider: "claude", account: "acc_2" }] }, accounts);
  assert.deepEqual(steps.map((s) => [s.account, s.kind, s.title]), [["acc_1", "login", "Claude (Alex)"], ["acc_2", "api-key", "Team key"]]);
  assert.match(steps[1].sub, /API token/);
  assert.deepEqual(m.stepsOf(undefined, accounts), []);
  assert.equal(m.stepsOf({ entries: [{ provider: "claude", account: "gone" }] }, accounts)[0].missing, true, "an account that was removed shows, marked, so it can be taken off");
});

test("models: moving, removing and adding keep the order and never double an account", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  const e = [{ provider: "claude", account: "a" }, { provider: "claude", account: "b" }, { provider: "openrouter", account: "c" }];
  assert.deepEqual(m.move(e, 2, -1).map((x) => x.account), ["a", "c", "b"]);
  assert.deepEqual(m.move(e, 0, -1), e, "the first cannot go up");
  assert.deepEqual(m.move(e, 2, 1), e, "the last cannot go down");
  assert.deepEqual(m.drop(e, 1).map((x) => x.account), ["a", "c"]);
  assert.deepEqual(m.add(e, { provider: "claude", account: "b" }), e, "already on the plan");
  assert.equal(m.add(e, { provider: "grok", account: "d" }).length, 4);
});

test("models: two accounts on one provider need the person's yes before it saves", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  const one = [{ provider: "claude", account: "a" }, { provider: "openrouter", account: "c" }];
  assert.equal(m.needsAck(one), false);
  assert.equal(m.needsAck([...one, { provider: "claude", account: "b" }]), true);
  assert.match(m.ACK_WORDS, /vendor|provider/i);
});

test("models: what can still be added is every account not on the plan", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  const left = m.addable([{ provider: "claude", account: "acc_1" }], accounts);
  assert.deepEqual(left.map((a) => a.id), ["acc_2", "acc_3"]);
});

test("context: sizes and dates read plainly; a link shows its folder name", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  assert.equal(m.sizeLine(0), "Empty");
  assert.equal(m.sizeLine(900), "900 bytes");
  assert.equal(m.sizeLine(2048), "2 KB");
  assert.equal(m.sizeLine(5 * 1024 * 1024), "5 MB");
  assert.deepEqual(m.linkLine("/Users/alex/Vyre/Files/Intake forms"), { title: "Intake forms", sub: "/Users/alex/Vyre/Files/Intake forms" });
  assert.equal(m.contextName("../../etc/passwd"), "passwd", "an uploaded name is only a name");
  assert.equal(m.contextName("  "), "");
});

test("used: chats and flows become rows; none says so in words", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  const rows = m.usedRows({ chats: [{ id: "t1", title: "Intake: Priya Shah" }], flows: [{ id: "f1", name: "New client intake", role: "teammate:intake" }] }, "intake");
  assert.deepEqual(rows.map((r) => [r.kind, r.title]), [["chat", "Intake: Priya Shah"], ["flow", "New client intake"]]);
  assert.equal(m.usedRows({}, "intake").length, 0);
  assert.match(m.NOT_USED("intake"), /intake/);
});

test("docs: the two files are named as the person knows them", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  assert.deepEqual(m.DOCS.map((d) => d[0]), ["AGENTS.md", "CLAUDE.md"]);
  assert.equal(m.docInput("rex", "CLAUDE.md", "  hi \n").file, "CLAUDE.md");
  assert.equal(m.docInput("rex", "CLAUDE.md", "  hi \n").text, "hi\n");
});

test("source: each part calls the one tool for it, and the plan saves as entries", { skip: !strip }, async () => {
  const { configSource } = await import("./config-source.ts");
  const b = box({ "sessions.routes.get": { data: { entries: [{ provider: "claude", account: "acc_1" }] } }, "sessions.accounts.list": { data: accounts } });
  const s = configSource(b.call);
  const dd = await s.docs("rex"); assert.deepEqual(dd.files, { "AGENTS.md": "", "CLAUDE.md": "" });
  await s.saveDoc("rex", "CLAUDE.md", "hi");
  await s.context("rex");
  await s.addContext("rex", "brief.pdf", "QUJD");
  await s.removeContext("rex", "brief.pdf");
  await s.link("rex", "/Files/Intake");
  await s.unlink("rex", "/Files/Intake");
  const plan = await s.plan("rex");
  assert.equal(plan.steps.length, 1);
  await s.savePlan("rex", [{ provider: "claude", account: "acc_1" }, { provider: "claude", account: "acc_2" }], true);
  await s.used("rex");
  assert.deepEqual(b.seen.map((x) => x.tool), ["agents.docs.get", "agents.docs.set", "agents.context.list", "agents.context.add", "agents.context.remove", "agents.context.link", "agents.context.unlink", "sessions.routes.get", "sessions.accounts.list", "sessions.routes.set", "agents.used"]);
  assert.deepEqual(b.seen[9].input, { scope: "agent:rex", entries: [{ provider: "claude", account: "acc_1" }, { provider: "claude", account: "acc_2" }], acknowledge: true });
});

test("source: a refusal from the box reaches the screen in the box's own words", { skip: !strip }, async () => {
  const { configSource } = await import("./config-source.ts");
  const b = box({ "agents.docs.set": { error: { code: "denied", message: "only the owner changes it" } } });
  await assert.rejects(() => configSource(b.call).saveDoc("rex", "AGENTS.md", "x"), /only the owner/);
});

test("models: a row dragged to a place lands there and the others close up; a drop out of range changes nothing", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  const e = [{ provider: "a" }, { provider: "b" }, { provider: "c" }];
  assert.deepEqual(m.moveTo(e, 0, 2).map((x) => x.provider), ["b", "c", "a"]);
  assert.deepEqual(m.moveTo(e, 2, 0).map((x) => x.provider), ["c", "a", "b"]);
  assert.deepEqual(m.moveTo(e, 1, 1), e);
  assert.deepEqual(m.moveTo(e, 0, 9), e);
  assert.equal(m.kindLine({ kind: "api-key" }), "API token");
  assert.equal(m.kindLine(undefined), "Not available");
});

test("source: a login is lent through the vault's own grant for 30 days, listed live, and taken back by its id", { skip: !strip }, async () => {
  const { configSource } = await import("./config-source.ts");
  const b = box({ "vault.agent.grants": { data: { grants: [{ id: "ag_1", item: "mail", origin: "https://m.test", status: "active", expires: 5 }, { id: "ag_2", item: "x", origin: "https://x.test", status: "revoked" }] } } });
  const s = configSource(b.call);
  assert.deepEqual((await s.lent("rex")).map((g) => g.id), ["ag_1"], "a revoked one is not shown");
  await s.lend("rex", "mail", "https://m.test");
  await s.takeBack("ag_1");
  assert.deepEqual(b.seen.slice(1).map((x) => [x.tool, x.input]), [["vault.agent.grant", { agent: "rex", item: "mail", origin: "https://m.test", expires: "30d" }], ["vault.agent.revoke", { id: "ag_1" }]]);
});

test("sharing: a row names a person or a role in plain words; the source reads and writes through the two tools", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  assert.deepEqual(m.accessRow({ kind: "person", subject: "p1", level: "use" }, [{ id: "p1", name: "Dana Reyes", role: "member" }], []), { title: "Dana Reyes", sub: "Person, member" });
  assert.deepEqual(m.accessRow({ kind: "role", subject: "paralegal", level: "edit" }, [], [{ id: "paralegal", name: "Paralegals" }]), { title: "Paralegals", sub: "Everyone with this role" });
  assert.deepEqual(m.LEVELS.map((l) => l[1]), ["Can use", "Can edit"]);
  const { configSource } = await import("./config-source.ts");
  const b = box({ "agents.access.get": { data: { access: [{ kind: "person", subject: "p1", level: "use", by: null }], people: [], roles: [] } } });
  const s = configSource(b.call);
  assert.equal((await s.access("rex")).access.length, 1);
  await s.setAccess("rex", "role", "paralegal", "edit");
  await s.setAccess("rex", "role", "paralegal", null);
  assert.deepEqual(b.seen.slice(1).map((x) => x.input.level), ["edit", null]);
});

test("authorship and work: who made it is said, and a non-admin author is marked; open tasks become rows", { skip: !strip }, async () => {
  const m = await import("./config-model.ts");
  assert.equal(m.authorLine({ name: "Ben", staff: false }, { name: "Ben" }), "Made by Ben (not an admin).");
  assert.equal(m.authorLine({ name: "Sam", staff: true }, { name: "Ben" }), "Made by Sam. Instructions last changed by Ben.");
  assert.equal(m.authorLine(null, null), "");
  const rows = m.workRows({ todo: [{ id: "t1", title: "Draft", state: "working" }], approve: [{ id: "t2", title: "Check", state: "needs_check" }] });
  assert.deepEqual(rows.map((r) => [r.kind, r.sub]), [["todo", "Working on it"], ["approve", "Waiting for it to approve"]]);
  assert.match(m.NO_WORK("rex"), /rex/);
});
