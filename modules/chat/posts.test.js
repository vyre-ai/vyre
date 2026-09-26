// @ts-check
// What Chat puts in Mattermost: every button carries its id and the hook secret, held drafts
// show where they go before what they say, and a resolved post loses its buttons.

import { test } from "node:test";
import assert from "node:assert/strict";
import { askPost, heldPost, editDialog, resolvedPatch, textPost, editable, MAX_POST } from "./posts.js";
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

test("posts: a held email shows the destination, then the words, with Send, Edit and Discard", () => {
  const item = { id: "g1", kind: "send", via: "mail", to: ["dana@harlowlegal.com"], summary: "Re: Intake form rebuild", agent: "juno" };
  const draft = { subject: "Re: Intake form rebuild", body: "Hi Dana,\nThe new intake form is on staging.\nAlex" };
  const p = heldPost(item, draft, { channel: "c1", root: null, ...h });
  assert.equal(p.root_id, undefined);
  const to = p.message.indexOf("To: dana@harlowlegal.com");
  const words = p.message.indexOf("> The new intake form is on staging.");
  assert.ok(to > 0 && words > to, "where it goes comes before what it says");
  assert.match(p.message, /Nothing goes out until you press Send/);
  assert.deepEqual(actions(p).map(x => x.id), ["send", "edit", "discard"]);
  assert.ok(actions(p).every(x => x.integration.context.kind === "gate" && x.integration.context.id === "g1"));
});

test("posts: the edit dialog is filled with the draft, body last, and its state carries id and secret", () => {
  const item = { id: "g1", to: "dana@harlowlegal.com" };
  const d = editDialog(item, { body: "Hi Dana", subject: "Re: Intake", method: "POST" }, h);
  assert.deepEqual(d.elements.map(e => e.name), ["to", "subject", "body"]);
  assert.equal(d.elements[0].default, "dana@harlowlegal.com");
  assert.equal(d.elements[2].type, "textarea");
  assert.equal(d.elements[2].default, "Hi Dana");
  assert.deepEqual(JSON.parse(d.state), { id: "g1", s: "s3cr3t-hook" });
  assert.equal(d.submit_label, "Send");
  assert.deepEqual(editable(null), []);
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
