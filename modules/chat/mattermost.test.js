// @ts-check
// The Mattermost client: the token comes from a thunk per call and never reaches an error.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { client } from "./mattermost.js";
import { fakeMattermost } from "./testing/fake-mattermost.js";

test("mattermost: calls carry the bearer from getToken, a missing channel is null, and errors never hold the token", async t => {
  const token = `fixture-bot-${crypto.randomBytes(12).toString("hex")}`;
  const mm = await fakeMattermost({ token });
  t.after(() => mm.close());
  let fetched = 0;
  const c = client({ base: mm.base, getToken: async () => { fetched++; return token; } });
  assert.equal((await c.me()).id, mm.bot.id);
  const team = await c.team("vyre");
  assert.equal(await c.channelByName(team.id, "harlow-legal"), null);
  const ch = await c.createChannel({ team_id: team.id, name: "harlow-legal", display_name: "Harlow Legal" });
  const p = await c.post({ channel_id: ch.id, message: "hello" });
  assert.deepEqual((await c.postsSince(ch.id, 0)).map(x => x.id), [p.id]);
  assert.equal(fetched, 6, "the token is fetched for every call, never kept");
  assert.ok(mm.calls.every(x => x.authed));

  const bad = client({ base: mm.base, getToken: async () => token + "-wrong" });
  await assert.rejects(bad.me(), e => /Mattermost 401 on GET \/users\/me/.test(e.message) && !e.message.includes(token));
  await assert.rejects(client({ base: mm.base, getToken: async () => "" }).me(), /chat-bot-token/);
  assert.throws(() => client({ base: mm.base, getToken: /** @type {any} */ (token) }), /getToken, not a token/);
});
