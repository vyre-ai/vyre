import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Field } from "../components/Field";
import { Menu } from "../components/Menu";
import { Select } from "../components/Select";
import { Text } from "../components/Text";
import { parseTags, tagLabel, tagToken } from "./tags.js";
import type { Options } from "./logic.js";

type Pick = "field" | "record" | "records" | "file";

/**
 * A box of words for one person on a step (the assignee's brief, the approver's note, the followers' note). Tag inserts a reference where the text ends: this record, one of its fields, a
 * specific record, several records of an object, or a file. A tag is stored as written and resolved when the step runs, so the person reads the record as it is then. Tags show as chips under the box.
 */
export function ContextBox({ label, value, onChange, options, placeholder, help }: { label: string; value: string; onChange: (v: string) => void; options: Options; placeholder?: string; help?: string }) {
  const [pick, setPick] = useState<Pick | null>(null);
  const [type, setType] = useState("");
  const [field, setField] = useState("");
  const [urn, setUrn] = useState("");
  const [path, setPath] = useState("");
  const [rows, setRows] = useState<{ urn: string; label: string }[]>([]);
  const fields = options.types.find((t) => t.name === type)?.fields ?? [];
  useEffect(() => {
    if (pick !== "record" || !type || !options.recordsOf) { setRows([]); return; }
    let live = true;
    options.recordsOf(type).then((r) => { if (live) setRows(r); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [pick, type, options]);
  const add = (token: string) => { onChange(`${value}${value && !/\s$/.test(value) ? " " : ""}${token}`); setPick(null); setField(""); setUrn(""); setPath(""); };
  const tags = parseTags(value);
  const ready = pick === "field" ? !!field : pick === "record" ? !!urn : pick === "records" ? !!type : pick === "file" ? !!path.trim() : false;
  return (
    <View className="gap-s2">
      <Field label={label} multiline lines={4} value={value} onChangeText={onChange} placeholder={placeholder} help={help} />
      <View className="flex-row flex-wrap items-center gap-s2">
        <Menu align="start" trigger={<Button kind="ghost" size="sm" icon="mention" label="Tag" />} items={[
          { label: "This record", onPress: () => add(tagToken({ kind: "this" })) },
          { label: "A field of this record", onPress: () => setPick("field") },
          { label: "A specific record", onPress: () => setPick("record") },
          { label: "Several records of an object", onPress: () => setPick("records") },
          { label: "A file", onPress: () => setPick("file") },
        ]} />
        {tags.map((t, i) => <Chip key={i} icon="link">{tagLabel(t, options)}</Chip>)}
      </View>
      {pick ? (
        <View className="gap-s2 rounded-card border border-edge bg-surface-3 p-s3">
          {pick !== "file" ? <Select label="Object" value={type} options={options.types.map((t) => [t.name, t.label] as [string, string])} placeholder="Choose an object" onChange={setType} /> : null}
          {pick === "field" ? <Select label="Field of this record" value={field} options={fields.map((f) => [f.name, f.label] as [string, string])} placeholder={type ? "Choose a field" : "Choose an object first"} onChange={setField} /> : null}
          {pick === "record" ? <Select label="Record" value={urn} options={rows.map((r) => [r.urn, r.label] as [string, string])} placeholder={type ? "Choose a record" : "Choose an object first"} onChange={setUrn} /> : null}
          {pick === "file" ? <Field label="File path" value={path} onChangeText={setPath} placeholder="For example projects/atp/contract.pdf" /> : null}
          {pick === "records" ? <Text size="caption" tone="label">The first ten records of the object are listed, one line each.</Text> : null}
          <View className="flex-row gap-s2">
            <Button kind="primary" size="sm" label="Add the tag" disabled={!ready} onPress={() => add(tagToken({ kind: pick, type, field, urn: pick === "field" ? undefined : urn, path: path.trim() }))} />
            <Button kind="ghost" size="sm" label="Cancel" onPress={() => setPick(null)} />
          </View>
        </View>
      ) : null}
      {tags.length ? <Text size="caption" tone="label">Tags are read when the step runs, so they show the record as it is then.</Text> : null}
    </View>
  );
}
