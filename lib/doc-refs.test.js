import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromEditable, kindOf, parseRefs, refLink, refUrn, renderForPrompt, toEditable } from "./doc-refs.js";

const SAM = "vyre://acme/person/p_1";
const DOE = "vyre://acme/matter/m_9";
const MD = `Ask [@Sam](${SAM}) about [#Doe estate](${DOE}) first.\n\n- [#intake.pdf](vyre://acme/file/Clients/intake.pdf)\n`;

test("a pick is stored as a markdown link to its address, and read back", () => {
  const r = parseRefs(MD);
  assert.deepEqual(r.map((x) => [x.lead, x.name, x.urn, x.kind]), [["@", "Sam", SAM, "person"], ["#", "Doe estate", DOE, "record"], ["#", "intake.pdf", "vyre://acme/file/Clients/intake.pdf", "file"]]);
});

test("the editor shows only the token, never the address, and the round trip is exact", () => {
  const { text, refs } = toEditable(MD);
  assert.equal(text, "Ask @Sam about #Doe estate first.\n\n- #intake.pdf\n");
  assert.ok(!text.includes("vyre://"));
  assert.equal(fromEditable(text, refs), MD);
});

test("picker to stored link to chip and back: a pick, an edit around it, and the stored text", () => {
  const { refs } = toEditable("");
  const urn = refUrn({ space: "acme", kind: "person", id: "p_1" });
  assert.equal(urn, SAM);
  refs.set("@Sam", urn);
  // the picker wrote "@Sam" into the editor's text; typing goes on around it
  const stored = fromEditable("Ask @Sam today. @Samuel is not Sam.", refs);
  assert.equal(stored, `Ask ${refLink("@", "Sam", SAM)} today. @Samuel is not Sam.`);
  assert.deepEqual(parseRefs(stored).map((x) => x.name), ["Sam"], "the chip is for Sam, and a longer word that starts the same is not one");
  // the chip's name is what the editor shows again
  assert.equal(toEditable(stored).text, "Ask @Sam today. @Samuel is not Sam.");
});

test("the longest name wins, and a word that was never picked stays plain", () => {
  const refs = new Map([["#Doe", "vyre://a/tag/doe"], ["#Doe estate", DOE]]);
  assert.equal(fromEditable("see #Doe estate and #Doe, not #Smith", refs), `see ${refLink("#", "Doe estate", DOE)} and ${refLink("#", "Doe", "vyre://a/tag/doe")}, not #Smith`);
});

test("brackets in a name are escaped and survive", () => {
  const md = refLink("#", "Plan [draft]", DOE);
  assert.equal(parseRefs(md)[0].name, "Plan [draft]");
  const { text, refs } = toEditable(md);
  assert.equal(text, "#Plan [draft]");
  assert.equal(fromEditable(text, refs), md);
});

test("addresses are built from what a pick carries", () => {
  assert.equal(refUrn({ space: "acme", kind: "agent", id: "juno" }), "vyre://acme/agent/juno");
  assert.equal(refUrn({ space: "acme", kind: "file", urn: "file/Clients/Doe (old)/a b.pdf" }), "vyre://acme/file/Clients/Doe%20%28old%29/a%20b.pdf");
  assert.equal(refUrn({ space: "acme", kind: "tag", urn: "tag/estate" }), "vyre://acme/tag/estate");
  assert.equal(refUrn({ space: "acme", kind: "collection", urn: "type/client" }), "vyre://acme/type/client");
  assert.equal(refUrn({ space: "acme", kind: "record", urn: "vyre://acme/matter/m_9" }), DOE);
  assert.equal(refUrn({ space: "acme", kind: "record", urn: "m_9" }), "vyre://acme/record/m_9");
  assert.equal(refUrn({ space: "acme", kind: "linked", urn: "l1:docs/a.md" }), "vyre://acme/linked/l1%3Adocs%2Fa.md");
  assert.equal(kindOf("vyre://acme/project/p1"), "project");
  assert.equal(kindOf("vyre://acme/matter/m_9"), "record");
  assert.equal(kindOf("vyre://acme/tag/t_1", ["tag"]), "record", "a record type the Space made with a kind's name is a record");
  assert.equal(kindOf("vyre://acme/tag/t_1", ["matter"]), "tag", "another type name changes nothing");
  assert.equal(kindOf("vyre://acme/person/p_1"), "person", "no list: as before");
});

test("an address with a closing bracket in a file name stays one link", () => {
  const u = refUrn({ space: "acme", kind: "file", urn: "file/a(1).pdf" });
  const md = `read ${refLink("#", "a(1).pdf", u)} now`;
  assert.equal(parseRefs(md).length, 1);
  assert.equal(parseRefs(md)[0].urn, u);
});

test("the prompt gets a plain line with the address for each reference", () => {
  const out = renderForPrompt(MD, () => true);
  assert.equal(out, "Ask @Sam (person, vyre://acme/person/p_1) about #Doe estate (record, vyre://acme/matter/m_9) first.\n\n- #intake.pdf (file, vyre://acme/file/Clients/intake.pdf)\n");
  assert.ok(!out.includes("]("), "no link markup reaches the model");
});

test("a reference the reader may not read keeps its name and loses the address", () => {
  const out = renderForPrompt(MD, (r) => r.kind === "person");
  assert.equal(out, "Ask @Sam (person, vyre://acme/person/p_1) about #Doe estate first.\n\n- #intake.pdf\n");
  assert.ok(!out.includes(DOE));
});

test("text with no reference is returned as it is", () => {
  assert.equal(renderForPrompt("Plain [link](https://x.y) and @someone.", () => false), "Plain [link](https://x.y) and @someone.");
  assert.equal(renderForPrompt("", () => true), "");
});
