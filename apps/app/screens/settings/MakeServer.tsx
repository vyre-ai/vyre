import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Text } from "@vyre/ui";
import { shell } from "../../src/shell/shell";
import { SERVER_SETUP_ROUTE } from "../install/first-run.js";

/** In the Mac app only: make this Mac the server for My Cloud. One line says what that means, the press is the person's choice (never automatic), and the setup it starts is the same as /u/setup/server. */
export function MakeServer() {
  const router = useRouter();
  const make = shell()?.identity?.makeServer;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  if (!make) return null;
  const go = async () => {
    setBusy(true); setProblem("");
    try { await shell()?.identity?.makeServer?.(); router.push(SERVER_SETUP_ROUTE as never); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That did not start."); }
    finally { setBusy(false); }
  };
  return (
    <Card>
      <View className="gap-s2 p-s2">
        <Text strong>Make this Mac a server</Text>
        <Text tone="muted">This Mac must stay on. It will run Records for My Cloud.</Text>
        {problem ? <Text tone="err">{problem}</Text> : null}
        <View className="flex-row"><Button kind="secondary" label="Make this Mac a server" loading={busy} onPress={go} /></View>
      </View>
    </Card>
  );
}
