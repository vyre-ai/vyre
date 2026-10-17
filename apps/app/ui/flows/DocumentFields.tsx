import { useEffect, useState } from "react";
import { View } from "react-native";
import { Select } from "../components/Select";
import { Text } from "../components/Text";
import { ValueField } from "./ValueField";
import { syncDocumentRows } from "./logic.js";
import type { Draft, DraftStep, Options } from "./logic.js";

/**
 * The settings of Make a document: which Word template, and what fills each placeholder of it. The template says what it asks for (documents.template.get): a plain placeholder gets a value (typed, or taken
 * from the Flow with Insert a value), a dotted one ({contact.name}) reads a record, so it gets the record to read. A document is made only when every one has an answer.
 */
export function DocumentFields({ s, set, draft, options, links }: { s: DraftStep; set: (patch: Partial<DraftStep>) => void; draft: Draft; options: Options; links: [string, string][] }) {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => {
    if (!s.template || !options.placeholdersOf) return;
    let live = true;
    setState("loading");
    options.placeholdersOf(s.template).then((names) => { if (!live) return; setState("idle"); set(syncDocumentRows(s, names)); }).catch(() => { if (live) setState("failed"); });
    return () => { live = false; };
  }, [s.template]); // eslint-disable-line react-hooks/exhaustive-deps
  const templates = (options.documents ?? []).map((d): [string, string] => [d.name, d.name]);
  return (
    <>
      <Select label="Word template" value={s.template ?? ""} options={s.template && !templates.some(([v]) => v === s.template) ? [...templates, [s.template, `${s.template} (not in Templates)`]] : templates} placeholder={templates.length ? "Choose a template" : "No templates yet: add one in Documents"} onChange={(template) => set({ template, fields: [], records: [] })} />
      <Select label="Make it as" value={s.format === "pdf" ? "pdf" : "docx"} options={[["docx", "A Word file"], ["pdf", "A PDF"]]} onChange={(format) => set({ format })} />
      {state === "loading" ? <Text size="caption" tone="label">Reading what the template asks for...</Text> : null}
      {state === "failed" ? <Text size="caption" tone="err">The template could not be read, so what it asks for is not shown. Choose it again.</Text> : null}
      {(s.fields ?? []).map((f: { field: string; value: string }, i: number) => (
        <ValueField key={f.field} label={i ? undefined : "Fill each placeholder"} name={f.field} value={f.value} onChange={(value) => set({ fields: s.fields.map((x: any) => (x.field === f.field ? { ...x, value } : x)) })} placeholder={`For {${f.field}}: text, or a value from the Flow`} draft={draft} stepId={s.id} options={options} />
      ))}
      {(s.records ?? []).map((r: { alias: string; ref: string }) => (
        <Select key={r.alias} label={`Record for {${r.alias}...}`} value={r.ref ?? ""} options={links} placeholder="Choose the record to read" onChange={(ref) => set({ records: s.records.map((x: any) => (x.alias === r.alias ? { ...x, ref } : x)) })} />
      ))}
      <Text size="caption" tone="label">The document is filed in Documents, and a later step can read where. A placeholder with no answer stops the document, named.</Text>
    </>
  );
}
