// The gallery's picture of the file viewer (/app/gallery?f=file-viewer): every kind with sample data, a version diff, and the markdown editor open. No box behind it: each file is an in-memory source.
import { View } from "react-native";
import { useUiTheme } from "../theme";
import { Text } from "../components/Text";
import { FileViewer } from "./FileViewer";
import type { FileSource } from "./source";
import { bytesOfText } from "./viewer-model.js";

const MD = `# Retainer checklist

Ask @kit to draft the letter, then link it to #client-intake.

## Before the call

- [x] Conflict check
- [ ] Send the engagement letter
- [ ] Collect the **retainer**

| Step | Owner | Due |
|---|---|---|
| Intake | Dana | Mon |
| Letter | @kit | Tue |

\`\`\`js
const fee = 2500;
console.log("retainer", fee);
\`\`\`

See [the firm site](https://example.com) for the fee schedule.
`;
const MD_OLD = MD.replace("- [x] Conflict check\n", "").replace("2500", "2000");
const CODE = `import { readFileSync } from "node:fs";

// Total the fees in a CSV of clients.
export function total(path) {
  const rows = readFileSync(path, "utf8").trim().split("\\n").slice(1);
  let sum = 0;
  for (const r of rows) sum += Number(r.split(",")[1]) || 0;
  return sum;
}
`;
const JSON_TEXT = JSON.stringify({ firm: "Wine & Associates", open: true, matters: [{ id: 41, client: "Dana Wine", fee: 2500, tags: ["trust", "estate"] }, { id: 42, client: "A. Smith", fee: null, tags: [] }], settings: { currency: "USD", notify: { email: true, sms: false } } }, null, 2);
const CSV = "client,city,fee\nDana Wine,Greenville,2500\n\"Smith, A.\",Charleston,1800\nJo Lee,Columbia,3200\n";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="midnightblue"/><circle cx="200" cy="180" r="90" fill="goldenrod"/><rect x="330" y="110" width="220" height="140" rx="16" fill="steelblue"/></svg>`;
const PDF = "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMzAwIDIwMF0vQ29udGVudHMgNCAwIFIvUmVzb3VyY2VzPDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+ZW5kb2JqCjQgMCBvYmo8PC9MZW5ndGggNDQ+PnN0cmVhbQpCVCAvRjEgMjQgVGYgNDAgMTAwIFRkIChIZWxsbyBQREYpIFRqIEVUCmVuZHN0cmVhbSBlbmRvYmoKNSAwIG9iajw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSL1NpemUgNj4+CiUlRU9G";
/** A .docx whose hyperlinks are javascript: and data: addresses (and one https). The viewer must draw it with those two links dead. */
const DOCX_HOSTILE = "UEsDBBQAAAAIAOoeTV3mdcR+0gAAAIsBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QO1LDMBCGr6JRy0RrKCgY2ymAFii4wI68tjXoNVolhNuzzqvIJCml//HtbrveBa+2VNil2OlH0+h1337/ZWIlSuROz7XmFwC2MwVkkzJFUcZUAlZ5lgky2h+cCJ6a5hlsipViXdWlQ/ftG4248VW97+T7QCnkWavXg3FhdRpz9s5iFR22cbigrI4EI8m9h2eX+UEMGq4SFuU24Jj7lLWLG0h9YakfGMQFv6kMMCS7CZI092uuzJnG0Vk655e2XJIlZhen4M1ZCejiaX7Yn7v/B1BLAwQUAAAACADqHk1dXzOVUpUAAAAHAQAACwAAAF9yZWxzLy5yZWxzjc87DsIwDAbgq0Q+QN0yMKCmXVi6Ii4QJW4T0TzkhNftycBAEQOjf//6LPfjw6/iRpxdDBK6poVx6E+0qlKDbF3KojZClmBLSQfErC15lZuYKNTNHNmrUkdeMCl9UQvhrm33yJ8GbE0xGQk8mQ7E+ZnoHzvOs9N0jPrqKZQfJ74aVVa8UJFwj2zQvOOmsoBDj5sXhxdQSwMEFAAAAAgA6h5NXb2PsZYNAQAAlgIAABwAAAB3b3JkL19yZWxzL2RvY3VtZW50LnhtbC5yZWxztZJLTwJBEIT/ymaump0FhARk4eCaLCQaNCY+LqSZ6X2w88rMwC7+eseDRiIHPXDs7spXVUlP550U0R6tq7VKSS9OyHw2fUQBPixcVRsXBYVyKam8NxNKHatQgou1QRUuhbYSfBhtSQ2wBkqk/SQZUfuTQY6Z0YKnxC74kkRPB4N/YeuiqBlmmu0kKn/CglaBZEWtmgAFW6JPyRb24JitjZ+0teK6jddr0yrkae9LdKd58L/tPFoFgtDTQbMzB+XgYeKx87TyUlxvwOHo6nKV32+ZFC3PhgN4HjabAdu99MYt7w/FW5YcVjfj99fB0rD84eJ/ffIz9/nEusDFDqQRGDMtqf6+/85Ijz5u9gFQSwMEFAAAAAgA6h5NXYvwmPzfAAAABQIAABEAAAB3b3JkL2RvY3VtZW50LnhtbK2RPW7DMAyFryLoAJbboYNhO0uGtLdQJTpWoz9QbN3cvlTiFikCBBmyPIki+eGJ7DffwYsvwOJSHORT08rN2C+dTeYzQCTB6Vi6ZZAzUe6UKmaGoEuTMkTOTQmDJg5xr5aENmMyUIqL++DVc9u+qKBdlCsG78GkaXIGtquBMwTBa2KHZXa5yGrwPdljPXMVrELjLhVyHoQHIsBG9Kq+Vj0VzMcM6F08COycHSS+2rcTa2033pmD+Cj/2lj/+i5q72Bvr9lWk34QfXdJn1zkX3P+BpwjnhXreXJ8+d3x+ANQSwECFAAUAAAACADqHk1d5nXEftIAAACLAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAIAOoeTV1fM5VSlQAAAAcBAAALAAAAAAAAAAAAAAAAAAMBAABfcmVscy8ucmVsc1BLAQIUABQAAAAIAOoeTV29j7GWDQEAAJYCAAAcAAAAAAAAAAAAAAAAAMEBAAB3b3JkL19yZWxzL2RvY3VtZW50LnhtbC5yZWxzUEsBAhQAFAAAAAgA6h5NXYvwmPzfAAAABQIAABEAAAAAAAAAAAAAAAAACAMAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAAEAAQAAwEAABYEAAAAAA==";
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

const text = (t: string, save = false): FileSource => ({ load: async () => ({ text: t }), ...(save ? { save: async () => ({ version: 3 }) } : {}) });
const versioned = (now: string, old: string): FileSource => ({
  load: async (v) => ({ text: v === 1 ? old : now }),
  versions: async () => [{ ver: 1, at: Date.now() - 86400_000, by: "person:Dana" }, { ver: 2, at: Date.now() - 3600_000, by: "agent:kit" }],
  save: async () => ({ version: 3 }),
});

function Box({ title, h = 360, children }: { title: string; h?: number; children: React.ReactNode }) {
  const { color } = useUiTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text size="caption" tone="label">{title}</Text>
      <View style={{ height: h, borderWidth: 1, borderColor: color.edge, borderRadius: 12, overflow: "hidden" }}>{children}</View>
    </View>
  );
}

/** One sample per kind, so each is its own URL (?f=file-viewer&kind=md|code|json|image|csv|docx|diff|pdf|edit|bare|unknown|empty|loading|error); no kind shows them all. */
export type FixtureKind = "md" | "code" | "json" | "image" | "csv" | "docx" | "diff" | "pdf" | "edit" | "bare" | "unknown" | "empty" | "loading" | "error";

const never: FileSource = { load: () => new Promise(() => {}) };
const failing: FileSource = { load: async () => { throw Object.assign(new Error("The file did not load."), { code: "failed" }); } };
const missing: FileSource = { load: async () => { throw Object.assign(new Error("gone"), { code: "not_found" }); } };

export function FileViewerFixture({ kind }: { kind?: string }) {
  const one = (k: FixtureKind) => !kind || kind === k;
  return (
    <View style={{ gap: 20 }}>
      {one("md") ? <Box title="Markdown, rendered, with versions (Changed by an agent)" h={520}><FileViewer name="notes/plan.md" source={versioned(MD, MD_OLD)} nameOf={(id) => id} /></Box> : null}
      {one("diff") ? <Box title="Markdown, Show changes on" h={420}><FileViewer name="notes/plan.md" source={versioned(MD, MD_OLD)} startChanges /></Box> : null}
      {one("edit") ? <Box title="Markdown, the editor open (instructions)" h={520}><FileViewer name="AGENTS.md" kind="markdown" source={text(MD, true)} startEditing /></Box> : null}
      {one("bare") ? <Box title="Instructions, bare (no header, just Edit)" h={300}><FileViewer name="AGENTS.md" kind="markdown" bare source={text(MD, true)} /></Box> : null}
      {one("code") ? <Box title="Code"><FileViewer name="src/total.js" source={text(CODE)} /></Box> : null}
      {one("json") ? <Box title="JSON"><FileViewer name="matters.json" source={text(JSON_TEXT)} /></Box> : null}
      {one("image") ? <Box title="Image"><FileViewer name="logo.svg" source={{ load: async () => ({ base64: b64(SVG), bytes: bytesOfText(SVG) }) }} /></Box> : null}
      {one("csv") ? <Box title="CSV"><FileViewer name="clients.csv" source={{ load: async () => ({ base64: b64(CSV), bytes: bytesOfText(CSV) }) }} /></Box> : null}
      {one("docx") ? <Box title="DOCX with hostile links (the javascript: and data: links must be dead)" h={260}><FileViewer name="letter.docx" source={{ load: async () => ({ base64: DOCX_HOSTILE }) }} /></Box> : null}
      {one("pdf") ? <Box title="PDF"><FileViewer name="letter.pdf" source={{ load: async () => ({ base64: PDF }) }} /></Box> : null}
      {one("unknown") ? <Box title="A file nothing here draws" h={260}><FileViewer name="backup.zip" source={{ load: async () => ({ bytes: [80, 75, 3, 4, 0, 0] }) }} /></Box> : null}
      {one("empty") ? <Box title="Empty file" h={260}><FileViewer name="notes.txt" source={text("")} /></Box> : null}
      {one("loading") ? <Box title="Loading" h={260}><FileViewer name="notes.md" source={never} /></Box> : null}
      {one("error") ? <><Box title="Error: the file did not load" h={260}><FileViewer name="notes.md" source={failing} /></Box><Box title="Error: not in the Drive" h={260}><FileViewer name="gone.pdf" source={missing} /></Box></> : null}
    </View>
  );
}
