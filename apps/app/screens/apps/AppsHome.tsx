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

/**
 * Vyre-native screens, drawn with the Vyre UI library. Where an app has one, the Apps place opens it; the app's own origin is only the fallback
 * for screens that have no Vyre version (appmods.open, labelled "Opens in <app>'s own editor").
 */
const NATIVE: Record<string, string> = { documents: "/u/documents" };

/** Built-in tiles: the Documents app's three tabs (Vyre-native), and the Flows and Playbooks screens (flow6 and rec6b build those; these tiles only open them). */
const BUILT: Tile[] = [
  { id: "drafting", label: "Drafting", sub: "Documents made from Word templates", route: "/u/documents?tab=made" },
  { id: "signing", label: "Signing", sub: "Requests, reminders and the signed copies", route: "/u/documents?tab=waiting" },
  { id: "templates", label: "Templates", sub: "Word and signing templates and what each asks for", route: "/u/documents?tab=templates" },
  { id: "flows", label: "Flows", sub: "Steps that run for you", route: "/u/flows" },
  { id: "playbooks", label: "Playbooks", sub: "Repeatable ways of working", route: "/u/playbooks" },
  { id: "agents", label: "Agents", sub: "Who works on this Space, and what each can do", route: "/u/agents" },
];

/**
 * Apps: one place for the apps on this Space. Tiles come from appmods.list (an app's state shows on its tile) and the built-in apps above.
 * "Make an app" opens the Engineer. The app catalog entry point ("Browse apps") is kept behind SHOW_CATALOG, off for now.
 */
export function AppsHome() {
  const router = useRouter();
  const [installed, setInstalled] = useState<{ name: string; state?: string }[] | null>(null);
  const [browse, setBrowse] = useState(false);
  // The catalog entry point stays in the code, off, until the owner turns it on.
  const SHOW_CATALOG = false;
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
  /** A screen is Vyre-native when its app has one, and opens there; otherwise it is the app's own origin, and the tile says so. */
  const nativeOf = (sc: AppScreen) => NATIVE[sc.module];
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
          {SHOW_CATALOG ? <Button kind="secondary" label="Browse apps" onPress={() => setBrowse((b) => !b)} /> : null}
        </View>
        {screens.length ? (
          <View className="flex-row flex-wrap gap-3">
            {screens.map((sc) => {
              const native = nativeOf(sc);
              return (
                <Card key={`${sc.module}:${sc.id}`}>
                  <Text strong>{sc.label}</Text>
                  <Text size="caption" tone="muted">{native ? "Vyre screen" : `Opens in ${sc.label}'s own editor`}</Text>
                  <Button kind="secondary" label="Open" onPress={() => (native ? router.push(native as any) : openScreen(sc))} />
                </Card>
              );
            })}
          </View>
        ) : null}
        {SHOW_CATALOG && browse ? (
          <Card>
            <EmptyState title="The app catalog" body="The catalog lists the apps this Space can add." />
          </Card>
        ) : null}
      </View>
    </Page>
  );
}
