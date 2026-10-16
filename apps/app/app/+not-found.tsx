import { Text, View } from "react-native";
import { Link, Redirect, usePathname } from "expo-router";
import { oldRouteTarget } from "../src/shell/old-routes.js";
import { typeStyle } from "../ui/theme-vars.js";

// Plain, no theme (it can render before the app's theme is up), so the sizes come from the type scale, not from numbers typed here.
const TITLE = typeStyle("title", "web", false, { strong: true });
const BODY = typeStyle("body", "web", false);

/** Any route outside /u that is not a page: an old first-run or pairing address goes to the first run (src/shell/old-routes.js). */
export default function NotFound() {
  const old = oldRouteTarget(usePathname());
  if (old) return <Redirect href={old as never} />;
  return (
    <View accessibilityLabel="Page not found" style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
      <Text style={TITLE}>This page doesn't exist</Text>
      <Link href={"/u" as never}><Text style={[BODY, { textDecorationLine: "underline" }]}>Go home</Text></Link>
    </View>
  );
}
