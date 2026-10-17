// A Flow's saved test cases, over tools that already exist: flows.test.list, flows.test.run, flows.test.save (from a run) and flows.test.remove.
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, Field, Row, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { callT as call } from "../../src/real/call-tool";
import { caseWords, testsSource } from "./tests-source";
import type { Case, Outcome, Result } from "./tests-source";

/** The saved cases of one Flow: run them all, remove one (hold), and keep a run as a new case. `runId` is the run being looked at, when there is one. */
export function FlowTests({ id, runId }: { id: string; runId?: string }) {
  const src = useMemo(() => testsSource(call), []);
  const [cases, setCases] = useState<Case[] | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    src.list(id).then((c) => { if (live) setCases(c); });
    return () => { live = false; };
  }, [id, n, src]);
  const act = async (f: () => Promise<Outcome>, after?: () => void) => {
    setBusy(true);
    try {
      const o = await f();
      if (o.message) showToast(o.message);
      if (o.result !== undefined) setResult(o.result);
      if (o.refresh) { after?.(); setN((x) => x + 1); }
    } finally { setBusy(false); }
  };
  return (
    <Sec title="Tests">
      {cases === null ? <Text tone="muted">Reading the tests...</Text> : cases.length ? (
        <Card flush>
          {cases.map((c, i) => (
            <View key={c.name}>{i ? <Divider /> : null}
              <Row dense title={c.name} sub={caseWords(c)} end={<Button kind="hold" size="sm" label="Remove" disabled={busy} onPress={() => act(() => src.remove(id, c.name))} />} />
            </View>
          ))}
        </Card>
      ) : <Card><EmptyState title="No tests yet" body="Keep a run as a test. Vyre runs every saved test before a new version of this Flow is proposed, and stops the proposal if one fails." /></Card>}
      {cases && cases.length ? <View className="self-start pt-s2"><Button size="sm" label={busy ? "Running" : "Run the tests"} disabled={busy} onPress={() => act(() => src.run(id))} /></View> : null}
      {result ? <Banner><Text strong>{result.summary ?? ""}</Text>{(result.lines ?? []).map((l, i) => <Text key={i} size="secondary" tone="muted">{l}</Text>)}</Banner> : null}
      {runId ? (
        <View className="gap-s2 pt-s2">
          <Field label="Keep this run as a test" value={name} onChangeText={setName} placeholder="A name (optional)" help="The test starts the Flow the way this run started and checks it does the same." />
          <View className="flex-row"><Button kind="ghost" size="sm" label="Keep as a test" disabled={busy} onPress={() => act(() => src.keep(id, runId, name), () => setName(""))} /></View>
        </View>
      ) : null}
    </Sec>
  );
}
