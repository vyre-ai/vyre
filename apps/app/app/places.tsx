import { View } from "react-native";
import { Stack, useRouter, type Href } from "expo-router";
import { useTrust } from "../src/state/devices";
import { useGap } from "../src/state/setup-gap";
import { ListRow } from "../src/ui/Row";
import { Screen } from "../src/ui/Screen";

/**
 * The Places sheet, opened from the avatar on Now, Chats and Agents (README layout, under 720):
 * the places you go to. Projects, Planner and Memory join it as they are built.
 */
const PLACES: { title: string; detail: string; href: Href; testID: string }[] = [
  { title: "Vault", detail: "Logins, codes and keys", href: "/vault", testID: "place-vault" },
  { title: "Devices", detail: "How each device reaches the box, and its trust", href: "/devices", testID: "place-devices" },
  { title: "Settings", detail: "This device and the box", href: "/settings", testID: "place-settings" },
];

export default function Places() {
  const router = useRouter();
  const trust = useTrust();
  // What is missing on this device comes first, with the one action that fixes it.
  const gap = useGap();
  return (
    <Screen title="Places" back>
      <Stack.Screen options={{ presentation: "modal" }} />
      <View>
        {gap ? <ListRow testID="place-gap" title={gap.title} meta={`${gap.line} ${gap.action}.`} push onPress={() => router.push(gap.route as never)} /> : null}
        {PLACES.map((p) => (
          <ListRow
            key={p.testID}
            testID={p.testID}
            title={p.title}
            meta={p.title === "Vault" && trust === "untrusted" ? "Names only on this browser" : p.detail}
            push
            onPress={() => router.push(p.href)}
          />
        ))}
      </View>
    </Screen>
  );
}
