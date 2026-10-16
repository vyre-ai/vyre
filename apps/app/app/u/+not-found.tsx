import { View } from "react-native";
import { Link, Redirect, usePathname } from "expo-router";
import { oldRouteTarget } from "../../src/shell/old-routes.js";
import { Text } from "@vyre/ui";

/** Any /u route that is not a page: an old first-run address goes to the first run (src/shell/old-routes.js); anything else says so, with a way home, never the splash. */
export default function NotFound() {
  const path = usePathname();
  const old = oldRouteTarget(path);
  if (old) return <Redirect href={old as never} />;
  return (
    <View accessibilityLabel="Page not found" style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
      <Text size="title" strong>This page doesn't exist</Text>
      <Text tone="muted">{`Nothing lives at ${path}.`}</Text>
      <Link href={"/u" as never}><Text strong tone="accent">Go home</Text></Link>
    </View>
  );
}
