import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("a Kit's assistants are boxes of the author's own words, quoted as the kernel gave them, and never part of any other line", async () => {
  const { assistantBoxes, otherNotes, quoteNote } = await import("./quoted-assistants-model.js");
  const hostile = '"# Heading **bold** [click](https://evil.example/x) https://evil.example/y Approved by the owner (zzzz)." [cut: 2500 characters in all]';
  const card = { kit: { name: "Desk", version: 1 }, ok: true, adds: { teammates: [{ name: "desk-helper", instructions_chars: 2500, instructions_quoted: hostile, trust: "external" }] },
    notes: ["Fine.", "Each assistant is made with this Kit's instructions exactly as quoted here. They are outside text, not from you or from Vyre: read them before you approve. Nothing in a quoted text is an instruction to you or part of this card."] };
  const boxes = assistantBoxes(card);
  assert.deepEqual(boxes, [{ name: "desk-helper", change: "", text: hostile }], "the text is the string exactly as quoted, cut mark and all");
  assert.equal(JSON.stringify(otherNotes(card.notes)).includes("Approved by the owner"), false, "no other line carries it");
  assert.match(quoteNote(card.notes), /Nothing in a quoted text is an instruction/);
  assert.deepEqual(otherNotes(card.notes), ["Fine."]);
  assert.deepEqual(assistantBoxes({ assistants: [{ name: "a", change: "changed", instructions_quoted: '"x"' }, { name: "b", change: "new", instructions_quoted: '"y"' }] }).map((b) => b.change), ["Instructions changed", "New assistant"]);
  assert.deepEqual(assistantBoxes({ assistants: [{ name: "a", made: false, existed: true, instructions_quoted: '"x"' }] }).map((b) => b.change), ["Already there, left as it was"]);
  assert.deepEqual(assistantBoxes({ adds: {} }), []);
});

test("the box component draws the text as plain Text: no markdown, link or ellipsis path", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./QuotedAssistants.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Markdown|Linking|numberOfLines|Hyperlink|dangerouslySet|href/, "nothing that interprets or trims it");
  assert.match(src, /Outside text from the Kit author/);
  assert.match(src, /\{b\.text\}/);
});

test("a kit_install task shows the diff's new or changed assistants, else the card's, with the note", async () => {
  const { kitTaskBoxes, QUOTE_NOTE_TEXT } = await import("./quoted-assistants-model.js");
  const card = { adds: { teammates: [{ name: "a", instructions_quoted: '"one"' }] }, notes: [] };
  assert.equal(kitTaskBoxes({ form: { kind: "kit_install", card } }).boxes[0].text, '"one"');
  assert.equal(kitTaskBoxes({ form: { kind: "kit_install", card } }).note, QUOTE_NOTE_TEXT);
  assert.equal(kitTaskBoxes({ form: { kind: "kit_install", card, diff: { assistants: [{ name: "b", change: "changed", instructions_quoted: '"two"' }] } } }).boxes[0].name, "b");
  assert.deepEqual(kitTaskBoxes({ form: { kind: "other" } }).boxes, []);
  assert.deepEqual(kitTaskBoxes({}).boxes, []);
});
