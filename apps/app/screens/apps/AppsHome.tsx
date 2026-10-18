import { useEffect, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, EmptyState, Text } from "@vyre/ui";
import { Page } from "../places/Frame";
import { tool } from "../../src/real/box";

/** A tile on the Apps place. `route` is where it opens; a tile with no route says what it is waiting for. */
type Tile = { id: string; label: string; sub: string; route?: string; waiting?: string };
/** An app's own web screen, as appmods.screens lists it for a running app. Opening it asks appmods.open for a one-time address on the app's own origin. */
type AppScreen = { module: string; id: string; label: string; path: string; icon?: string };

/** Built-in tiles: the Documents app, its PDF converter, and the Flows and Playbooks screens (flow6 and rec6b build those screens; these tiles only open them). */
const BUILT: Tile[] = [
  { id: "documents", label: "Documents", sub: "Drafting, signing and templates", route: "/u/documents" },
  { id: "pdf", label: "PDF converter", sub: "Used by Documents", route: "/u/documents?tab=templates" },
  { id: "flows", label: "Flows", sub: "Steps that run for you", route: "/u/flows" },
  { id: "playbooks", label: "Playbooks", sub: "Repeatable ways of working", route: "/u/playbooks" },
];

/**
 * Apps: one place for the apps on this Space. Tiles come from appmods.list (an app's state shows on its tile) and the built-in apps above.
 * "Make an app" opens the Engineer; "Browse apps" lists what the app catalog has, pinned and checked.
 */
export function AppsHome() {
  const router = useRouter();
  const [installed, setInstalled] = useState<{ name: string; state?: string }[] | null>(null);
  const [browse, setBrowse] = useState(false);
  const [screens, setScreens] = useState<AppScreen[]>([]);
  useEffect(() => {
    tool<{ apps?: { name: string; state?: string }[] }>("appmods.list")
      .then((r) => setInstalled(r?.apps ?? []))
      .catch(() => setInstalled([]));
    tool<{ screens?: AppScreen[] }>("appmods.screens")
      .then((r) => setScreens(r?.screens ?? []))
      .catch(() => setScreens([]));
  }, []);
  /** Opens an app's own screen: the app answers a one-time address on its own origin, which opens in the browser or a new tab. */
  const openScreen = (sc: AppScreen) => {
    tool<{ url?: string }>("appmods.open", { name: sc.module, screen: sc.id })
      .then((r) => {
        if (!r?.url) return;
        if (Platform.OS === "web") window.open(r.url, "_blank", "noopener");
        else void Linking.openURL(r.url);
      })
      .catch(() => {});
  };
  const stateOf = (name: string) => installed?.find((a) => a.name === name)?.state;
  return (
    <Page title="Apps" top sub={undefined}>
      <View className="gap-3">
        <View className="flex-row flex-wrap gap-3">
          {BUILT.map((t) => (
            <Card key={t.id}>
              <Text strong>{t.label}</Text>
              <Text size="caption" tone="muted">{t.sub}</Text>
              {stateOf(t.id) ? <Text size="caption" tone="label">{stateOf(t.id) === "running" ? "Running" : "Stopped"}</Text> : null}
              {t.route ? (
                <Button kind="secondary" label="Open" onPress={() => router.push(t.route as any)} />
              ) : (
                <Text size="caption" tone="label">{t.waiting}</Text>
              )}
            </Card>
          ))}
        </View>
        {installed && installed.filter((a) => !BUILT.some((b) => b.id === a.name)).length ? (
          <View className="flex-row flex-wrap gap-3">
            {installed.filter((a) => !BUILT.some((b) => b.id === a.name)).map((a) => (
              <Card key={a.name}>
                <Text strong>{a.name}</Text>
                <Text size="caption" tone="label">{a.state === "running" ? "Running" : "Stopped"}</Text>
              </Card>
            ))}
          </View>
        ) : null}
        <View className="flex-row gap-3">
          <Button kind="primary" label="Make an app" onPress={() => router.push("/u/engineer" as any)} />
          <Button kind="secondary" label="Browse apps" onPress={() => setBrowse((b) => !b)} />
        </View>
        {screens.length ? (
          <View className="flex-row flex-wrap gap-3">
            {screens.map((sc) => (
              <Card key={`${sc.module}:${sc.id}`}>
                <Text strong>{sc.label}</Text>
                <Text size="caption" tone="muted">{sc.module}</Text>
                <Button kind="secondary" label="Open" onPress={() => openScreen(sc)} />
              </Card>
            ))}
          </View>
        ) : null}
        {browse ? (
          <Card>
            <EmptyState title="The app catalog" body="Open-source apps, pinned to an exact version and checked. The catalog lists them when it is installed on this Space." />
          </Card>
        ) : null}
      </View>
    </Page>
  );
}
