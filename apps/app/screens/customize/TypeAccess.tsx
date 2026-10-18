import { useEffect, useState } from "react";
import { View } from "react-native";
import { Card, Divider, EmptyState, ErrorState, LoadingState, Row, SectionLabel, Segmented, Select, Text, useRecordsWorld } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { useRoles } from "../roles/state";
import { useSidebar } from "../shell/sidebar";
import { accessRows, holderRows, tabRefusal } from "./type-tabs.js";

/** A type's Access tab: my part in it, what each role may do with it, who holds its roles (a role type only), and the record as a person or their assistant sees it. */
export function TypeAccess({ type, label }: { type: string; label: string }) {
  const { world, error, reload } = useRoles();
  const admin = useSidebar((s) => s.canSetDefault);
  const { data: records } = useRecordsWorld();
  const rows = records?.byType[type] ?? [];
  const [holders, setHolders] = useState<ReturnType<typeof holderRows> | null>(null);
  const [who, setWho] = useState<"person" | "assistant">("person");
  const [urn, setUrn] = useState("");
  const [seen, setSeen] = useState<{ data?: Record<string, unknown> | null; error?: string } | null>(null);
  // Only a role type has holders; the box refuses any other type, and then there is nothing to show.
  useEffect(() => { void callT<{ rows?: any[] }>("records.holders", { role: type }).then((r) => setHolders(r.error ? null : holderRows(r.data?.rows ?? []))).catch(() => setHolders(null)); }, [type]);
  useEffect(() => { if (!urn && rows[0]) setUrn(String(rows[0].urn ?? rows[0].id ?? "")); }, [rows.length]);
  useEffect(() => {
    if (!urn) { setSeen(null); return; }
    setSeen(null);
    void callT<{ data?: Record<string, unknown> | null }>("records.sees-as", { urn, who }).then((r) => setSeen(r.error ? { error: tabRefusal(r.error.code, r.error.message) } : { data: r.data?.data ?? null })).catch(() => setSeen({ error: tabRefusal() }));
  }, [urn, who]);
  if (error && !world) return <Card flush><ErrorState title="Roles did not load" reason={error} retry={reload} /></Card>;
  if (!world) return <LoadingState rows={3} />;
  const lines = accessRows(world.roles, type);
  return (
    <View className="gap-s3">
      <SectionLabel first>You</SectionLabel>
      <Card><Text>{admin ? `You are an owner or an admin: you can change ${label.toLowerCase()} and read who changed them.` : `You are a member: you see ${label.toLowerCase()} as your role allows, below.`}</Text></Card>
      <SectionLabel>Roles</SectionLabel>
      <Card flush>
        {lines.map((l, i) => <View key={l.id}>{i ? <Divider /> : null}<Row title={l.name} sub={l.sub} end={<Text tone={l.level === "No access" ? "muted" : undefined}>{l.level}</Text>} /></View>)}
      </Card>
      <Text size="caption" tone="label">Change what a role may do in Settings, Roles.</Text>
      {holders ? (
        <>
          <SectionLabel>Who holds it</SectionLabel>
          {holders.length ? <Card flush>{holders.map((h, i) => <View key={h.urn}>{i ? <Divider /> : null}<Row title={h.id} sub={h.stage || undefined} /></View>)}</Card> : <Card><EmptyState title="Nobody holds it yet" /></Card>}
        </>
      ) : null}
      <SectionLabel>See it as</SectionLabel>
      {rows.length ? (
        <Card className="gap-s3">
          <Segmented label="See it as" value={who} onChange={(v) => setWho(v as "person" | "assistant")} options={[["person", "You"], ["assistant", "Your assistant"]]} />
          <Select label={label} value={urn} options={rows.slice(0, 50).map((r: any) => [String(r.urn ?? r.id), String(r.data?.name ?? r.data?.title ?? r.id)] as [string, string])} onChange={setUrn} />
          {seen?.error ? <Text tone="muted">{seen.error}</Text> : seen?.data ? Object.entries(seen.data).map(([k, v]) => <Row key={k} title={k} sub={typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v)} />) : seen ? <Text tone="muted">Nothing of it is shown to them.</Text> : <LoadingState rows={2} />}
          <Text size="caption" tone="label">Sealed values show only as placeholders. This changes nothing.</Text>
        </Card>
      ) : <Card><EmptyState title={`No ${label.toLowerCase()} to look at yet`} /></Card>}
    </View>
  );
}
