import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Text } from "@vyre/ui";
import { shell } from "../../src/shell/shell";
import { SERVER_SETUP_ROUTE } from "../install/first-run.js";

/**
 * In the Mac app only: make this Mac the server for My Cloud. One line says what that means. The press only opens the server setup (/u/setup/server); the Mac becomes a server (identity.makeServer)
 * at the end of that flow, after the person has seen what it means and confirmed, so a half-finished setup never leaves it in server mode. Never automatic.
 */
export function MakeServer() {
  const router = useRouter();
  if (!shell()?.identity?.makeServer) return null;
  return (
    <Card>
      <View className="gap-s2 p-s2">
        <Text strong>Make this Mac a server</Text>
        <Text tone="muted">This Mac must stay on. It will run Records for My Cloud.</Text>
        <View className="flex-row"><Button kind="secondary" label="Make this Mac a server" onPress={() => router.push(SERVER_SETUP_ROUTE as never)} /></View>
      </View>
    </Card>
  );
}
