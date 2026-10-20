import { useState } from "react";
import { View } from "react-native";
import { Banner, Button, Field, IconButton, Select, Sheet, Switch, Text, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { COLUMN_KINDS, columnCall, madeName } from "./add-column.js";
import { plainError } from "../../src/real/error-note.js";

/** "Add a column" on a table: a name and a kind, saved at once, and the column is shown straight away. A link makes its twin on the other type. The box decides who may; its sentence is what shows. */
export function AddColumn({ type, types, onAdded, compact }: { compact?: boolean; type: string; types: { name: string; label: string }[]; onAdded: (name?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState("text");
  const [options, setOptions] = useState("");
  const [to, setTo] = useState("");
  const [many, setMany] = useState(false);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const c = columnCall(type, { label, kind, options, to, many });
    if ("problem" in c) { setProblem(c.problem); return; }
    setBusy(true); setProblem("");
    const r = await callT<any>(c.tool, c.input);
    setBusy(false);
    if (r.error) { setProblem(plainError(r.error, "That did not save.")); return; }
    showToast(`${label.trim()} added.`);
    setOpen(false); setLabel(""); setOptions(""); setTo(""); setMany(false);
    onAdded(madeName(r.data));
  };
  return (
    <>
      {compact ? <IconButton icon="plus" label="Add a column" onPress={() => setOpen(true)} /> : <Button kind="secondary" size="sm" icon="plus" label="Add a column" onPress={() => setOpen(true)} />}
      <Sheet open={open} onClose={() => setOpen(false)} title="Add a column">
        <View className="gap-s3">
          <Field label="Name" value={label} placeholder="Budget, Source, Next step" onChangeText={setLabel} />
          <Select label="Kind" value={kind} options={COLUMN_KINDS as [string, string][]} onChange={setKind} />
          {kind === "choice" ? <Field label="Options, separated by commas" value={options} onChangeText={setOptions} /> : null}
          {kind === "link" ? (
            <>
              <Select label="Links to" value={to} options={types.map((t) => [t.name, t.label] as [string, string])} onChange={setTo} />
              <View className="flex-row items-center gap-s2"><Switch label="Can link several" on={many} onChange={setMany} /><Text>Can link several</Text></View>
              <Text size="caption" tone="label">It shows on both types and keeps in step.</Text>
            </>
          ) : null}
          {problem ? <Banner tone="warn">{problem}</Banner> : null}
          <View className="flex-row gap-s2">
            <Button kind="primary" label="Add it" loading={busy} disabled={busy} onPress={() => void save()} />
            <Button kind="ghost" label="Cancel" onPress={() => setOpen(false)} />
          </View>
        </View>
      </Sheet>
    </>
  );
}
