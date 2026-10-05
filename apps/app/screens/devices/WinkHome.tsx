import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Card, Row, Switch, Text, showToast, type IconName, IconTile } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useDevices } from "./state";

const VERBS: { id: string; icon: IconName; title: string; body: string; href: string }[] = [
  { id: "add", icon: "plus", title: "Add", body: "A phone or a computer of yours. The new device types the code your phone shows.", href: "/u/wink/add" },
  { id: "invite", icon: "share", title: "Invite", body: "Someone to a space. They read one card and tap Join.", href: "/u/wink/invite" },
  { id: "lend", icon: "laptop", title: "Share a computer", body: "Lend a computer to a space. One card, two yeses: the space allows it and you allow it.", href: "/u/wink/lend" },
];

/** Wink: the one way anything joins. Three verbs, one setting. */
export function WinkHome() {
  const router = useRouter();
  const { faster, setFaster } = useDevices();
  return (
    <Page title="Wink" sub="The one way anything joins. Scan a code or paste a long one, then confirm the same three words on both screens." back="/u/settings">
      <View className="flex-row flex-wrap gap-s3">
        {VERBS.map((v) => (
          <Card key={v.id} className="min-w-menu flex-1 gap-s2">
            <Row lead={<IconTile name={v.icon} size={40} />} title={v.title} onPress={() => router.push(v.href as never)} className="px-0" />
            <Text tone="muted">{v.body}</Text>
          </Card>
        ))}
      </View>
      <Card><Row title="Make it faster" sub="Let your devices talk to each other directly when they can. Vyre works the same either way." end={<Switch label="Make it faster" on={faster} onChange={(v) => { setFaster(v); showToast(v ? "Direct connections are on." : "Direct connections are off."); }} />} /></Card>
      <Text size="caption" tone="label">That is the only connection setting. Nothing about addresses, routes or keys.</Text>
    </Page>
  );
}
