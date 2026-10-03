import { useMemo, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AskCard, Avatar, Banner, Button, Card, Chip, Divider, EmptyState, FlowCanvas, Row, Text, showToast } from "@vyre/ui";
import { Block, FaceIdSheet, Page, Section } from "../places/Page";
import { flowsRepo, type Def } from "./data";
import { useFlowsState } from "./store";
import { buildGraph, flowCode, paint } from "./logic.js";

export default function FlowScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const applied = useFlowsState((s) => s.applied);
  const f: Def | undefined = [...(applied ? [flowsRepo.engineerFlow()] : []), ...flowsRepo.flows()].find((x) => x.id === id);
  const runs = useMemo(() => flowsRepo.runs(id ?? ""), [id]);
  const [at, setAt] = useState<Record<string, string | null>>({});
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [code, setCode] = useState(false);
  const [face, setFace] = useState(false);
  if (!f) return <Page scope={false} title="Flows" back={{ label: "Flows", to: "/u/flows" }}><EmptyState title="That Flow is not here" body="It may have been removed. Open Flows to see what is running." action={{ label: "Open Flows", onPress: () => router.push("/u/flows" as never) }} /></Page>;

  const graph = buildGraph(f);
  const run = runs.find((r) => r.id === (runId ?? runs[0]?.id));
  const stopAt = run ? (run.id in at ? at[run.id] : run.at) : undefined;
  const nodes = run ? paint(graph.nodes, stopAt ?? null, "waiting", stopAt === "sign" ? "Waiting for Jane Doe's signature" : undefined) : graph.nodes;
  const node = nodes.find((n) => n.id === picked);
  const waitingAsk = run?.id === "r41" && stopAt === "ask";

  return (
    <Page scope={false} back={{ label: "Flows", to: "/u/flows" }} title={f.name}
      sub={`When ${f.trigger.charAt(0).toLowerCase()}${f.trigger.slice(1)} · v${f.v} · ${f.from === "@Engineer" ? "written by @Engineer" : `from the Kit ${f.from}`}`} actions={<Chip tone="ok">{f.state}</Chip>}>
      <Card flush><FlowCanvas nodes={nodes} edges={graph.edges} selected={picked} onSelect={(n) => setPicked(n === picked ? undefined : n)} /></Card>
      {node ? (
        <Card title={node.kind === "trigger" ? "How it starts" : "This step"}>
          <View className="gap-s1"><Text strong>{node.label}</Text>{node.who ? <Text tone="muted">{`Done by ${node.who}`}</Text> : null}{node.note ? <Text tone="muted">{node.note}</Text> : null}</View>
        </Card>
      ) : null}
      <Banner>
        <View className="gap-s1"><Text strong>Simulated on last month</Text><Text size="caption" tone="muted">{flowsRepo.simulation()}</Text></View>
      </Banner>
      {waitingAsk ? (
        <Section title="Run 41, Doe estate plan">
          <AskCard lead={<Avatar name="chris" />} title="Approve the engagement letter, Doe estate plan"
            why="Run 41 is paused at step 1. The letter was written by kit and checked against the intake facts. Nothing is sent until you approve."
            actions={[{ label: "Approve with Face ID", kind: "primary", icon: "faceid", onPress: () => setFace(true) }, { label: "Read the letter", onPress: () => showToast("Opened the letter.") }, { label: "Not now", kind: "ghost", onPress: () => showToast("Declined. The run stops and nothing is sent.") }]} />
        </Section>
      ) : run?.id === "r41" ? (
        <Banner><View className="gap-s1"><Text strong>Approved with Face ID.</Text><Text size="caption" tone="muted">The letter is waiting for Jane Doe's signature. The Flow moves the matter to Drafting when it is signed.</Text></View></Banner>
      ) : null}
      <Section title="Run history">
        {runs.length ? (
          <Card flush>
            {runs.map((r, i) => {
              const state = r.id === "r41" && stopAt === "sign" ? { note: "Waiting for signature", tone: "accent" as const } : { note: r.note, tone: r.tone };
              return (
                <View key={r.id}>{i ? <Divider /> : null}
                  <Row selected={run?.id === r.id} onPress={() => setRunId(r.id)} title={r.title} sub={`Started ${r.started}. Every step is on the record's timeline.`} end={<Chip tone={r.id === "r41" ? state.tone : r.tone}>{r.id === "r41" ? state.note : r.note}</Chip>} />
                </View>
              );
            })}
          </Card>
        ) : <Card><EmptyState title="Not run yet" body="It runs the next time a payment is received." /></Card>}
      </Section>
      <View className="gap-s2">
        <View className="self-start"><Button kind="ghost" size="sm" icon={code ? "chev-d" : "chev-r"} label="See as code" onPress={() => setCode(!code)} /></View>
        {code ? <><Block>{flowCode(f)}</Block><Text size="caption" tone="label">{`Version ${f.v}, ${f.hash}. An approval binds to this exact text.`}</Text></> : null}
      </View>
      <FaceIdSheet open={face} onClose={() => setFace(false)} title="Approve with Face ID" body="The letter goes to Jane Doe for signature. The Flow waits for her to sign." confirm="Approve with Face ID"
        onConfirm={() => { setAt((a) => ({ ...a, r41: "sign" })); showToast("Approved. The letter is out for signature."); }} />
    </Page>
  );
}
