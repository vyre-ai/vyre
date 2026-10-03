import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, EmptyState, Text, showToast } from "@vyre/ui";
import { Block, DiffBlock, Page, Section } from "../places/Page";
import { flowsRepo } from "./data";
import { useFlowsState } from "./store";

export default function KitUpdateScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { updated, update } = useFlowsState();
  const u = flowsRepo.kitUpdate(id ?? "");
  if (!u) return <Page scope={false} title="Kits" back={{ label: "Kits", to: "/u/kits" }}><EmptyState title="No update for that Kit" body="It is up to date, or it is not installed." action={{ label: "Open Kits", onPress: () => router.push("/u/kits" as never) }} /></Page>;
  return (
    <Page scope={false} back={{ label: "Kits", to: "/u/kits" }} title={`Update: ${u.name}`} sub={`v${u.from} to v${u.to}`}>
      <DiffBlock lines={u.diff} />
      <View className="gap-s2">
        <Block label="What changes for people">{u.people.map((p) => <Text key={p}>{p}</Text>)}</Block>
        <Block label="Simulated on last month"><Text>{u.sim}</Text></Block>
      </View>
      <Section title="What it can do that it could not before">
        <Card><View className="gap-s2">{u.widenings.map((w) => <View key={w.part} className="gap-s1"><Text strong>{w.part}</Text><Text tone="muted">{w.what}</Text></View>)}</View></Card>
      </Section>
      <View className="flex-row flex-wrap items-center gap-s2">
        {updated ? <Chip tone="ok">{`Updated to v${u.to}`}</Chip> : <Button kind="primary" label={`Update to v${u.to}`} onPress={() => { update(); showToast(`Updated to v${u.to}.`); }} />}
        <Button kind="ghost" label={updated ? "Back to Kits" : "Not now"} onPress={() => router.push("/u/kits" as never)} />
      </View>
    </Page>
  );
}
