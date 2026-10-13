// The gallery's picture of the file viewer (/app/gallery?f=file-viewer): every kind with sample data, a version diff, and the markdown editor open. No box behind it: each file is an in-memory source.
import { View } from "react-native";
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
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#14202b"/><circle cx="200" cy="180" r="90" fill="#e8b04a"/><rect x="330" y="110" width="220" height="140" rx="16" fill="#3a7bd5"/></svg>`;
const PDF = "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMzAwIDIwMF0vQ29udGVudHMgNCAwIFIvUmVzb3VyY2VzPDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+ZW5kb2JqCjQgMCBvYmo8PC9MZW5ndGggNDQ+PnN0cmVhbQpCVCAvRjEgMjQgVGYgNDAgMTAwIFRkIChIZWxsbyBQREYpIFRqIEVUCmVuZHN0cmVhbSBlbmRvYmoKNSAwIG9iajw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSL1NpemUgNj4+CiUlRU9G";
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

const text = (t: string, save = false): FileSource => ({ load: async () => ({ text: t }), ...(save ? { save: async () => ({ version: 3 }) } : {}) });
const versioned = (now: string, old: string): FileSource => ({
  load: async (v) => ({ text: v === 1 ? old : now }),
  versions: async () => [{ ver: 1, at: Date.now() - 86400_000, by: "person:Dana" }, { ver: 2, at: Date.now() - 3600_000, by: "agent:kit" }],
  save: async () => ({ version: 3 }),
});

function Box({ title, h = 360, children }: { title: string; h?: number; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text size="caption" tone="label">{title}</Text>
      <View style={{ height: h, borderWidth: 1, borderColor: "rgba(128,128,128,.3)", borderRadius: 12, overflow: "hidden" }}>{children}</View>
    </View>
  );
}

export function FileViewerFixture() {
  return (
    <View style={{ gap: 20 }}>
      <Box title="Markdown, rendered, with versions (Changed by an agent)" h={520}><FileViewer name="notes/plan.md" source={versioned(MD, MD_OLD)} nameOf={(id) => id} /></Box>
      <Box title="Markdown, Show changes on" h={420}><FileViewer name="notes/plan.md" source={versioned(MD, MD_OLD)} startChanges /></Box>
      <Box title="Markdown, the editor open (instructions)" h={520}><FileViewer name="AGENTS.md" kind="markdown" source={text(MD, true)} startEditing /></Box>
      <Box title="Instructions, bare (no header, just Edit)" h={300}><FileViewer name="AGENTS.md" kind="markdown" bare source={text(MD, true)} /></Box>
      <Box title="Code"><FileViewer name="src/total.js" source={text(CODE)} /></Box>
      <Box title="JSON"><FileViewer name="matters.json" source={text(JSON_TEXT)} /></Box>
      <Box title="Image"><FileViewer name="logo.svg" source={{ load: async () => ({ base64: b64(SVG), bytes: bytesOfText(SVG) }) }} /></Box>
      <Box title="CSV"><FileViewer name="clients.csv" source={{ load: async () => ({ base64: b64(CSV), bytes: bytesOfText(CSV) }) }} /></Box>
      <Box title="PDF"><FileViewer name="letter.pdf" source={{ load: async () => ({ base64: PDF }) }} /></Box>
      <Box title="A file nothing here draws" h={260}><FileViewer name="backup.zip" source={{ load: async () => ({ bytes: [80, 75, 3, 4, 0, 0] }) }} /></Box>
    </View>
  );
}
