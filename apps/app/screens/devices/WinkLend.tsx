import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Card, Chip, Divider, EmptyState, Row } from "@vyre/ui";
import { Page } from "../shell/Page";
import { useDevices } from "./state";

/** Share a computer: pick the computer, then its page holds the card with two yeses. */
export function WinkLend() {
  const router = useRouter();
  const computers = useDevices((s) => s.items).filter((i) => i.device === "computer");
  return (
    <Page title="Share a computer" sub="Lend a computer to a space. The space allows it and you allow it." back="/u/wink">
      <Card flush>
        {computers.length ? computers.map((c, i) => (
          <View key={c.id}>{i ? <Divider /> : null}<Row lead={<Avatar name={c.name} family="device" size="lg" icon="laptop" />} title={c.name} sub={`Last used ${c.last}`} end={<Chip>Computer</Chip>} onPress={() => router.push(`/u/settings/device/${c.id}` as never)} /></View>
        )) : <EmptyState title="No computers yet" body="Add a computer first, then share it." />}
      </Card>
    </Page>
  );
}
