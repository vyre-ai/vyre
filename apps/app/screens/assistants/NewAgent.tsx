// New assistant: a name, its projects, its job, what it runs on and whether it gets its own computer (the Deck's New agent form, ported).
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Divider, Field, LoadingState, Row, Segmented, Switch, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { agent } from "./agent";
import { NEW_FORM, createInput, type NewAgentForm } from "./agent-model.ts";

export default function NewAgent() {
  const router = useRouter();
  const [f, setF] = useState<NewAgentForm>(NEW_FORM);
  const [projects, setProjects] = useState<{ slug: string; name: string }[] | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { agent.projects().then((p) => { setProjects(p); setF((x) => ({ ...x, hasProjects: p.length > 0 })); }).catch(() => setProjects([])); }, []);
  const set = (p: Partial<NewAgentForm>) => setF((x) => ({ ...x, ...p }));
  const toggle = (slug: string) => set({ projects: f.projects.includes(slug) ? f.projects.filter((s) => s !== slug) : [...f.projects, slug] });
  const submit = () => {
    const r = createInput(f);
    if ("problem" in r) { setProblem(r.problem); return; }
    setBusy(true); setProblem("");
    agent.create(r.input as Record<string, unknown> & { name: string }).then(({ made, computerError }) => {
      if (computerError) showToast(`${made.name} was made, but not given a computer: ${computerError}`);
      router.replace(`/u/settings/assistants/${encodeURIComponent(made.name)}` as never);
    }).catch((e) => setProblem(e instanceof Error ? e.message : "That did not go through.")).finally(() => setBusy(false));
  };
  return (
    <Page title="New assistant" back="/u/settings/assistants">
      <Card className="gap-s3">
        <Field label="Name" value={f.name} onChangeText={(name) => set({ name })} placeholder="for example rex" help="Lowercase, one word. It signs its threads with it." />
        <Field label="Job" value={f.instructions} onChangeText={(instructions) => set({ instructions })} multiline lines={3} placeholder="What it does, and what it must ask you before doing." />
      </Card>
      <Card flush>
        <View className="p-s3"><Text strong>Works in</Text></View>
        {projects === null ? <LoadingState rows={2} /> : null}
        {projects && !projects.length ? <View className="p-s3"><Text tone="muted">No projects yet. It will see none until you add some.</Text></View> : null}
        {(projects || []).map((p) => <View key={p.slug}><Divider /><Row title={p.name} end={<Switch label={p.name} on={f.projects.includes(p.slug)} onChange={() => toggle(p.slug)} />} /></View>)}
      </Card>
      <Card className="gap-s2">
        <Text strong>Runs on</Text>
        <Segmented label="Runs on" value={f.runsOn} onChange={(runsOn) => set({ runsOn })} options={[["subscription", "Your Claude plan"], ["key", "An API key with a budget"]]} />
        {f.runsOn === "key" ? <Field label="Monthly budget in dollars" kind="number" value={f.budget} onChangeText={(budget) => set({ budget })} help="It stops when the budget is spent." /> : <Text size="caption" tone="label">Uses your plan. The token stays in the Vault.</Text>}
      </Card>
      <Card flush><Row title="Its own computer" sub="A desktop from the pool that you can watch, or take over." end={<Switch label="Its own computer" on={f.computer} onChange={(computer) => set({ computer })} />} /></Card>
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      <View className="flex-row"><Button label="Create" disabled={busy} onPress={submit} /></View>
    </Page>
  );
}
