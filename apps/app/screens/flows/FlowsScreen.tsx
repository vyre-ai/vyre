import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Menu, Card, Divider, EmptyState, GroupedList, IconTile, Row, Switch, Text, allowsMock, flowSentence } from "@vyre/ui";
import { RealFlows } from "./RealFlows";
import { Frame } from "../places/Frame";
import { usePhone } from "../places/Page";
import { inScope, useScope } from "../places/scope";
import { flowsRepo } from "./data";
import { useFlowsState } from "./store";
import { triggerIcon } from "./logic.js";
// @ts-ignore a plain .js module
import { SAMPLE_OPTIONS } from "./starters.js";
import { whenDo } from "./sentence.js";

type Item = { id: string; name: string; sentence: string; group?: string; waiting?: boolean; icon: "card" | "board" | "clock" | "flows" };

function SampleFlowsScreen() {
  const router = useRouter();
  const phone = usePhone();
  const { applied, off, setOn, installed, made, groups, groupOf, setGroups } = useFlowsState();
  const scope = useScope((s) => s.scope);
  // Every sample Flow belongs to Juniper Studio. A real source says which space each one is in.
  const kit = inScope(scope, "juniper") ? [...(applied ? [flowsRepo.engineerFlow()] : []), ...flowsRepo.flows()] : [];
  const items: Item[] = inScope(scope, "juniper") ? [
    ...made.map((m): Item => ({ id: m.id, name: m.draft.name, sentence: flowSentence(m.draft, SAMPLE_OPTIONS), group: groupOf[m.id], icon: "flows" })),
    ...kit.map((f): Item => ({ id: f.id, name: f.name, sentence: whenDo(f.trigger, f.steps.map((s) => s.label)), group: groupOf[f.id], waiting: f.id === "engagement", icon: triggerIcon(f) })),
  ] : [];
  const row = (f: Item, i: number) => (
    <View key={f.id}>{i ? <Divider inset={68} /> : null}
      <Row onPress={() => router.push(`/u/flows/${f.id}` as never)} lead={<IconTile size={40} name={f.icon} />} title={<Text strong numberOfLines={3}>{f.sentence}</Text>}
        sub={<View className="gap-s1"><Text size="secondary" tone="label" numberOfLines={1}>{f.name}</Text>{f.waiting ? <View className="flex-row items-center gap-s2"><View className="rounded-full bg-accent" style={{ height: 6, width: 6 }} /><Text size="secondary" tone="accent" numberOfLines={1}>Waiting on you</Text></View> : null}</View>}
        chevron={f.waiting}
        end={f.waiting ? undefined : <Switch label={`${f.name} is ${off[f.id] ? "off" : "on"}`} on={!off[f.id]} onChange={(on) => setOn(f.id, on)} />} />
    </View>
  );
  return (
    <Frame title="Flows" sub="Jobs Vyre does on its own. When something happens, it follows the steps: make a record, start a project, hand work to an agent." scope>
      <View className="flex-row">
        <Menu align="start" trigger={<Button kind="primary" size="lg" icon="plus" label="New flow" />} items={[{ label: "Build it here", onPress: () => router.push("/u/flows/new" as never) }, { label: "Ask @Engineer to write it", onPress: () => router.push("/u/engineer" as never) }]} />
      </View>
      {!items.length ? <Card><EmptyState title="No Flows in Mine" body="Flows live in a space. Make one, ask @Engineer, or install a Kit." /></Card> : (
        <GroupedList groups={groups} items={items} itemNoun="Flows" addLabel="Add a group"
          onChange={(n) => setGroups(n.groups, { ...groupOf, ...Object.fromEntries(n.items.map((x) => [x.id, x.group ?? ""])) })}
          renderItems={(xs) => <Card flush>{xs.map(row)}</Card>} />
      )}
      <Card flush>
        <Row dense onPress={() => router.push("/u/kits" as never)} lead={<IconTile name="kits" />} title="Kits" state={`${installed.length} installed`} chevron />
      </Card>
    </Frame>
  );
}

/** The sample list in a mock build; the vyred's own Flows everywhere else. */
export default function FlowsScreen() {
  return allowsMock() ? <SampleFlowsScreen /> : <RealFlows />;
}
