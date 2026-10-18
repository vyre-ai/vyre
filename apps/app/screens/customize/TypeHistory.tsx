import { useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Divider, EmptyState, ErrorState, LoadingState, Row, Text } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { useSidebar } from "../shell/sidebar";
import { auditReal } from "../audit/real";
import { fieldLines, line, refusal, type Change } from "../audit/model";
import { eventLines, tabRefusal } from "./type-tabs.js";

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
type Item = { key: string | number; title: string; sub: string };

/** A type's History tab: what changed on its records. An owner or an admin sees the audit (who, and the value before and after); anyone else sees the log's plain lines for the records they may read. */
export function TypeHistory({ type }: { type: string }) {
  const admin = useSidebar((s) => s.canSetDefault);
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState("");
  const [more, setMore] = useState(false);
  const load = () => {
    setErr(""); setItems(null);
    if (admin) {
      auditReal({ type }).then((r) => { setItems(r.changes.map((c: Change) => ({ key: c.seq, title: line(c), sub: `${when(c.time)} · ${fieldLines(c).join(" · ") || "no field values"}` }))); setMore(r.more || r.truncated); }).catch((e) => setErr(refusal((e as { code?: string }).code, e instanceof Error ? e.message : "")));
      return;
    }
    void callT<{ events?: any[] }>("records.events", { limit: 200 }).then((r) => { if (r.error) setErr(tabRefusal(r.error.code, r.error.message)); else { setItems(eventLines(r.data?.events ?? [], type).map((e) => ({ key: e.seq, title: e.title, sub: when(e.time) }))); setMore(false); } });
  };
  useEffect(load, [type, admin]);
  if (err) return <Card flush><ErrorState title="History did not load" reason={err} retry={load} /></Card>;
  if (!items) return <LoadingState rows={4} />;
  if (!items.length) return <Card><EmptyState title="Nothing has changed yet" body="Changes to these records show here as people make them." /></Card>;
  return (
    <View className="gap-s2">
      <Card flush>{items.map((c, i) => <View key={c.key}>{i ? <Divider /> : null}<Row title={c.title} sub={c.sub} /></View>)}</Card>
      {more ? <Text size="caption" tone="muted">There are older changes. They are not shown here.</Text> : <Text size="caption" tone="label">{admin ? "Sealed values are never shown, only that they changed." : "You see changes to the records you may read."}</Text>}
    </View>
  );
}
