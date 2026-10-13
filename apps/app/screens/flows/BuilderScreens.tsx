// The Flow builder's pages: a new Flow, and a Flow made in the builder. A sample build keeps them in memory; a real one saves with flows.define (a version nobody has approved yet), then opens
// the Flow's own page where its card is approved.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Divider, EmptyState, Field, FlowBuilder, LoadingState, Row, Select, Switch, Text, allowsMock, flowProblems, showToast, flowDefinition, flowFromDefinition } from "@vyre/ui";
import type { FlowDraft, FlowOptions } from "@vyre/ui";
import { Frame, Sec } from "../places/Frame";
import { useFlowsState } from "./store";
import { ShareFlow } from "./FlowShare";
import { useFlowOptions, defineReal } from "./builder-source";

const BLANK: FlowDraft = { name: "", trigger: { kind: "created" }, steps: [] };

function Editor({ id, start, options }: { id: string | null; start: FlowDraft; options: FlowOptions }) {
  const router = useRouter();
  const { saveMade, groups } = useFlowsState();
  const [draft, setDraft] = useState<FlowDraft>(start);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const problems = flowProblems(draft, options);
  const save = async () => {
    setShown(true);
    if (problems.length) return;
    setBusy(true); setErr("");
    try {
      if (allowsMock()) {
        const key = saveMade(id, draft);
        showToast("Saved.");
        router.replace(`/u/flows/${key}` as never);
      } else {
        const key = await defineReal(flowDefinition(draft));
        showToast("Saved. Read the card and approve it to switch it on.");
        router.replace(`/u/flows/${key}` as never);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : "That did not save."); } finally { setBusy(false); }
  };
  return (
    <>
      <Card>
        <View className="gap-s3">
          <Field label="Name" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} placeholder="For example Refund request" />
          {allowsMock() ? <Select label="Group" value={draft.group ?? ""} options={[["", "No group"], ...groups.map((g) => [g.name, g.name] as [string, string])]} onChange={(group) => setDraft({ ...draft, group: group || undefined })} /> : null}
        </View>
      </Card>
      <FlowBuilder draft={draft} onChange={setDraft} options={options} />
      {shown && problems.length ? <Banner tone="warn" icon="warning"><View className="gap-s1">{problems.map((p) => <Text key={p}>{p}</Text>)}</View></Banner> : null}
      {err ? <Banner tone="err">{err}</Banner> : null}
      <View className="flex-row flex-wrap items-center gap-s3">
        <Button kind="primary" size="lg" label={id ? "Save changes" : "Save the Flow"} loading={busy} onPress={save} />
        <Button kind="ghost" size="lg" label="Cancel" onPress={() => router.back()} />
      </View>
      {allowsMock() ? null : <Text size="caption" tone="label">Nothing runs until you read the card and approve it. A step that sends something still asks you each time.</Text>}
    </>
  );
}

export function NewFlowScreen() {
  const options = useFlowOptions();
  return (
    <Frame back="/u/flows" title="New flow" sub="Say when it starts, then add the steps in order.">
      {options ? <Editor id={null} start={BLANK} options={options} /> : <LoadingState rows={3} />}
    </Frame>
  );
}

const RUNS: Record<string, { title: string; started: string }[]> = {
  refund: [{ title: "Refund request from Pat Lopez, $120", started: "Today 10:05" }, { title: "Refund request from Sam Ortiz, $45", started: "Yesterday" }],
  atp: [{ title: "Ridgeway Dental signed up", started: "Mon 12 Oct" }],
};

export function MadeFlowScreen({ id }: { id: string }) {
  const router = useRouter();
  const options = useFlowOptions();
  const { made, off, setOn } = useFlowsState();
  const m = made.find((x) => x.id === id);
  if (!m) return <Frame title="Flows" back="/u/flows"><EmptyState title="That Flow is not here" body="It may have been removed. Open Flows to see what is running." action={{ label: "Open Flows", onPress: () => router.push("/u/flows" as never) }} /></Frame>;
  const runs = RUNS[id] ?? [];
  return (
    <Frame back="/u/flows" title={m.draft.name} sub={m.draft.group ? `In the group ${m.draft.group}` : "Not in a group"}>
      <ShareFlow id={id} options={options} />
      <Card flush><Row dense title="Runs on its own" sub={off[id] ? "Off. Nothing starts it." : "On"} end={<Switch label={`${m.draft.name} is ${off[id] ? "off" : "on"}`} on={!off[id]} onChange={(on) => setOn(id, on)} />} /></Card>
      {options ? <Editor id={id} start={m.draft} options={options} /> : <LoadingState rows={3} />}
      <Sec title="Run history">
        {runs.length ? (
          <Card flush>{runs.map((r, i) => <View key={r.title}>{i ? <Divider /> : null}<Row title={r.title} sub={`Started ${r.started}. Every step is on the record's timeline.`} end={<Chip tone="ok">Done</Chip>} /></View>)}</Card>
        ) : <Card><EmptyState title="Not run yet" body="It runs the next time its trigger happens." /></Card>}
      </Sec>
    </Frame>
  );
}

/** A Flow stored on the box, opened in the builder. Saving writes a new version (the box asks for the person's yes again); steps the builder cannot show are kept as they were. */
export function StoredFlowEditor({ id, flow, onSaved }: { id: string; flow: unknown; onSaved: () => void }) {
  const options = useFlowOptions();
  const [draft, setDraft] = useState<FlowDraft>(() => flowFromDefinition(flow));
  useEffect(() => { setDraft(flowFromDefinition(flow)); }, [flow]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!options) return <LoadingState rows={3} />;
  const problems = flowProblems(draft, options);
  const save = async () => {
    if (problems.length) return;
    setBusy(true); setErr("");
    try { await defineReal(flowDefinition(draft), id); showToast("Saved as a new version. Read the card and approve it to switch it on."); onSaved(); }
    catch (e) { setErr(e instanceof Error ? e.message : "That did not save."); } finally { setBusy(false); }
  };
  return (
    <>
      <ShareFlow id={id} options={options} />
      <FlowBuilder draft={draft} onChange={setDraft} options={options} />
      {problems.length ? <Banner tone="warn" icon="warning"><View className="gap-s1">{problems.map((p) => <Text key={p}>{p}</Text>)}</View></Banner> : null}
      {err ? <Banner tone="err">{err}</Banner> : null}
      <View className="self-start"><Button kind="primary" label="Save changes" loading={busy} disabled={!!problems.length} onPress={save} /></View>
    </>
  );
}
