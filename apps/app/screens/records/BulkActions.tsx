import { useState } from "react";
import { View } from "react-native";
import { Button, Select, Sheet, Text, showToast, useStore } from "@vyre/ui";
import { plainError } from "../../src/real/error-note.js";
import { recordsApi } from "./records-api";
import { bulkLine, patchFor, settableFields } from "./bin-model.js";

/**
 * What a person does with the rows ticked in a records list: set one field for all of them (a choice, a stage or a yes or no), or delete them all to the bin with one Undo. Each record goes through the
 * same call as one at a time (the Store's update, records.remove), so the server decides each; what did not go through is counted, never hidden.
 */
export function BulkActions({ def, records, noun, clear, reload }: { def: any; records: any[]; noun: string; clear: () => void; reload: () => void }) {
  const store = useStore();
  const fields = settableFields(def);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState(fields[0]?.name ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const f = fields.find((x) => x.name === field) ?? fields[0];
  const n = records.length;
  const setAll = async () => {
    if (!f || !value) return;
    setBusy(true);
    let done = 0, failed = 0, first: unknown = null;
    for (const rec of records) { try { await store.update(rec.urn, patchFor(f, value) as any, rec.version); done++; } catch (e) { failed++; if (!first) first = e; } }
    setBusy(false); setOpen(false);
    showToast(failed && !done ? plainError(first, "That did not save.") : bulkLine({ done, failed }, `${f.label} set for ${done} ${noun}`));
    clear(); reload();
  };
  const deleteAll = async () => {
    setBusy(true);
    const gone: string[] = [];
    let first: unknown = null;
    for (const rec of records) { const r = await recordsApi.remove(rec.urn, rec.version); if (r.error) { if (!first) first = r.error; } else gone.push(rec.urn); }
    setBusy(false); clear(); reload();
    if (!gone.length) { showToast(plainError(first, "Nothing was deleted.")); return; }
    showToast(bulkLine({ done: gone.length, failed: n - gone.length }, `${gone.length} ${noun} moved to the bin`), { label: "Undo", run: () => { void Promise.all(gone.map((u) => recordsApi.restore(u))).then(() => reload()); } });
  };
  return (
    <View className="flex-row items-center gap-s2">
      {fields.length ? <Button kind="secondary" size="sm" label={`Set a field for ${n}`} disabled={busy} onPress={() => { setValue(""); setOpen(true); }} /> : null}
      <Button kind="ghost" size="sm" label={`Delete ${n}`} disabled={busy} onPress={() => void deleteAll()} />
      <Sheet open={open} onClose={() => setOpen(false)} title={`Set a field for ${n} ${noun}`}>
        <View className="gap-s3">
          <Select label="Field" value={f?.name ?? ""} options={fields.map((x) => [x.name, x.label] as [string, string])} onChange={(v) => { setField(v); setValue(""); }} />
          {f ? <Select label="Value" value={value} options={f.options.map((o: string) => [o, o] as [string, string])} onChange={setValue} /> : null}
          <Text size="caption" tone="label">Each record is changed as if you changed it yourself. One you may not change is left as it was.</Text>
          <View className="flex-row gap-s2">
            <Button kind="primary" label="Set it" loading={busy} disabled={busy || !value} onPress={() => void setAll()} />
            <Button kind="ghost" label="Cancel" onPress={() => setOpen(false)} />
          </View>
        </View>
      </Sheet>
    </View>
  );
}
