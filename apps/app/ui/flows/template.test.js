import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dateRefs, dateWords, dateToken, datePending, addressPicks, parseTemplate, tokensOf, insertList, renderPreview, openBrace, completeBrace, suggest, appendToken, smsCount, history, unknownTokens, tokenLabel } from "./template.js";
import { fromDefinition, toDefinition } from "./logic.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const draft = (steps, trigger = { kind: "form" }) => ({ name: "t", trigger, steps });
const email = { id: "mail", kind: "email", sendStep: "comms.email", to: "{email}", subject: "Hi {name}", body: "Hello {name}", replyTo: "{email}" };

test("a template splits into words and tokens", () => {
  assert.deepEqual(parseTemplate("Hi {client.first_name}, see you {appointment.starts_at}."), [{ text: "Hi " }, { token: "{client.first_name}", path: "client.first_name" }, { text: ", see you " }, { token: "{appointment.starts_at}", path: "appointment.starts_at" }, { text: "." }]);
  assert.deepEqual(tokensOf("{a} and {b.c} and { nope } and {}").map((t) => t.path), ["a", "b.c"]);
  assert.deepEqual(parseTemplate(""), []);
});

test("typing a brace opens the suggestions and finishing one completes the token", () => {
  assert.equal(openBrace("Hello {cl"), "cl");
  assert.equal(openBrace("Hello {"), "");
  assert.equal(openBrace("Hello {name} and"), null);
  assert.equal(openBrace("Hello"), null);
  assert.equal(completeBrace("Hello {cl", "{client.name}"), "Hello {client.name}");
  assert.equal(completeBrace("Hello", "{x}"), "Hello{x}");
  assert.equal(appendToken("Hello", "{x}"), "Hello {x}");
  assert.equal(appendToken("", "{x}"), "{x}");
});

test("the insert list holds the form, earlier steps and the helper values", () => {
  const d = draft([{ id: "find1", kind: "find", type: "client" }, { id: "calc", kind: "formula", formula: "1" }, email]);
  const g = insertList(d, "mail", O);
  assert.equal(g[0].title, "The form");
  assert.ok(g[0].items.some((i) => i.token === "{email}"));
  const steps = g.find((x) => x.title === "Earlier steps");
  assert.deepEqual(steps.items.map((i) => i.token), ["{steps.find1.rows}", "{steps.calc.value}"]);
  assert.ok(g[g.length - 1].items.every((i) => i.known === false && i.note === "Not available yet"));
});

test("only steps before this one are offered, and the engine can declare helpers", () => {
  const d = draft([email, { id: "later", kind: "formula", formula: "1" }]);
  assert.equal(insertList(d, "mail", O).some((g) => g.title === "Earlier steps"), false);
  const g = insertList(d, "mail", O, { engineHas: ["{now.date}"] });
  assert.deepEqual(g[g.length - 1].items.filter((i) => i.known).map((i) => i.token), ["{now.date}"]);
});

test("a record trigger lists its object's fields, and a sealed one carries a lock note", () => {
  const t = O.types[0];
  const o = { ...O, types: [{ ...t, fields: [...(t.fields || []), { name: "ssn", label: "SSN", sealed: true }] }, ...O.types.slice(1)] };
  const g = insertList(draft([email], { kind: "created", type: t.name }), "mail", o);
  assert.ok(g[0].items.some((i) => i.token === `{after.${t.fields[0].name}}`));
  const s = g[0].items.find((i) => i.token === "{after.ssn}");
  assert.equal(s.sealed, true);
  assert.match(s.note, /sealed values/);
});

test("unknown tokens are flagged and the preview fills samples", () => {
  const g = insertList(draft([email]), "mail", O);
  assert.deepEqual(unknownTokens("Hi {name} {bogus.x} {now.date}", g), ["{bogus.x}", "{now.date}"]);
  assert.equal(tokenLabel("name", g), "Name");
  assert.equal(renderPreview("Hi {name}, {email}", { name: "Ana" }, g), "Hi Ana, [Email]");
  assert.equal(suggest(g, "mes")[0].token, "{message}");
});

