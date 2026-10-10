// One Flow from the real vyred: its canvas, the version waiting for approval (with the kernel's card and a real Face ID or fingerprint), and its runs painted over the canvas.
import { dayTimeOf } from "../../src/time/show.js";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { AskCard, Banner, Button, Card, Chip, Divider, EmptyState, FlowCanvas, Row, Text, haptic, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { Block } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { FlowCode } from "./FlowCode";
import { effectLines } from "./engineer-model";
import { retryReal, startReal } from "./run";
import { ExplainCard } from "./ExplainCard";
import { canRetry, recordLines, startRefusal } from "./run-model";
import { approveReal, cardReal, getReal, graphReal, explainReal, healthReal, runReal, runsReal, type Card as FlowCard, type Graph, type RunRow } from "./real";
import { APPROVE_LABEL, explainText, healthBanner, shownWarnings, shrunkNote, titleOf, versionWaits } from "./real-model.js";

const when = (ms: number | null) => (ms ? dayTimeOf(ms) : "");
const STATE: Record<string, { note: string; tone: "accent" | "ok" | "warn" | "plain" }> = {
  waiting: { note: "Waiting on someone", tone: "accent" }, running: { note: "Running", tone: "accent" }, done: { note: "Done", tone: "ok" }, failed: { note: "Failed", tone: "warn" },
};

export function RealFlow({ id }: { id: string }) {
  const router = useRouter();
  const [g, setG] = useState<Graph | null>(null);
  const [meta, setMeta] = useState<{ version: number; hash: string; status: string; approver: unknown; title: string } | null>(null);
  const [card, setCard] = useState<FlowCard | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [painted, setPainted] = useState<any[] | null>(null);
  const [shrunk, setShrunk] = useState<string | null>(null);
  const [explain, setExplain] = useState("");
  const [health, setHealth] = useState<{ level: string; line: string } | null>(null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [graph, m, rs, hl] = await Promise.all([graphReal(id), getReal(id), runsReal(id), healthReal(id).catch(() => null)]);
        if (!live) return;
        setHealth(hl);
        setG(graph); setMeta({ version: m.version, hash: m.hash, status: m.status, approver: m.approver, title: titleOf(m.flow, id) }); setRuns(rs.filter((r) => !r.parent));
        if (versionWaits(m)) setCard(await cardReal(id, m.version));
      } catch (e) { if (live) setErr(e instanceof Error ? e.message : "Flows did not answer."); }
    })();
    return () => { live = false; };
  }, [id, n]);

  useEffect(() => {
    if (!runId) { setPainted(null); setShrunk(null); setExplain(""); return; }
    explainReal(runId).then((d) => setExplain(explainText(d))).catch(() => setExplain(""));
    runReal(runId).then((r) => { setPainted(r.painted?.nodes ?? null); setShrunk(shrunkNote(r.run)); }).catch(() => { setPainted(null); setShrunk(null); });
  }, [runId]);

  if (err) return <Frame title="Flows" back="/u/flows"><ErrorState title="Flows did not load" reason={err} retry={() => { setErr(""); setN((x) => x + 1); }} /></Frame>;
  if (!g || !meta) return <Frame title="Flows" back="/u/flows"><LoadingState rows={3} /></Frame>;
  const nodes = painted ?? g.nodes;
  const node = nodes.find((x) => x.id === picked);
  const waiting = versionWaits(meta);

  const approve = async () => {
    setBusy(true);
    try { await approveReal(id, meta.version, meta.hash); haptic.approve(); showToast("Approved. This version can run."); setN((x) => x + 1); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not work."); }
    finally { setBusy(false); }
  };

  const runNow = async () => {
    setBusy(true);
    try { const r = await startReal(id, `app-${id}-${Date.now()}`); showToast("Started."); setN((x) => x + 1); if (r.id || r.run) setRunId(r.id ?? r.run); }
    catch (e) { showToast(startRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "")); }
    finally { setBusy(false); }
  };
  const retry = async (run: string) => {
    setBusy(true);
    try { await retryReal(run); showToast("Retrying."); setN((x) => x + 1); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not work."); }
    finally { setBusy(false); }
  };
  const picked_run = runs.find((r) => r.id === runId);
  const hb = healthBanner(health);

  return (
    <Frame back="/u/flows" title={meta.title} sub={`${g.trigger} · v${meta.version}`}>
      {hb && hb.tone !== "quiet" ? <Banner tone={hb.tone}><Text>{hb.text}</Text></Banner> : null}
      <Card flush><FlowCanvas nodes={nodes} edges={g.edges} selected={picked} onSelect={(x) => setPicked(x === picked ? undefined : x)} /></Card>
      {node ? <Card title={node.kind === "trigger" ? "How it starts" : "This step"}><View className="gap-s1"><Text strong>{node.label}</Text>{node.note ? <Text tone="muted">{node.note}</Text> : null}</View></Card> : null}
      {shownWarnings(g.warnings).length ? <Banner tone="warn"><View className="gap-s1">{shownWarnings(g.warnings).map((w, i) => <Text key={i}>{w}</Text>)}</View></Banner> : null}
      {waiting && card ? (
        <Sec title="Waiting for your approval">
          <AskCard title={`Approve version ${card.version}`} why={card.changes.length ? card.changes.join(" ") : "Nothing runs until you approve this exact version."}
            actions={[{ label: busy ? "Approving" : APPROVE_LABEL, kind: "primary", icon: "check", onPress: busy ? () => {} : approve }]} />
          {effectLines(card.effects).length ? <Block label="What it does">{effectLines(card.effects).join("\n")}</Block> : null}
          <Block label="See as code">{card.text}</Block>
        </Sec>
      ) : null}
      {hb && hb.tone === "quiet" ? <Text tone="muted">{hb.text}</Text> : null}
      {!waiting ? <View className="self-start"><Button kind="primary" size="sm" icon="play" label={busy ? "Starting" : "Run now"} disabled={busy} onPress={runNow} /></View> : null}
      {painted && picked_run ? (
        <Sec title={`What the run of ${when(picked_run.started_at)} did`}>
          <ExplainCard text={explain} />
          <Card flush>
            {shrunk ? <Row dense title={shrunk} sub="Its step-by-step details were cleared after the days the Space keeps them (Settings, Flows)." /> : recordLines(painted).map((l, i) => <View key={l.id}>{i ? <Divider /> : null}<Row dense title={l.title} sub={l.sub} /></View>)}
          </Card>
          {canRetry(picked_run.state) ? <View className="self-start pt-s2"><Button size="sm" label={busy ? "Retrying" : "Retry this run"} disabled={busy} onPress={() => retry(picked_run.id)} /></View> : null}
        </Sec>
      ) : null}
      <FlowCode id={id} version={meta.version} onSaved={() => setN((x) => x + 1)} />
      <Sec title="Run history">
        {runs.length ? (
          <Card flush>
            {runs.map((r, i) => {
              const s = STATE[r.state] ?? { note: r.state, tone: "plain" as const };
              return (
                <View key={r.id}>{i ? <Divider /> : null}
                  <Row selected={runId === r.id} onPress={() => setRunId(runId === r.id ? undefined : r.id)} title={`Run of ${when(r.started_at)}`} sub={r.error?.message || undefined} end={<Chip tone={s.tone}>{s.note}</Chip>} />
                </View>
              );
            })}
          </Card>
        ) : <Card><EmptyState title="Not run yet" body="It runs the next time what starts it happens." /></Card>}
      </Sec>
      <View className="self-start"><Button kind="ghost" size="sm" label="Back to Flows" onPress={() => router.push("/u/flows" as never)} /></View>
    </Frame>
  );
}
