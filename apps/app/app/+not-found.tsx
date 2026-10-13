import { Text, View } from "react-native";
import { Link } from "expo-router";

/** Any route outside /u that is not a page (plain, no theme: it can render before the app's theme is up). */
export default function NotFound() {
  return (
    <View accessibilityLabel="Page not found" style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>This page doesn't exist</Text>
      <Link href={"/u" as never}><Text style={{ fontSize: 16, textDecorationLine: "underline" }}>Go home</Text></Link>
    </View>
  );
}