test("a text counts characters and segments", () => {
  assert.deepEqual(smsCount(""), { chars: 0, segments: 0, unicode: false });
  assert.equal(smsCount("a".repeat(160)).segments, 1);
  assert.equal(smsCount("a".repeat(161)).segments, 2);
  assert.equal(smsCount("a".repeat(307)).segments, 3);
  assert.deepEqual(smsCount("café \u{1F600}"), { chars: 6, segments: 1, unicode: true });
  assert.equal(smsCount("é".repeat(70)).segments, 1);
});

test("undo steps back through edits", () => {
  const h = history("a");
  h.push("ab"); h.push("ab"); h.push("abc");
  assert.equal(h.canUndo, true);
  assert.equal(h.undo(), "ab");
  assert.equal(h.undo(), "a");
  assert.equal(h.canUndo, false);
  assert.equal(h.undo(), "a");
});

test("the email step keeps Reply-To through compile and decompile", () => {
  const def = toDefinition(draft([email]));
  const call = def.steps[0];
  assert.equal(call.action, "comms.email");
  assert.deepEqual(Object.keys(call.input), ["to", "subject", "body", "replyTo"]);
  const back = fromDefinition(def).steps[0];
  assert.equal(back.kind, "email");
  assert.equal(back.replyTo, "{email}");
  const bare = toDefinition(draft([{ ...email, replyTo: "" }])).steps[0];
  assert.equal("replyTo" in bare.input, false);
  assert.equal(fromDefinition(toDefinition(draft([{ ...email, replyTo: "" }]))).steps[0].kind, "email");
});

test("address boxes offer the email-type fields in context, labelled from the data", () => {
  const o = { ...O, types: [{ name: "thing", label: "Thing", fields: [{ name: "contact", label: "Contact", type: "email" }, { name: "work_email", label: "Work email" }, { name: "note", label: "Note" }] }] };
  const d = draft([{ id: "mk", kind: "create", type: "thing", fields: [] }, email], { kind: "created", type: "thing" });
  const picks = addressPicks(insertList(d, "mail", o));
  assert.deepEqual(picks.map((p) => p.token), ["{after.contact}", "{after.work_email}", "{steps.mk.record.data.contact}", "{steps.mk.record.data.work_email}"]);
  assert.match(picks[0].label, /^Contact \(Thing\)$/);
  assert.equal(tokenLabel("after.contact", insertList(d, "mail", o)), "Thing \u00b7 Contact");
  assert.deepEqual(addressPicks(insertList(draft([email]), "mail", O)).map((p) => p.token), ["{email}"]);
});

test("the email step keeps From through compile and decompile", () => {
  const def = toDefinition(draft([{ ...email, from: "{after.owner_email}" }]));
  assert.deepEqual(Object.keys(def.steps[0].input), ["to", "subject", "body", "replyTo", "from"]);
  assert.equal(fromDefinition(def).steps[0].from, "{after.owner_email}");
});

test("insert a date reads back in words and inserts the plain field for now", () => {
  const o = { ...O, types: [{ name: "thing", label: "Thing", fields: [{ name: "starts_at", label: "Start" }, { name: "note", label: "Note" }, { name: "due", label: "Due", type: "date" }] }] };
  const g = insertList(draft([email], { kind: "created", type: "thing" }), "mail", o);
  const refs = dateRefs(g);
  assert.deepEqual(refs.map((r) => r.token), ["{after.starts_at}", "{after.due}", ""]);
  assert.equal(refs[2].label, "Now");
  const d = { ref: refs[0].token, refLabel: refs[0].label, dir: "before", amount: 1, unit: "days", format: "weekday" };
  assert.equal(dateWords(d), "Thing \u00b7 Start, minus 1 day, as weekday and date");
  assert.equal(dateWords({ ...d, dir: "after", amount: 3 }), "Thing \u00b7 Start, plus 3 days, as weekday and date");
  assert.equal(dateWords({ ...d, dir: "at", format: "datetime" }), "Thing \u00b7 Start, as date and time");
  assert.equal(dateToken(d), "{after.starts_at}");
  assert.match(datePending(d), /offset and format are Coming next/);
  assert.equal(datePending(d, { engineDates: true }), null);
  assert.match(datePending({ ...d, ref: "" }), /Now/);
});
