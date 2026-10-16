// @ts-check
// Server takeover + resume-lent for Codex and Grok: takeOver on the lent home runs the same loader as Claude, using each provider's session file in the checkpoint manifest.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { coverOf } from "./sync.js";
import { createResumeLent } from "./resume-lent.js";
import { rig, SPACE, BOB } from "./testing/lent-rig.js";

const HOME = Object.freeze({ space: SPACE, hops: [] });
const NATIVE = "7c1f0a52-0000-4000-8000-000000000002";
const SESSION = "ses_provider_fail";
const CHAT = "chat_00000000-0000-4000-8000-0000000000b2";
const line = (/** @type {number} */ n) => JSON.stringify({ type: "stream", n });

/**
 * @param {import("node:test").TestContext} t
 * @param {"codex"|"grok"} provider
 */
async function seededHome(t, provider) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, `lfp-${provider}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwdDir = path.join(dir, "w");
  fs.mkdirSync(cwdDir, { recursive: true });
  const cwd = provider === "grok" ? "/w" : cwdDir;
  /** @type {string} */ let file;
  /** @type {string} */ let root;
  /** @type {string} */ let remoteRel;
  /** @type {string} */ let body;
  if (provider === "codex") {
    body = "{\"type\":\"session\",\"provider\":\"codex\"}\n{\"type\":\"user\",\"content\":\"failover\"}\n";
    root = path.join(dir, "server", ".codex", "sessions");
    const d = new Date();
    const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
    const day = path.join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()));
    file = path.join(root, day, `rollout-fixture-${NATIVE}.jsonl`);
    remoteRel = `agent/codex/sessions/${day}/rollout-fixture-${NATIVE}.jsonl`;
  } else {
    body = "{\"role\":\"user\",\"content\":\"grok failover\"}\n";
    root = path.join(dir, "server", ".grok", "sessions");
    file = path.join(root, encodeURIComponent(cwd), NATIVE, "vyre-resume.jsonl");
    remoteRel = `agent/grok/sessions/${encodeURIComponent(cwd)}/${NATIVE}/vyre-resume.jsonl`;
  }
  const ownPort = { getCheckpoint: async () => null, putCheckpoint: async () => ({ ok: true }) };
  const resumeLent = createResumeLent({
    target: async thread => ((thread === CHAT || thread === SESSION) ? { file, root, native: NATIVE, cwd, provider } : null),
    port: () => ownPort,
  });
  const r = await rig(t, { keyIsDevice: true, resume: i => resumeLent(i) });
  r.home.book.lend({ session: SESSION, chat: CHAT, person: BOB, device: "dev_laptop", key: "KEY" });
  const whole = 3;
  const entries = [1, 2, 3].map(n => ({ seq: n, line: line(n) }));
  await r.home.store.appendTranscript(HOME, SESSION, entries);
  const bytes = Buffer.from(body);
  const put = await r.home.store.putFile(HOME, SESSION, remoteRel, bytes);
  const manifest = { [remoteRel]: { hash: crypto.createHash("sha256").update(body).digest("hex"), version: put.version, len: bytes.length } };
  await r.home.store.putCheckpoint(HOME, SESSION, { turn: 1, seq: whole, manifest, state: { cover: coverOf(manifest, entries, whole, 1) } });
  return { r, file, body };
}

test("Codex: takeOver runs resume-lent and places the rollout file on the server", { timeout: 60_000 }, async t => {
  const { r, file, body } = await seededHome(t, "codex");
  const out = await r.home.takeOver(SESSION, "you");
  assert.equal(out.changed, true);
  await r.home.sweep();
  assert.equal(r.home.book.get(SESSION).where, "server");
  assert.equal(fs.readFileSync(file, "utf8"), body);
});

test("Grok: takeOver runs resume-lent and places vyre-resume.jsonl on the server", { timeout: 60_000 }, async t => {
  const { r, file, body } = await seededHome(t, "grok");
  const out = await r.home.takeOver(SESSION, "you");
  assert.equal(out.changed, true);
  await r.home.sweep();
  assert.equal(r.home.book.get(SESSION).where, "server");
  assert.equal(fs.readFileSync(file, "utf8"), body);
});
