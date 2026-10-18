import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Card, Field, Row, Select, Sheet, Text, showToast } from "@vyre/ui";
import type { FieldEnv } from "../../ui/fields/types";
import { callT } from "../../src/real/call-tool";
import { groupConnections } from "./connections-model.js";

type Rel = { id: string; direction: "from" | "to"; other: string; kind: string; since: string | null; until: string | null; note: string };

/**
 * What a record is connected to: a person to a company, a person to a person, any record to any record, read from both ends (records.relationship.list). Grouped by kind, what ended kept apart and quiet.
 * "Add a connection" picks the other record and a kind from the Space's own list (records.relationship.kinds) and writes one relationship row.
 */
export function Connections({ urn, env, onOpen }: { urn: string; env: FieldEnv; onOpen: (urn: string) => void }) {
  const [rows, setRows] = useState<Rel[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => { void callT<{ relationships: Rel[] }>("records.relationship.list", { urn }).then((r) => setRows(r.data?.relationships ?? [])); }, [urn]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const titleOf = (u: string) => env.links?.[u]?.title ?? u.split("/").pop() ?? u;
  const sections = useMemo(() => groupConnections(rows ?? [], titleOf), [rows, env.links]);
  return (
    <Card title="Connections" actions={<Button kind="ghost" size="sm" icon="plus" label="Add a connection" onPress={() => setAdding(true)} />}>
      {rows === null ? <Text tone="label">Loading</Text> : sections.length ? sections.map((s) => (
        <View key={s.title} className="gap-s1 pb-s3">
          <Text size="caption" tone="label">{s.title}</Text>
          {s.items.map((it) => <Row key={it.id} title={it.title} sub={[it.when, it.note].filter(Boolean).join(" · ")} onPress={() => onOpen(it.urn)} />)}
        </View>
      )) : <Text tone="label">Nothing connected yet.</Text>}
      <AddConnection open={adding} onClose={() => setAdding(false)} urn={urn} env={env} onDone={() => { setAdding(false); load(); }} />
    </Card>
  );
}

function AddConnection({ open, onClose, urn, env, onDone }: { open: boolean; onClose: () => void; urn: string; env: FieldEnv; onDone: () => void }) {
  const [kinds, setKinds] = useState<string[]>([]);
  const [kind, setKind] = useState("");
  const [other, setOther] = useState("");
  const [since, setSince] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) void callT<{ kinds: string[] }>("records.relationship.kinds", {}).then((r) => { const k = r.data?.kinds ?? []; setKinds(k); setKind((c) => c || k[0] || ""); }); }, [open]);
  const options = useMemo(() => Object.entries(env.links ?? {}).filter(([u]) => u !== urn).map(([u, v]) => [u, v.title] as [string, string]).sort((a, b) => a[1].localeCompare(b[1])).slice(0, 300), [env.links, urn]);
  const save = async () => {
    setBusy(true);
    const r = await callT("records.relationship.add", { from: urn, to: other, kind, ...(since.trim() ? { since: since.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
    setBusy(false);
    if (r.error) { showToast(r.error.message || "That did not save."); return; }
    setOther(""); setSince(""); setNote("");
    showToast("Connected. It shows on both records.");
    onDone();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add a connection">
      <View className="gap-s3">
        <Text tone="muted">It shows on both records, and keeps its history.</Text>
        <Select label="Kind" value={kind} options={kinds.map((k) => [k, k] as [string, string])} onChange={setKind} />
        <Select label="To" value={other} options={options} onChange={setOther} />
        <Field label="Since" value={since} placeholder="For example Oct 2026" onChangeText={setSince} />
        <Field label="Note" value={note} placeholder="Anything worth remembering" onChangeText={setNote} />
        <View className="flex-row gap-s2">
          <Button kind="primary" label="Add it" loading={busy} disabled={busy || !other || !kind} onPress={save} />
          <Button kind="ghost" label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
