// @ts-check
// A member's skill file is read with a strict front matter: only `name` and `description`, in one exact shape. Each way another reader of the same file (YAML, as Claude Code reads it) could see a key the lenient
// reader skips is refused, one at a time, and a plain file and a multi-line description are accepted.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseMemberUpload, strictFrontMatter } from "./member-upload.js";

const D = "description: Use this when the team needs the routine done the same way each time.";
const file = (/** @type {string} */ text) => ({ file: Buffer.from(text), filename: "routine.md" });
const doc = (/** @type {string} */ fm, body = "Do the careful thing first.\n") => `---\n${fm}\n---\n${body}`;
const refuses = (/** @type {string} */ text, /** @type {RegExp} */ re = /./) => assert.throws(() => parseMemberUpload(file(text)), re);

test("a plain name and description is accepted, and so is a description that continues on indented lines", () => {
  const a = parseMemberUpload(file(doc(`name: routine\n${D}`)));
  assert.deepEqual([a.kind, a.name], ["skill", "routine"]);
  const b = parseMemberUpload(file(doc(`name: routine\ndescription: Use this when the team needs the routine\n  done the same way each time, with a second line.\n\n  And a third after a blank one.`)));
  assert.equal(b.name, "routine");
  assert.equal(parseMemberUpload(file(doc(`name: routine\n${D}`).replace(/\n/g, "\r\n"))).name, "routine", "CRLF is taken as LF");
});

test("a key beyond name and description is refused, named in the message", () => {
  for (const key of ["allowed-tools", "hooks", "mcp", "model"]) refuses(doc(`name: routine\n${D}\n${key}: x`), new RegExp(key));
});

test("a quoted key is refused", () => refuses(doc(`name: routine\n${D}\n"allowed-tools": Bash`), /allowed-tools/));
test("a space before the colon is refused", () => refuses(doc(`name: routine\n${D}\nallowed-tools : Bash`), /allowed-tools/));
test("a flow mapping line is refused", () => refuses(doc(`name: routine\n${D}\n{allowed-tools: Bash}`), /allowed-tools/));
test("a key that starts with a symbol is refused", () => { for (const c of ["?", "-", "&", "*", "!", "%", "#"]) refuses(doc(`name: routine\n${D}\n${c} allowed-tools: Bash`), /allowed-tools/); });
test("a tab-indented key is refused", () => refuses(doc(`name: routine\n${D}\n\tallowed-tools: Bash`), /control character/));
test("a key indented under the name, or a key-looking line inside the description, is refused", () => {
  refuses(doc(`name: routine\n  allowed-tools: Bash\n${D}`), /allowed-tools/);
  refuses(doc(`name: routine\n${D}\n  allowed-tools: Bash`), /key inside the description/);
});
test("a byte-order mark, a blank line or a space before the first --- is refused", () => {
  const ok = doc(`name: routine\n${D}`);
  refuses("﻿" + ok, /exactly ---/);
  refuses("\n" + ok, /exactly ---/);
  refuses(" " + ok, /exactly ---/);
});
test("a repeated name or description is refused", () => {
  refuses(doc(`name: routine\nname: other\n${D}`), /second one/);
  refuses(doc(`name: routine\n${D}\n${D}`), /second one/);
});
test("a missing closing line, or no name, is refused", () => {
  refuses(`---\nname: routine\n${D}\nDo the thing.\n`, /closing/);
  refuses(doc(D), /name/);
});
test("the strict check alone names the first offending line, shortened", () => {
  assert.throws(() => strictFrontMatter(doc(`name: routine\n${"x".repeat(80)}`)), /xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\.\.\./);
});

test("a hidden line break or control character in the front matter is refused, one by one, on a continuation, name and description line", () => {
  const chars = { "\\r": "\r", "\\u0085": "\u0085", "\\u2028": "\u2028", "\\u2029": "\u2029", "\\v": "\v", "\\f": "\f", "NUL": "\0", "tab": "\t", "DEL": "\u007f" };
  for (const [label, c] of Object.entries(chars)) {
    const RE = c === "\0" ? /not text/ : /line break character/;   // a NUL is already "not text" to the file reader
    refuses(doc(`name: routine\n${D}\n  more${c}allowed-tools: Bash`), RE);
    refuses(doc(`name: rou${c}tine\n${D}`), RE);
    refuses(doc(`name: routine\ndescription: Use this when the team${c}allowed-tools: Bash is wanted for the routine.`), RE);
    assert.throws(() => strictFrontMatter(doc(`name: routine\n${D}\n  more${c}allowed-tools: Bash`)), /line break character/, label);   // the validator itself, NUL included
  }
  // the body after the closing line may hold them; the plain forms stay accepted
  assert.equal(parseMemberUpload(file(doc(`name: routine\n${D}`, "Line one\rline two\u2028x\n"))).name, "routine");
  assert.equal(parseMemberUpload(file(doc(`name: routine\ndescription: Use this when the team needs it\n  and a second line.`))).name, "routine");
});
