import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, EmptyState, LoadingState, Row, SectionLabel, Text, useStore } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
// @ts-ignore a plain .js module
import { emailQuery, boardColumns, automationsOf } from "./kind-panes.js";

/** The client of a For a client project: the linked Records contact, its fields, and a way to the record. */
export function ClientPane({ client }: { client: string }) {
  const store = useStore();
  const router = useRouter();
  const [rec, setRec] = useState<any | null | undefined>(undefined);
  useEffect(() => { if (!client) { setRec(null); return; } Promise.resolve(store.get(client)).then((r: any) => setRec(r ?? null)).catch(() => setRec(null)); }, [client, store]);
  if (!client) return <EmptyState title="No client yet" body="Link a company or person in Records to this project, and their details show here." />;
  if (rec === undefined) return <LoadingState rows={2} />;
  if (!rec) return <EmptyState title="That client is not here" body="The record may have been removed, or you may not be able to see it." />;
  const d = rec.data ?? {};
  const facts = [["Email", d.email], ["Phone", d.phone], ["Company", d.company && (d.company.name ?? d.company)], ["Place", d.place ?? d.city]].filter(([, v]) => typeof v === "string" && v);
  return (
    <Card>
      <View className="gap-s3">
        <Text size="page" strong>{String(d.name ?? d.title ?? rec.id)}</Text>
        {facts.map(([k, v]) => <Row key={String(k)} title={String(k)} sub={String(v)} />)}
        <View className="self-start"><Button kind="secondary" size="sm" label="Open in Records" onPress={() => router.push(`/u/records/contact/${rec.id}` as never)} /></View>
      </View>
    </Card>
  );
}

/** The mail to and from the client's addresses (mail.search, as the person), newest first. */
export function EmailsPane({ client }: { client: string }) {
  const store = useStore();
  const [state, setState] = useState<{ q: string | null; rows: any[] | null; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const rec: any = client ? await Promise.resolve(store.get(client)).catch(() => null) : null;
      const q = emailQuery(rec?.data);
      if (!q) { if (live) setState({ q: null, rows: [] }); return; }
      const r = await callT<{ messages: any[] }>("mail.search", { q, limit: 25 });
      if (live) setState(r.error ? { q, rows: null, error: r.error.message } : { q, rows: r.data?.messages ?? [] });
    })();
    return () => { live = false; };
  }, [client, store]);
  if (!state) return <LoadingState rows={3} />;
  if (state.q === null) return <EmptyState title="No email address for this client" body="Add one to their record in Records, and their emails show up here." />;
  if (state.rows === null) return <EmptyState title="Emails did not load" body={state.error ?? "Mail could not be searched."} />;
  if (!state.rows.length) return <EmptyState title="No emails yet" body="Mail to or from this client shows up here." />;
  return <Card flush>{state.rows.map((m) => <Row key={String(m.id)} title={String(m.subject || "(no subject)")} sub={`${String(m.from ?? "")}${m.snippet ? ` · ${String(m.snippet)}` : ""}`} />)}</Card>;
}

/** An Ongoing project's board: its tasks in To do, Doing and Done. */
export function BoardPane({ tasks }: { tasks: any[] }) {
  const cols = boardColumns(tasks) as { id: string; label: string; tasks: any[] }[];
  if (!tasks.length) return <EmptyState title="Nothing on the board yet" body="Ask in the project's chat, and the work you agree on lands here." />;
  return (
    <View className="flex-row items-start gap-s3">
      {cols.map((c) => (
        <View key={c.id} className="min-w-0 flex-1 gap-s2">
          <SectionLabel>{`${c.label} · ${c.tasks.length}`}</SectionLabel>
          {c.tasks.map((t) => <Card key={t.id}><Text numberOfLines={2}>{String(t.title)}</Text></Card>)}
        </View>
      ))}
    </View>
  );
}

/** "Runs on its own": the Flows the project's stages turn on. */
export function FlowsPane({ snapshot }: { snapshot: string }) {
  const router = useRouter();
  const list = automationsOf(snapshot) as { flow: string; when: string; note?: string }[];
  if (!list.length) return <EmptyState title="Nothing runs here on its own yet" body="Ask in the project's chat for a Flow, like a follow-up that sends when a lead comes in, and it shows here." />;
  return <Card flush>{list.map((a) => <Row key={`${a.flow}:${a.when}`} title={a.flow.replace(/_/g, " ")} sub={a.when === "start" ? "Runs when the project starts" : `Runs in ${a.when}${a.note ? `, ${a.note}` : ""}`} onPress={() => router.push(`/u/flow/${a.flow}` as never)} />)}</Card>;
}
