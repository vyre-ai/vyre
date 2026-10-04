import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, EmptyState, Text, allowsMock, showToast } from "@vyre/ui";
import { Block, DiffBlock } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { flowsRepo } from "./data";
import { useFlowsState } from "./store";

function SampleKitUpdateScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { updated, update } = useFlowsState();
  const u = flowsRepo.kitUpdate(id ?? "");
  if (!u) return <Frame title="Kits" back="/u/kits"><EmptyState title="No update for that Kit" body="It is up to date, or it is not installed." action={{ label: "Open Kits", onPress: () => router.push("/u/kits" as never) }} /></Frame>;
  return (
    <Frame back="/u/kits" title={`Update: ${u.name}`} sub={`v${u.from} to v${u.to}`}>
      <DiffBlock lines={u.diff} />
      <View className="gap-s2">
        <Block label="What changes for people">{u.people.map((p) => <Text key={p}>{p}</Text>)}</Block>
        <Block label="Simulated on last month"><Text>{u.sim}</Text></Block>
      </View>
      <Sec title="What it can do that it could not before">
        <Card><View className="gap-s2">{u.widenings.map((w) => <View key={w.part} className="gap-s1"><Text strong>{w.part}</Text><Text tone="muted">{w.what}</Text></View>)}</View></Card>
      </Sec>
      <View className="flex-row flex-wrap items-center gap-s2">
        {updated ? <Chip tone="ok">{`Updated to v${u.to}`}</Chip> : <Button kind="primary" label={`Update to v${u.to}`} onPress={() => { update(); showToast(`Updated to v${u.to}.`); }} />}
        <Button kind="ghost" label={updated ? "Back to Kits" : "Not now"} onPress={() => router.push("/u/kits" as never)} />
      </View>
    </Frame>
  );
}

/** The sample update in a mock build. On a real box there is no Kit library to offer an update from, so the page says so. */
export default function KitUpdateScreen() {
  const router = useRouter();
  if (allowsMock()) return <SampleKitUpdateScreen />;
  return <Frame title="Kits" back="/u/kits"><EmptyState title="No update for that Kit" body="This box has no Kit library to offer updates from." action={{ label: "Open Kits", onPress: () => router.push("/u/kits" as never) }} /></Frame>;
}
