import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Divider, Row, SectionLabel, Text } from "@vyre/ui";
import { visibleNeeds } from "../../src/state/answers";
import { useHidden, useNeeds } from "../../src/state/needs";
import type { Need } from "../../src/state/needs";
import { useGap, useSetupBanner } from "../../src/state/setup-gap";

/** What is missing on this device (no Vyre to talk to, or no phone to approve), as one banner with the one action. */
export function GapNotice() {
  const router = useRouter();
  const setup = useSetupBanner();
  const gap = useGap() ?? setup;
  if (!gap) return null;
  return (
    <Banner tone="warn">
      <View className="gap-s2">
        <Text strong>{gap.title}</Text>
        <Text>{gap.line}</Text>
        <View className="flex-row"><Button size="sm" label={gap.action} onPress={() => router.push(gap.route as never)} /></View>
      </View>
    </Banner>
  );
}

/** The assistants' open asks and the Gate's held items, oldest first: a row opens the ask in its session or the item's page. */
export function WaitingOnYou() {
  const router = useRouter();
  const items = visibleNeeds(useNeeds(), useHidden());
  if (!items.length) return null;
  const open = (n: Need) => {
    if (n.source === "ask" && n.thread) router.push({ pathname: "/session/[id]", params: { id: n.thread, ask: n.ref } });
    else router.push({ pathname: "/need/[id]", params: { id: n.id } });
  };
  return (
    <View className="gap-s1">
      <SectionLabel>Waiting on you</SectionLabel>
      <Card flush>
        {items.map((n, i) => (
          <View key={n.id}>{i ? <Divider /> : null}
            <Row dense title={n.title} sub={[n.agent, n.project].filter(Boolean).join(" · ") || n.detail} end={<Chip tone="accent">{n.source === "gate" && n.kind === "send" ? "Send" : "Needs you"}</Chip>} onPress={() => open(n)} />
          </View>
        ))}
      </Card>
    </View>
  );
}
