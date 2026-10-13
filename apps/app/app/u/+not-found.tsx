import { View } from "react-native";
import { Link, usePathname } from "expo-router";
import { Text } from "@vyre/ui";

/** Any /u route that is not a page: say so, with a way home, never the splash. */
export default function NotFound() {
  const path = usePathname();
  return (
    <View accessibilityLabel="Page not found" style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
      <Text size="title" strong>This page doesn't exist</Text>
      <Text tone="muted">{`Nothing lives at ${path}.`}</Text>
      <Link href={"/u" as never}><Text strong tone="accent">Go home</Text></Link>
    </View>
  );
}
