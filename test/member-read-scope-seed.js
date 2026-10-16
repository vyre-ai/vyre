// @ts-check
// Plant owner / other-member markers across subsystems for member-read-scope.test.js.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { indexCorpusTranscripts, recallFts5Available } from "../core/sessions/testing/recall-live.js";

const skillBody = (/** @type {string} */ name, /** @type {string} */ marker) =>
  `---\nname: ${name}\ndescription: isolation probe ${marker}\n---\n${marker}\n`;

/**
 * @param {any} db switchboard store db
 * @param {string} threadId
 * @param {string} personId
 */
export function attributeThreadToPerson(db, threadId, personId) {
  const row = /** @type {any} */ (db.prepare("SELECT opts FROM threads_runs WHERE id = ?").get(String(threadId)));
  const o = row && row.opts ? JSON.parse(String(row.opts)) : {};
  o.person = String(personId);
  db.prepare("UPDATE threads_runs SET opts = ? WHERE id = ?").run(JSON.stringify(o), String(threadId));
}

/**
 * @param {any} d daemon
 * @param {any} meta session meta (token)
 * @param {string} name skill name
 * @param {string} marker text in body
 */
export async function seedPersonalSkill(d, meta, name, marker) {
  const draft = await d.registry.call("skills.draft", {
    name, level: "personal", kind: "skill", body: skillBody(name, marker),
  }, "cli", meta);
  assert.ok(draft.data?.version, `skills.draft ${name}: ${JSON.stringify(draft.error)}`);
  const ok = await d.registry.call("skills.approve", {
    name, level: "personal", version: draft.data.version,
  }, "cli", meta);
  assert.ok(!ok.error, `skills.approve ${name}: ${JSON.stringify(ok.error)}`);
}

/**
 * @param {any} d
 * @param {any} meta
 * @param {string} marker
 */
export async function seedMemoryFact(d, meta, marker) {
  const r = await d.registry.call("memory.correct", {
    action: "add", subject: "leak-probe", rel: "token", object: marker, wait: true,
  }, "cli", meta);
  assert.ok(!r.error, `memory.correct: ${JSON.stringify(r.error)}`);
}

/**
 * @param {any} d
 * @param {any} meta
 * @param {string} marker task title (kernel task rows are scoped per person)
 */
export async function seedTaskRecord(d, meta, marker) {
  const r = await d.registry.call("records.create", { type: "task", data: { title: marker } }, "cli", meta);
  assert.ok(!r.error && r.data, `records.create task: ${JSON.stringify(r.error)}`);
}

/**
 * @param {any} d
 * @param {any} ownerMeta
 * @param {string} work
 * @param {string} marker slug fragment
 */
export async function seedOwnerProject(d, ownerMeta, work, marker) {
  const home = path.join(work, `proj-${marker.slice(-12)}`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "README.md"), marker);
  const r = await d.registry.call("projects.create", { name: marker.slice(0, 48), home }, "cli", ownerMeta);
  assert.ok(!r.error, `projects.create: ${JSON.stringify(r.error)}`);
}

const MEMBER_VAULT_PW = "vyre-member-read-scope-vault-password-12345";

/** @param {any} d @param {any} meta */
export async function ensureMemberVaultUnlocked(d, meta) {
  const st = await d.registry.call("vault.me.account.status", {}, "cli", meta);
  if (st.data?.unlocked) return;
  let secretKey;
  const cr = await d.registry.call("vault.me.account.create", { password: MEMBER_VAULT_PW }, "cli", meta);
  if (cr.data?.secretKey) secretKey = cr.data.secretKey;
  else if (st.data?.account || (cr.error && cr.error.code !== "denied")) {
    const rs = await d.registry.call("vault.me.account.reset", { password: MEMBER_VAULT_PW }, "cli", meta);
    assert.ok(rs.data?.secretKey, `vault.me.account.reset: ${JSON.stringify(rs.error)}`);
    secretKey = rs.data.secretKey;
  } else {
    assert.fail(`vault.me.account.create: ${JSON.stringify(cr.error)}`);
  }
  const un = await d.registry.call("vault.me.account.unlock", { password: MEMBER_VAULT_PW, secretKey }, "cli", meta);
  assert.ok(un.data?.unlocked, `vault.me.account.unlock: ${JSON.stringify(un.error)}`);
}

/**
 * @param {any} d
 * @param {any} meta
 * @param {string} name vault item name
 */
export async function seedVaultMeName(d, meta, name) {
  await ensureMemberVaultUnlocked(d, meta);
  const r = await d.registry.call("vault.me.put", {
    name, kind: "secret", fields: { value: "seed" },
  }, "cli", meta);
  assert.ok(!r.error, `vault.me.put: ${JSON.stringify(r.error)}`);
}

/** @param {any} d owner vault.put */
export async function seedOwnerVaultName(d, ownerMeta, name) {
  const r = await d.registry.call("vault.put", {
    name, kind: "secret", fields: { value: "seed" },
  }, "cli", ownerMeta);
  assert.ok(!r.error, `vault.put: ${JSON.stringify(r.error)}`);
}

/**
 * @param {string} work
 * @param {string} marker
 */
export function seedOwnerFile(work, marker) {
  const p = path.join(work, `owner-file-${marker}.txt`);
  fs.writeFileSync(p, marker);
  return p;
}

/**
 * @param {any} d
 * @param {any} ownerMeta
 * @param {string} personId
 * @param {string} work
 * @param {string} marker prompt / recall text
 * @param {any} db
 */
export async function seedRecallSession(d, ownerMeta, personId, work, marker, db) {
  const { threadStartProviderFields } = await import("../core/sessions/testing/fake-agent-harness.js");
  const th = await d.registry.call("threads.start", {
    cwd: work, prompt: marker, surface: "cli", ...threadStartProviderFields("claude"),
  }, "cli", ownerMeta);
  assert.ok(th.data?.id, `threads.start recall seed: ${JSON.stringify(th.error)}`);
  if (personId) attributeThreadToPerson(db, th.data.id, personId);
  return th.data.id;
}

/**
 * @param {any} d
 */
export async function indexRecall(d) {
  if (!recallFts5Available()) return false;
  await indexCorpusTranscripts(d);
  return true;
}
