// A Flow's saved test cases, over tools that already exist: flows.test.list, flows.test.run, flows.test.save (from a run) and flows.test.remove.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, Field, Row, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { callT as call } from "../../src/real/call-tool";

type Case = { name: string; event?: unknown; input?: unknown };
type Result = { ok?: boolean; summary?: string; lines?: string[] };

/** What a case starts from, in a few words. */
export const caseWords = (c: Case): string => (c.event ? "Starts from an event" : "Starts from a form or a button");

/** The saved cases of one Flow: run them all, remove one, and keep a run as a new case. `runId` is the run being looked at, when there is one. */
export function FlowTests({ id, runId }: { id: string; runId?: string }) {
  const [cases, setCases] = useState<Case[] | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    call<{ cases?: Case[] }>("flows.test.list", { id }).then((r) => { if (live) setCases(r.error ? [] : (r.data?.cases ?? [])); });
    return () => { live = false; };
  }, [id, n]);
  const act = async (f: () => Promise<{ error?: { message: string } } | void>, done?: string) => {
    setBusy(true);
    try { const r = await f(); if (r && r.error) showToast(r.error.message); else { if (done) showToast(done); setN((x) => x + 1); } } finally { setBusy(false); }
  };
  const run = () => act(async () => { const r = await call<Result>("flows.test.run", { id }); if (!r.error) setResult(r.data ?? null); return r; });
  const keep = () => act(async () => { const r = await call("flows.test.save", { id, from_run: runId, ...(name.trim() ? { name: name.trim() } : {}) }); if (!r.error) setName(""); return r; }, "Kept as a test.");
  const remove = (c: Case) => act(() => call("flows.test.remove", { id, name: c.name }), "Removed.");
  return (
    <Sec title="Tests">
      {cases === null ? <Text tone="muted">Reading the tests...</Text> : cases.length ? (
        <Card flush>
          {cases.map((c, i) => (
            <View key={c.name}>{i ? <Divider /> : null}
              <Row dense title={c.name} sub={caseWords(c)} end={<Button kind="ghost" size="sm" label="Remove" disabled={busy} onPress={() => remove(c)} />} />
            </View>
          ))}
        </Card>
      ) : <Card><EmptyState title="No tests yet" body="Keep a run as a test, and Vyre checks every later version of this Flow against it before it is approved." /></Card>}
      {cases && cases.length ? <View className="self-start pt-s2"><Button size="sm" label={busy ? "Running" : "Run the tests"} disabled={busy} onPress={run} /></View> : null}
      {result ? <Banner><Text strong>{result.summary ?? ""}</Text>{(result.lines ?? []).map((l, i) => <Text key={i} size="secondary" tone="muted">{l}</Text>)}</Banner> : null}
      {runId ? (
        <View className="gap-s2 pt-s2">
          <Field label="Keep this run as a test" value={name} onChangeText={setName} placeholder="A name (optional)" help="The test starts the Flow the way this run started and checks it does the same." />
          <View className="flex-row"><Button kind="ghost" size="sm" label="Keep as a test" disabled={busy} onPress={keep} /></View>
        </View>
      ) : null}
    </Sec>
  );
}
