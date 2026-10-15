import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "./Button";
import { ChipToken } from "./ChipToken";
import { Field } from "./Field";
import { Menu } from "./Menu";
import { Row } from "./Row";
import { Text } from "./Text";

export type FilePick = { /** What is kept: a path of Files, or a value from an earlier step as its token. */ value: string; /** What the chip says. */ label: string; /** A value from an earlier step rather than a path. */ computed?: boolean };
export type FileChoice = { path: string; name: string };

/**
 * Several files for a form, one removable chip each: pick from the Space's Files (search by name), or insert a value from an earlier step (a file it made). The form shows what is picked and nothing else;
 * what a pick is kept as stays the caller's. `load` answers the files to offer for a search (a name or part of one); `values` are the earlier steps' values that can stand for a file.
 */
export function FilePicks({ label, picks, onChange, load, values = [], max = 10, help }: {
  label: string; picks: FilePick[]; onChange: (next: FilePick[]) => void; load: (query: string) => Promise<FileChoice[]>;
  values?: { value: string; label: string }[]; max?: number; help?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<FileChoice[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setFound(null);
    load(q).then((r) => { if (live) setFound(r.slice(0, 8)); }).catch(() => { if (live) setFound([]); });
    return () => { live = false; };
  }, [open, q, load]);
  const has = (v: string) => picks.some((p) => p.value === v);
  const add = (p: FilePick) => { if (!has(p.value) && picks.length < max) onChange([...picks, p]); };
  const full = picks.length >= max;
  return (
    <View className="gap-s2">
      <Text size="caption" tone="label">{label}</Text>
      {picks.length ? (
        <View className="flex-row flex-wrap gap-s2">
          {picks.map((p) => <ChipToken key={p.value} icon={p.computed ? "mention" : "file"} label={p.label} onRemove={() => onChange(picks.filter((x) => x.value !== p.value))} removeLabel={`Remove ${p.label}`} />)}
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-s2">
        <Button kind="ghost" size="sm" icon="file" label={open ? "Close the list" : "Add a file"} disabled={full} onPress={() => setOpen(!open)} />
        {values.length ? <Menu align="start" trigger={<Button kind="ghost" size="sm" icon="mention" label="Insert a value" disabled={full} />} items={values.map((v) => ({ label: v.label, onPress: () => add({ value: v.value, label: v.label, computed: true }) }))} /> : null}
      </View>
      {open ? (
        <View className="gap-s1">
          <Field value={q} onChangeText={setQ} placeholder="Search your Files by name" />
          {found === null ? <Text size="caption" tone="muted">Looking.</Text> : null}
          {found && !found.length ? <Text size="caption" tone="muted">{q ? "No file has that in its name." : "There are no files here yet."}</Text> : null}
          {(found ?? []).map((f) => <Row key={f.path} title={f.name} sub={f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "Files"} onPress={() => { add({ value: f.path, label: f.name }); }} />)}
        </View>
      ) : null}
      {help ? <Text size="caption" tone="label">{help}</Text> : null}
    </View>
  );
}
