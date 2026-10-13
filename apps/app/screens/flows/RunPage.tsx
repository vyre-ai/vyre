// One run as a page of its own (/u/flows/<flow>/runs/<run>): who it is about, which version ran and who approved it, and every step down a timeline. Tap a step for what went in, what came out,
// the error in words, its tries, when a wait wakes, and who it waits on.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, EmptyState, ErrorState, LoadingState, Row, Text } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { tool } from "../../src/real/box";
import { approverName } from "../sites/real-model";
import { dayTimeOf } from "../../src/time/show.js";
import { callT } from "../../src/real/call-tool";
import { getReal, runReal, runsReal, explainReal } from "./real";
import { ExplainCard } from "./ExplainCard";
import { RunSteps } from "./RunSteps";
import { canRetry, retryLimits, runHeader, threadOf } from "./run-model";
import { retryReal } from "./run";
import { explainText, shrunkNote, titleOf } from "./real-model.js";

const when = (ms: number | null | undefined) => (ms ? dayTimeOf(ms) : "");

export function RunPage({ flow, run }: { flow: string; run: string }) {
  const router = useRouter();
  // names and the viewer come from records.actors and records.me, as Sites History does
  const [actors, setActors] = useState<unknown>(null);
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => { tool("records.actors", {}).then(setActors).catch(() => setActors(null)); tool<{ person?: string }>("records.me", {}).then((r) => setMe(r?.person ?? null)).catch(() => setMe(null)); }, []);
  const name = (id: string) => approverName(actors, id.replace(/^person:/, ""), me);
  const [d, setD] = useState<{ run: any; painted: any[] | null; def: any; title: string; approver: unknown; number: number | null; explain: string } | null>(null);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  const [threads, setThreads] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [r, f, rs, ex] = await Promise.all([runReal(run), getReal(flow), runsReal(flow).catch(() => []), explainReal(run).catch(() => null)]);
        if (!live) return;
        const ids = [...new Set(Object.values(r.run?.steps ?? {}).map((e: any) => e?.task || e?.wait?.task).filter((x): x is string => typeof x === "string"))];
        Promise.all(ids.map(async (id) => [id, threadOf((await callT<any>("tasks.get", { id })).data)] as const)).then((rows) => { if (live) setThreads(Object.fromEntries(rows.filter(([, t]) => t))); }).catch(() => {});
        const i = rs.findIndex((x) => x.id === run);
        setD({ run: r.run, painted: r.painted?.nodes ?? null, def: f.flow ?? null, title: titleOf(f.flow, flow), approver: f.approver, number: i >= 0 && rs.length < 20 ? rs.length - i : null, explain: explainText(ex) });
      } catch (e) { if (live) setErr(e instanceof Error ? e.message : "That run did not load."); }
    })();
    return () => { live = false; };
  }, [flow, run, n]);
  const back = `/u/flows/${flow}`;
  if (err) return <Frame title="Run" back={back}><ErrorState title="That run did not load" reason={err} retry={() => { setErr(""); setN((x) => x + 1); }} /></Frame>;
  if (!d) return <Frame title="Run" back={back}><LoadingState rows={3} /></Frame>;
  const h = runHeader(d.run, { fmt: when, title: d.title, number: d.number, approver: d.approver && typeof (d.approver as any).id === "string" ? name((d.approver as any).id) : "", record: d.run?.trigger?.event?.subject });
  const shrunk = shrunkNote(d.run);
  return (
    <Frame back={back} title={h.title} sub={h.sub}>
      <Card>
        <View className="gap-s2">
          <View className="flex-row items-center gap-s2"><Chip tone={h.tone}>{h.status}</Chip>{h.started ? <Text size="secondary" tone="muted">{h.started}</Text> : null}</View>
          {h.approver ? <Text size="secondary" tone="muted">{h.approver}</Text> : null}
          {h.recordId ? <View className="self-start"><Button kind="ghost" size="sm" label="Open the record" onPress={() => router.push(`/u/record/${encodeURIComponent(h.recordId)}` as never)} /></View> : null}
        </View>
      </Card>
      {d.explain ? <ExplainCard text={d.explain} /> : null}
      {d.run?.cancelled?.reason ? <Banner><Text>{`This run was stopped: ${d.run.cancelled.reason}.`}</Text></Banner> : null}
      <Sec title="Step by step">
        {shrunk ? <Card><Row dense title={shrunk} sub="Its step-by-step details were cleared after the days the Space keeps them (Settings, Flows)." /></Card>
          : d.painted ? <Card flush><RunSteps rail painted={d.painted} steps={d.run?.steps} max={retryLimits(d.def)} fmt={when} name={name} threads={threads} openThread={(t) => router.push(`/u/chats/${encodeURIComponent(t)}` as never)} /></Card>
          : <Card><EmptyState title="No steps to show" body="This run has no record of its steps." /></Card>}
        {canRetry(d.run?.state) ? <View className="self-start pt-s2"><Button size="sm" label={busy ? "Retrying" : "Retry this run"} disabled={busy} onPress={async () => { setBusy(true); try { await retryReal(run); setN((x) => x + 1); } finally { setBusy(false); } }} /></View> : null}
      </Sec>
    </Frame>
  );
}
