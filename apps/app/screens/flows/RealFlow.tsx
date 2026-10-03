// One Flow from the real vyred: its canvas, the version waiting for approval (with the kernel's card and a real Face ID or fingerprint), and its runs painted over the canvas.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { AskCard, Banner, Button, Card, Chip, Divider, EmptyState, FlowCanvas, Row, Text, haptic, showToast } from "@vyre/ui";
import { Block } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { approveReal, cardReal, getReal, graphReal, runReal, runsReal, type Card as FlowCard, type Graph, type RunRow } from "./real";

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const STATE: Record<string, { note: string; tone: "accent" | "ok" | "warn" | "plain" }> = {
  waiting: { note: "Waiting on someone", tone: "accent" }, running: { note: "Running", tone: "accent" }, done: { note: "Done", tone: "ok" }, failed: { note: "Failed", tone: "warn" },
};

export function RealFlow({ id }: { id: string }) {
  const router = useRouter();
  const [g, setG] = useState<Graph | null>(null);
  const [meta, setMeta] = useState<{ version: number; hash: string; status: string } | null>(null);
  const [card, setCard] = useState<FlowCard | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [painted, setPainted] = useState<any[] | null>(null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [graph, m, rs] = await Promise.all([graphReal(id), getReal(id), runsReal(id)]);
        if (!live) return;
        setG(graph); setMeta({ version: m.version, hash: m.hash, status: m.status }); setRuns(rs);
        if (m.status !== "approved") setCard(await cardReal(id, m.version));
      } catch (e) { if (live) setErr(e instanceof Error ? e.message : "Flows did not answer."); }
    })();
    return () => { live = false; };
  }, [id, n]);

  useEffect(() => {
    if (!runId) { setPainted(null); return; }
    runReal(runId).then((r) => setPainted(r.painted?.nodes ?? null)).catch(() => setPainted(null));
  }, [runId]);

  if (err) return <Frame title="Flows" back="/u/flows"><EmptyState title="Flows did not answer" body={err} action={{ label: "Try again", onPress: () => { setErr(""); setN((x) => x + 1); } }} /></Frame>;
  if (!g || !meta) return <Frame title="Flows" back="/u/flows"><EmptyState title="Loading" body="Asking your Vyre." /></Frame>;
  const nodes = painted ?? g.nodes;
  const node = nodes.find((x) => x.id === picked);
  const waiting = meta.status !== "approved";

  const approve = async () => {
    setBusy(true);
    try { await approveReal(id, meta.version, meta.hash); haptic.approve(); showToast("Approved. This version can run."); setN((x) => x + 1); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not work."); }
    finally { setBusy(false); }
  };

  return (
    <Frame back="/u/flows" title={id} sub={`${g.trigger} · v${meta.version}`}>
      <Card flush><FlowCanvas nodes={nodes} edges={g.edges} selected={picked} onSelect={(x) => setPicked(x === picked ? undefined : x)} /></Card>
      {node ? <Card title={node.kind === "trigger" ? "How it starts" : "This step"}><View className="gap-s1"><Text strong>{node.label}</Text>{node.note ? <Text tone="muted">{node.note}</Text> : null}</View></Card> : null}
      {g.warnings?.length ? <Banner tone="warn"><View className="gap-s1">{g.warnings.map((w) => <Text key={w}>{w}</Text>)}</View></Banner> : null}
      {waiting && card ? (
        <Sec title="Waiting for your approval">
          <AskCard title={`Approve version ${card.version}`} why={card.changes.length ? card.changes.join(" ") : "Nothing runs until you approve this exact version."}
            actions={[{ label: busy ? "Approving" : "Approve with Face ID", kind: "primary", icon: "faceid", onPress: busy ? () => {} : approve }]} />
          <Block label="See as code">{card.text}</Block>
        </Sec>
      ) : null}
      <Sec title="Run history">
        {runs.length ? (
          <Card flush>
            {runs.map((r, i) => {
              const s = STATE[r.state] ?? { note: r.state, tone: "plain" as const };
              return (
                <View key={r.id}>{i ? <Divider /> : null}
                  <Row selected={runId === r.id} onPress={() => setRunId(runId === r.id ? undefined : r.id)} title={`Run ${r.id.slice(0, 8)}`} sub={`Started ${when(r.started_at)}.${r.error?.message ? ` ${r.error.message}` : ""}`} end={<Chip tone={s.tone}>{s.note}</Chip>} />
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
