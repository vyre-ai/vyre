// The Connect apps screen on sample data, for the owner to look at before anything is wired: Add signs in at once (a short pause, then Connected), Set up asks for what the row needs first, and a connected
// app's button opens Share with... and Disconnect. Nothing here reaches a server. The real screen will read mcp.catalog and call connectors.connect (team/0.6/RESEARCH-mcp-catalog.md, B11).
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Card, ConnectApps, SAMPLE_CONNECT_GRANTEES, SetupSheet, ShareSheet, sampleConnectApps, useUiTheme, type ConnectApp } from "@vyre/ui";

export default function ConnectAppsPreview() {
  const { color } = useUiTheme();
  const [apps, setApps] = useState<ConnectApp[]>(() => sampleConnectApps() as ConnectApp[]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [setup, setSetup] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const patch = (id: string, over: Partial<ConnectApp>) => setApps((all) => all.map((a) => (a.id === id ? { ...a, ...over } : a)));
  const connect = (a: ConnectApp) => { patch(a.id, { busy: true }); setTimeout(() => patch(a.id, { busy: false, state: "connected", shares: [] }), 700); };
  const add = (a: ConnectApp) => (a.state === "setup" ? setSetup(a.id) : connect(a));
  const find = (id: string | null) => apps.find((a) => a.id === id) ?? null;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: color.bg }} contentContainerStyle={{ alignItems: "center", padding: 24 }}>
      <View style={{ width: "100%", maxWidth: 640 }}>
        <Card>
          <ConnectApps apps={apps} query={query} onQuery={setQuery} category={category} onCategory={setCategory} onAdd={add}
            menuOf={(a) => [{ label: "Share with...", onPress: () => setSharing(a.id) }, { label: "Disconnect", danger: true, onPress: () => patch(a.id, { state: "one-tap", shares: [] }) }]} />
        </Card>
      </View>
      <SetupSheet app={find(setup)} open={setup !== null} onClose={() => setSetup(null)} onDone={(a) => { setSetup(null); connect(a); }} />
      <ShareSheet app={find(sharing)} grantees={SAMPLE_CONNECT_GRANTEES} open={sharing !== null} onClose={() => setSharing(null)} onChange={(shares) => sharing && patch(sharing, { shares })} />
    </ScrollView>
  );
}
