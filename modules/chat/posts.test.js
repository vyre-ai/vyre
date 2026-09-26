// @ts-check
// What Chat puts in Mattermost: every button carries its id and the hook secret, held drafts
// show where they go before what they say, and a resolved post loses its buttons.

import { test } from "node:test";
import assert from "node:assert/strict";
import { askPost, heldPost, heldPatch, resolvedPatch, textPost, MAX_POST } from "./posts.js";
import { channelName, same } from "./bridge.js";

const h = { hook: "http://vyred:8766", secret: "s3cr3t-hook" };
const actions = p => p.props.attachments.flatMap(a => a.actions);

test("posts: a question has Allow and Deny, each carrying its ask id, action and the secret", () => {
  const p = askPost({ ask: "a1b2c3", tool: "Bash", summary: "git push origin q3-report", destination: "origin" }, { channel: "c1", root: "r1", ...h });
  assert.equal(p.channel_id, "c1");
  assert.equal(p.root_id, "r1");
  assert.match(p.message, /git push origin q3-report/);
  assert.match(p.message, /Going to: origin/);
  const a = actions(p);
  assert.deepEqual(a.map(x => x.id), ["allow", "deny"]);
  for (const x of a) {
    assert.equal(x.integration.url, "http://vyred:8766/chat/action");
    assert.deepEqual(x.integration.context, { kind: "ask", id: "a1b2c3", action: x.id, s: "s3cr3t-hook" });
  }
});

test("posts: a held email shows the destination, then the words Send will send, with Send and Discard and no Edit", () => {
  const item = { id: "g1", kind: "send", via: "mail", to: ["dana@harlowlegal.com"], summary: "Re: Intake form rebuild", agent: "juno" };
  const draft = { subject: "Re: Intake form rebuild", body: "Hi Dana,\nThe new intake form is on staging.\nAlex" };
  const p = heldPost(item, draft, { channel: "c1", root: null, ...h });
  assert.equal(p.root_id, undefined);
  const to = p.message.indexOf("To: dana@harlowlegal.com");
  const words = p.message.indexOf("> The new intake form is on staging.");
  assert.ok(to > 0 && words > to, "where it goes comes before what it says");
  assert.match(p.message, /Send sends exactly what is shown here/);
  assert.match(p.message, /\/vyre body g1 <new text>/);
  assert.match(p.message, /\/vyre subject g1 <text>/);
  assert.deepEqual(actions(p).map(x => x.id), ["send", "discard"], "no Deck address, no Deck link");
  assert.ok(actions(p).every(x => x.integration.context.kind === "gate" && x.integration.context.id === "g1"));
});

test("posts: with the Deck's address, Edit in Deck is a link to the held item that still carries its id", () => {
  const item = { id: "g1", kind: "send", via: "mail", to: "dana@harlowlegal.com" };
  const p = heldPost(item, { body: "Hi Dana" }, { channel: "c1", ...h, deck: "https://alex.vyre.run/" });
  const deck = actions(p).find(x => x.id === "deck");
  assert.equal(deck.name, "Edit in Deck");
  assert.equal(deck.integration.url, "https://alex.vyre.run/now/held/g1");
  assert.equal(deck.integration.context.id, "g1");
  assert.equal(deck.integration.context.s, undefined, "a link never carries the hook secret");
});

test("posts: a revision's patch shows the new words and keeps the buttons", () => {
  const item = { id: "g1", kind: "send", via: "mail", to: "dana@harlowlegal.com" };
  const r = heldPatch(item, { body: "Hi Dana, Thursday at 3?" }, h);
  assert.match(r.message, /> Hi Dana, Thursday at 3\?/);
  assert.deepEqual(r.props.attachments[0].actions.map(x => x.id), ["send", "discard"]);
});

test("posts: a resolved post keeps its words and loses every button", () => {
  const r = resolvedPatch("May I run git push", "Allowed from Chat.");
  assert.equal(r.message, "May I run git push");
  assert.deepEqual(r.props.attachments[0].actions, []);
  assert.equal(r.props.attachments[0].text, "Allowed from Chat.");
});

test("posts: long text is cut to what Mattermost accepts", () => {
  const p = textPost({ channel: "c1", message: "x".repeat(20000) });
  assert.ok(p.message.length <= MAX_POST);
});

test("posts: channel names and the constant-time compare", () => {
  assert.equal(channelName("Harlow Legal"), "harlow-legal");
  assert.equal(channelName("northfield-dental"), "northfield-dental");
  assert.equal(channelName("Q"), "project-q");
  assert.ok(same("abc", "abc"));
  assert.ok(!same("abc", "abd"));
  assert.ok(!same("", ""));
  assert.ok(!same(undefined, "abc"));
});
