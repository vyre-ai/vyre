// Settings, Apps: the modules installed on this Space (appmods.list). The old Apps grid is a different page.
import { View } from "react-native";
import { Card, Divider, EmptyState, ErrorState, LoadingState, Row } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useKept } from "../../src/state/kept";
import { tool } from "../../src/real/box";

type AppRow = { name: string; state?: string };

export function AppsScreen() {
  const k = useKept<AppRow[]>("apps", async () => {
    const r = await tool<{ apps?: AppRow[] }>("appmods.list");
    return r?.apps ?? [];
  }, "Apps did not answer.");
  const apps = k.data;
  return (
    <Page title="Apps" sub="The modules installed on this Space." back="/u/settings">
      {k.err ? <Card flush><ErrorState title="Apps did not load" reason={k.err} retry={k.reload} /></Card> : null}
      {!apps && !k.err ? <LoadingState rows={3} /> : null}
      {apps && !apps.length ? <Card><EmptyState title="No apps installed" body="Modules you add to this Space show up here." /></Card> : null}
      {apps && apps.length ? (
        <Card flush>
          {apps.map((a, i) => <View key={a.name}>{i ? <Divider /> : null}<Row dense title={a.name} sub={a.state === "running" ? "Running" : a.state === "stopped" || a.state === "failed" ? "Stopped" : "Installed"} /></View>)}
        </Card>
      ) : null}
    </Page>
  );
}
