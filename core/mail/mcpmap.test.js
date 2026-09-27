// @ts-check
// Unit tests for mcpmap.js: how mail maps its verbs onto an MCP mail server's own tools (ADR 0016
// decision 8). Pure: tool lists and results are literals, nothing is started.

import { test } from "node:test";
import assert from "node:assert/strict";
import { guess, checkMap, sendArgs, messagesOf, messageOf } from "./mcpmap.js";

const s = { type: "string" };
const tool = (name, properties) => ({ tool: name, name: `srv__${name}`, input: { type: "object", properties } });

const GMAILISH = [
  tool("list_labels", {}),
  tool("draft_email", { to: s, subject: s, body: s }),
  tool("send_email", { to: s, cc: s, bcc: s, subject: s, body: s, in_reply_to: s }),
  tool("search_emails", { query: s, max_results: { type: "integer" } }),
  tool("get_email", { message_id: s }),
];

test("mcpmap: guess on a Gmail-like server", () => {
  assert.deepEqual(guess(GMAILISH), {
    send: { tool: "send_email", to: "to", subject: "subject", body: "body", to_list: false, cc: "cc", bcc: "bcc", in_reply_to: "in_reply_to" },
    search: { tool: "search_emails", q: "query", limit: "max_results" },
    read: { tool: "get_email", id: "message_id" },
  });
});

test("mcpmap: guess on a server whose send takes a recipients array", () => {
  const tools = [
    tool("gmail_send_message", { recipients: { type: "array", items: s }, subject: s, text: s, reply_to_message_id: s }),
    tool("gmail_find_messages", { q: s, limit: { type: "integer" } }),
    tool("gmail_read_message", { id: s }),
  ];
  assert.deepEqual(guess(tools), {
    send: { tool: "gmail_send_message", to: "recipients", subject: "subject", body: "text", to_list: true, in_reply_to: "reply_to_message_id" },
    search: { tool: "gmail_find_messages", q: "q", limit: "limit" },
    read: { tool: "gmail_read_message", id: "id" },
  });
});

test("mcpmap: guess prefers a mail-named send, and skips one missing an argument", () => {
  const tools = [
    tool("send_notification", { to: s, subject: s, body: s }),
    tool("send_mail_fast", { to: s, subject: s }),
    tool("send_email", { to: s, subject: s, body: s }),
  ];
  assert.equal(guess(tools).send.tool, "send_email");
});

test("mcpmap: guess on a server with no send tool, and on nonsense", () => {
  const tools = [tool("list_issues", {}), tool("search_messages", { query: s }), tool("create_issue", { title: s })];
  const map = guess(tools);
  assert.deepEqual(map, { search: { tool: "search_messages", q: "query" } });
  assert.match(String(checkMap(map)), /no tool on this server looks like it sends mail/);
  assert.deepEqual(guess([]), {});
  assert.deepEqual(guess(/** @type {any} */ (null)), {});
  assert.deepEqual(guess([{ tool: "send_email" }]), {}, "a tool with no input schema has no arguments");
});

test("mcpmap: checkMap", () => {
  const send = { tool: "send_email", to: "to", subject: "subject", body: "body" };
  assert.equal(checkMap({ send }), null);
  assert.equal(checkMap(guess(GMAILISH)), null);
  assert.match(String(checkMap(null)), /map must be/);
  assert.match(String(checkMap("send")), /map must be/);
  assert.match(String(checkMap({ send: "send_email" })), /map\.send must be an object/);
  assert.match(String(checkMap({ send: { ...send, body: undefined } })), /map\.send\.body must name/);
  assert.match(String(checkMap({ send: { ...send, tool: "send email; rm" } })), /map\.send\.tool must name/);
  assert.match(String(checkMap({ send: { ...send, cc: "c c" } })), /map\.send\.cc must name an argument/);
  assert.match(String(checkMap({ send, search: { tool: "search_emails" } })), /map\.search\.q must name/);
  assert.match(String(checkMap({ send, search: { tool: "search_emails", q: "query", limit: 10 } })), /map\.search\.limit must name an argument/);
  assert.match(String(checkMap({ send, read: { tool: "get_email" } })), /map\.read\.id must name/);
  assert.match(String(checkMap({ search: { tool: "search_emails", q: "query" } })), /no tool on this server looks like it sends mail/);
});

test("mcpmap: sendArgs", () => {
  const list = { tool: "gmail_send_message", to: "recipients", subject: "subject", body: "text", to_list: true, cc: "cc", in_reply_to: "reply_to_message_id" };
  const c = { subject: "Oven rota", body: "The rota is ready.", cc: ["kit@harlow.example"], in_reply_to: "<m1@mail.example>" };
  assert.deepEqual(sendArgs(list, ["dana@northwind-bakery.example", "alex@harlow.example"], c), {
    recipients: ["dana@northwind-bakery.example", "alex@harlow.example"], subject: "Oven rota", text: "The rota is ready.",
    cc: ["kit@harlow.example"], reply_to_message_id: "<m1@mail.example>",
  });
  const comma = { tool: "send_email", to: "to", subject: "subject", body: "body", to_list: false, cc: "cc", bcc: "bcc" };
  assert.deepEqual(sendArgs(comma, ["dana@northwind-bakery.example", "alex@harlow.example"], { ...c, bcc: ["juno@harlow.example"] }), {
    to: "dana@northwind-bakery.example, alex@harlow.example", subject: "Oven rota", body: "The rota is ready.",
    cc: "kit@harlow.example", bcc: "juno@harlow.example",
  });
  // An unmapped in_reply_to is dropped; an empty cc is fine.
  const bare = { tool: "send_email", to: "to", subject: "subject", body: "body", to_list: false };
  assert.deepEqual(sendArgs(bare, ["dana@northwind-bakery.example"], { subject: "s", body: "b", cc: [], in_reply_to: "<m1@mail.example>" }),
    { to: "dana@northwind-bakery.example", subject: "s", body: "b" });
  // A cc or bcc the tool cannot take is refused, never dropped.
  assert.throws(() => sendArgs(bare, ["dana@northwind-bakery.example"], { subject: "s", body: "b", cc: ["kit@harlow.example"] }),
    e => e.code === "bad_input" && /takes no cc/.test(e.message));
  assert.throws(() => sendArgs(bare, ["dana@northwind-bakery.example"], { subject: "s", body: "b", bcc: ["kit@harlow.example"] }),
    e => e.code === "bad_input" && /takes no bcc/.test(e.message));
});

