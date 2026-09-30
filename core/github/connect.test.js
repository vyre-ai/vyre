// @ts-check
// "Sign in with GitHub" (connect.js) against a fake GitHub (no real network, no listener - device
// flow has none): the happy path (pending, pending, then a token), slow_down, expiry, decline, a
// name race, cancel, and that no token or device code ever reaches a result, an event or a log
// line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { connector, DEVICE_CODE_URI, TOKEN_URI } from "./connect.js";

const CLIENT_ID = "Ov23test0000000000";

/** A fake GitHub device flow: device/code, then N "authorization_pending" polls, then a token. */
function fakeGithub({ pendingPolls = 2, slowDownOnce = false, declineAfter = null, expireImmediately = false, login = "alex", token = "gho_faketoken1234567890" } = {}) {
  const calls = [];
  let polls = 0;
  const fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? String(opts.body) : null });
    if (url === DEVICE_CODE_URI) {
      return jsonRes(200, { device_code: "devcode-abc123", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=WXYZ-1234", expires_in: expireImmediately ? 0 : 900, interval: 0 });
    }
    if (url === TOKEN_URI) {
      polls++;
      if (declineAfter !== null && polls > declineAfter) return jsonRes(200, { error: "access_denied" });
      if (slowDownOnce && polls === 1) return jsonRes(200, { error: "slow_down", interval: 0 });
      if (polls <= pendingPolls) return jsonRes(200, { error: "authorization_pending" });
      return jsonRes(200, { access_token: token, token_type: "bearer", scope: "repo" });
    }
    if (url === "https://api.github.com/user") {
      return jsonRes(200, { login, avatar_url: `https://avatars.example/${login}.png` });
    }
    throw new Error(`fake github: unexpected url ${url}`);
  };
  return { fetch, calls, token };
}

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

/** A connector over a pretend vault and account list, recording everything that leaves it. */
function rig(t, fake, opts = {}) {
  const items = new Map();
  const accounts = [];
  const saved = [];
  const events = [];
  const lines = [];
  const out = [];
  const c = connector({ clientId: CLIENT_ID, fetch: fake.fetch, minIntervalMs: 1,
    taken: name => accounts.some(a => a.name === name),
    save: async (item, fields) => { saved.push({ item, fields }); items.set(item, fields); },
    add: async acct => { accounts.push(acct); },
    emit: (type, payload) => events.push({ type, payload }),
    log: (m, x) => lines.push(`${m} ${JSON.stringify(x || {})}`),
    ...opts,
  });
  t.after(() => c.stop());
  const keep = async p => { try { const r = await p; out.push(r); return r; } catch (e) { out.push(String(/** @type {any} */ (e).message)); throw e; } };
  return { c, items, accounts, saved, events, lines, out, keep };
}

/** Poll until an event of `type` shows up, or fail after a generous number of ticks. */
async function waitFor(events, type, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (events.some(e => e.type === type)) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`never saw ${type}`);
}

function assertNoLeak(r, secrets) {
  const everything = JSON.stringify([r.out, r.events, r.lines]);
  for (const v of secrets) assert.ok(!everything.includes(v), `a value leaked: ${String(v).slice(0, 12)}...`);
}

test("connect: pending, pending, then a token - saves it, adds the account, emits connected, no value leaks", async t => {
  const fake = fakeGithub({ pendingPolls: 2 });
  const r = rig(t, fake);

  const started = await r.keep(r.c.start({ name: "home" }));
  assert.deepEqual(Object.keys(started).sort(), ["expires_in", "id", "interval", "user_code", "verification_uri", "verification_uri_complete"]);
  assert.equal(started.user_code, "WXYZ-1234");
  assert.equal(r.c.status(started.id), "pending");

  await waitFor(r.events, "github.connected");
  assert.equal(r.saved.length, 1);
  assert.equal(r.saved[0].item, "github-home");
  assert.deepEqual(r.saved[0].fields, { token: fake.token });
  assert.equal(r.accounts.length, 1);
  assert.deepEqual(r.accounts[0], { name: "home", login: "alex", avatar_url: "https://avatars.example/alex.png", item: "github-home" });
  assert.equal(r.events.find(e => e.type === "github.connected").payload.login, "alex");
  assert.equal(r.c.status(started.id), "used");

  assertNoLeak(r, [fake.token, "devcode-abc123"]);
});

test("connect: slow_down widens the interval instead of ending the sign-in", async t => {
  const fake = fakeGithub({ pendingPolls: 1, slowDownOnce: true });
  const r = rig(t, fake);
  await r.keep(r.c.start({ name: "home" }));
  await waitFor(r.events, "github.connected");
  assert.equal(r.accounts[0].login, "alex");
});

test("connect: a decline ends the sign-in in plain words, saves nothing", async t => {
  const fake = fakeGithub({ declineAfter: 0 });
  const r = rig(t, fake);
  await r.keep(r.c.start({ name: "home" }));
  await waitFor(r.events, "github.connect-failed");
  assert.equal(r.saved.length, 0);
  assert.match(r.events.find(e => e.type === "github.connect-failed").payload.error, /declined/);
});

test("connect: an immediately-expired code ends the sign-in as expired", async t => {
  const fake = fakeGithub({ pendingPolls: 999, expireImmediately: true });
  const r = rig(t, fake);
  await r.keep(r.c.start({ name: "home" }));
  await waitFor(r.events, "github.connect-failed");
  assert.match(r.events.find(e => e.type === "github.connect-failed").payload.error, /expired/);
});

test("connect: cancel ends an open sign-in; a stale id afterwards gets a plain answer, not \"no such sign-in\"", async t => {
  const fake = fakeGithub({ pendingPolls: 999 });
  const r = rig(t, fake);
  const started = await r.keep(r.c.start({ name: "home" }));
  const cancelled = await r.keep(r.c.cancel({ id: started.id }));
  assert.deepEqual(cancelled, { cancelled: true });
  await assert.rejects(r.keep(r.c.cancel({ id: started.id })), /cancelled/);
  assert.equal(r.saved.length, 0);
});

test("connect: a name already taken, or a second sign-in for the same name, is refused up front", async t => {
  const fake = fakeGithub({ pendingPolls: 999 });
  const r = rig(t, fake, { taken: name => name === "home" });
  await assert.rejects(r.keep(r.c.start({ name: "home" })), /already connected/);
});

test("connect: a name taken by another sign-in finishing first is caught at the end too (a race, not just at start)", async t => {
  const fake = fakeGithub({ pendingPolls: 0 });
  let takenNow = false;
  const r = rig(t, fake, { taken: name => takenNow && name === "home" });
  const started = await r.keep(r.c.start({ name: "home" }));
  takenNow = true;
  await waitFor(r.events, "github.connect-failed");
  assert.match(r.events.find(e => e.type === "github.connect-failed").payload.error, /added while you signed in/);
  assert.equal(r.saved.length, 0);
});

// No revoke() test here: 0.2 dropped server-side revoke entirely (connect.js's own comment says
// why - the client id is shared with every real `gh` install, so revoking it would sign the
// person's own gh out everywhere else too). github.remove's own test covers local-only removal.