test("mcpmap: messagesOf over structuredContent, JSON text and each list key", () => {
  const row = {
    id: "m1", threadId: "t1", from: { name: "Dana Reyes", email: "dana@northwind-bakery.example" }, to: [{ email: "alex@harlow.example" }, "kit@harlow.example"],
    subject: "Oven rota", date: "2026-09-20T10:00:00Z", snippet: "The rota is ready.",
  };
  const want = { account: "cn_mail", id: "m1", thread_id: "t1", from: "dana@northwind-bakery.example", to: "alex@harlow.example, kit@harlow.example",
    subject: "Oven rota", date: "2026-09-20T10:00:00Z", snippet: "The rota is ready.", _at: Date.parse("2026-09-20T10:00:00Z") };
  assert.deepEqual(messagesOf({ structuredContent: { messages: [row] } }, "cn_mail"), [want]);
  assert.deepEqual(messagesOf({ content: [{ type: "text", text: JSON.stringify([row]) }] }, "cn_mail"), [want]);
  assert.deepEqual(messagesOf({ content: [{ type: "text", text: JSON.stringify({ results: [row] }) }] }, "cn_mail"), [want]);
  assert.deepEqual(messagesOf({ structuredContent: [row] }, "cn_mail"), [want]);

  // Other field names, an epoch date, no id (dropped), and missing fields.
  const other = messagesOf({ structuredContent: { results: [
    { message_id: "m2", sender: "Harlow Legal <alex@harlow.example>", recipients: "dana@northwind-bakery.example", title: "Invoice", internalDate: "1790000000000", preview: "x".repeat(400) },
    { subject: "no id" }, "not an object", null,
    { id: "m3" },
  ] } }, "cn_mail");
  assert.equal(other.length, 2);
  assert.deepEqual([other[0].id, other[0].from, other[0].to, other[0].subject, other[0]._at, other[0].snippet.length], ["m2", "Harlow Legal <alex@harlow.example>", "dana@northwind-bakery.example", "Invoice", 1790000000000, 300]);
  assert.equal("thread_id" in other[0], false);
  assert.deepEqual(other[1], { account: "cn_mail", id: "m3", from: "", to: "", subject: "(no subject)", date: "", snippet: "", _at: 0 });

  // Nothing list-shaped: no rows. An error: thrown with the server's words.
  assert.deepEqual(messagesOf({ content: [{ type: "text", text: "no messages found" }] }, "cn_mail"), []);
  assert.deepEqual(messagesOf({ structuredContent: { count: 0 } }, "cn_mail"), []);
  assert.throws(() => messagesOf({ isError: true, content: [{ type: "text", text: "quota exceeded" }] }, "cn_mail"), e => e.code === "mcp" && /quota exceeded/.test(e.message));
  assert.throws(() => messagesOf({ isError: true, content: [{ type: "text", text: "{}" }] }, "cn_mail"), /the server refused the search/);
});

test("mcpmap: messageOf", () => {
  const m = messageOf({ structuredContent: { message: { id: "m1", from: "Dana Reyes <dana@northwind-bakery.example>", to: ["alex@harlow.example"],
    subject: "Oven rota", date: "Sun, 20 Sep 2026 10:00:00 +0000", body: "Hi Alex, the rota is ready." } } }, "cn_mail", "m1");
  assert.deepEqual(m, { account: "cn_mail", id: "m1", from: "Dana Reyes <dana@northwind-bakery.example>", to: "alex@harlow.example",
    subject: "Oven rota", date: "Sun, 20 Sep 2026 10:00:00 +0000", body: "Hi Alex, the rota is ready." });
  // A top-level object, the email key, and plain text that is not JSON.
  assert.equal(messageOf({ structuredContent: { email: { text: "via email key" } } }, "cn_mail", "m2").body, "via email key");
  assert.equal(messageOf({ content: [{ type: "text", text: JSON.stringify({ id: "m3", content: "top level" }) }] }, "cn_mail", "x").id, "m3");
  const plain = messageOf({ content: [{ type: "text", text: "just the body" }] }, "cn_mail", "m4");
  assert.deepEqual([plain.id, plain.body, plain.subject], ["m4", "just the body", "(no subject)"]);
  // A long body is cut and says so.
  const long = messageOf({ structuredContent: { id: "m5", body: "y".repeat(25_000) } }, "cn_mail", "m5");
  assert.deepEqual([long.body.length, long.truncated], [20_000, true]);
  assert.equal("truncated" in m, false);
  assert.throws(() => messageOf({ isError: true, content: [{ type: "text", text: "no such message" }] }, "cn_mail", "m6"), e => e.code === "mcp" && /no such message/.test(e.message));
});
