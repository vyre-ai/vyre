import { useEffect, useState } from "react";
import { Linking, Platform, Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, EmptyState, IconTile, Text, useUiTheme } from "@vyre/ui";
import type { IconName } from "@vyre/ui";
import { columnsFor, tileWidth } from "./grid.js";
import { Page } from "../places/Frame";
import { tool } from "../../src/real/box";

/** A tile on the Apps place. `route` is where it opens; a tile with no route says what it is waiting for. */
type Tile = { id: string; label: string; sub: string; icon: IconName; route?: string; waiting?: string };
/** An app's own web screen, as appmods.screens lists it for a running app. Opening it asks appmods.open for a one-time address on the app's own origin. */
type AppScreen = { module: string; id: string; label: string; path: string; icon?: string };

/**
 * Vyre-native screens, drawn with the Vyre UI library. Where an app has one, the Apps place opens it; the app's own origin is only the fallback
 * for screens that have no Vyre version (appmods.open, labelled "Opens in <app>'s own editor").
 */
const NATIVE: Record<string, string> = { documents: "/u/documents" };

/** Built-in tiles: the Documents app's three tabs (Vyre-native), and the Flows and Playbooks screens (flow6 and rec6b build those; these tiles only open them). */
const BUILT: Tile[] = [
  { id: "drafting", icon: "edit", label: "Drafting", sub: "Documents made from Word templates", route: "/u/documents?tab=made" },
  { id: "signing", icon: "send", label: "Signing", sub: "Requests, reminders and the signed copies", route: "/u/documents?tab=waiting" },
  { id: "templates", icon: "file", label: "Templates", sub: "Word and signing templates and what each asks for", route: "/u/documents?tab=templates" },
  { id: "flows", icon: "flows", label: "Flows", sub: "Steps that run for you", route: "/u/flows" },
  { id: "playbooks", icon: "list", label: "Playbooks", sub: "Repeatable ways of working", route: "/u/playbooks" },
  { id: "agents", icon: "agents", label: "Agents", sub: "Who works on this Space, and what each can do", route: "/u/agents" },
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
  // One list of tiles: the built-in apps, the other installed apps, and each screen an app offers. Equal tiles in a grid; the whole tile opens, there is no Open button.
  const others = (installed ?? []).filter((a) => !BUILT.some((b) => b.id === a.name));
  const tiles: { key: string; icon: IconName; label: string; sub: string; open?: () => void }[] = [
    ...BUILT.map((t) => ({ key: t.id, icon: t.icon, label: t.label, sub: stateOf(t.id) ? `${t.sub}. ${stateOf(t.id) === "running" ? "Running" : "Stopped"}.` : t.sub, open: t.route ? () => router.push(t.route as any) : undefined })),
    ...others.map((a) => ({ key: `app:${a.name}`, icon: "box" as IconName, label: a.name, sub: a.state === "running" ? "Running" : "Stopped" })),
    ...screens.map((sc) => { const native = nativeOf(sc); return { key: `${sc.module}:${sc.id}`, icon: "box" as IconName, label: sc.label, sub: native ? "Vyre screen" : `Opens in ${sc.label}'s own editor`, open: () => (native ? router.push(native as any) : openScreen(sc)) }; }),
  ];
  const [width, setWidth] = useState(0);
  const cols = columnsFor(width);
  const w = tileWidth(width, cols, GAP);
  return (
    <Page title="Apps" top sub={undefined}>
      <View className="gap-3" onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
          {tiles.map((t) => <AppTile key={t.key} icon={t.icon} label={t.label} sub={t.sub} width={w} onPress={t.open} />)}
          <AppTile dashed icon="plus" label="Make an app" sub="Describe it and the Engineer builds it" width={w} onPress={() => router.push("/u/engineer" as any)} />
        </View>
        {SHOW_CATALOG ? <Button kind="secondary" label="Browse apps" onPress={() => setBrowse((b) => !b)} /> : null}
        {SHOW_CATALOG && browse ? (
          <Card>
            <EmptyState title="The app catalog" body="The catalog lists the apps this Space can add." />
          </Card>
        ) : null}
      </View>
    </Page>
  );
}

const GAP = 12;

/** One app: an icon in a soft square, the name and one line. The whole tile is the button (hover and press lift it); a tile with no way to open is plain. `dashed` is the make-one tile at the end. */
function AppTile({ icon, label, sub, width, onPress, dashed }: { icon: IconName; label: string; sub: string; width: number | string; onPress?: () => void; dashed?: boolean }) {
  const { color } = useUiTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? `${label}. ${sub}` : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed, hovered }: any) => ({ width: width as any, minHeight: 112, padding: 16, gap: 12, borderRadius: 14, borderWidth: 1, borderStyle: dashed ? "dashed" : "solid", borderColor: dashed ? color["edge-strong"] : color.edge, backgroundColor: pressed ? "var(--press)" : hovered && onPress ? "var(--hover)" : color["surface-2"] })}
    >
      <IconTile name={icon} size={40} />
      <View style={{ gap: 2 }}>
        <Text strong numberOfLines={1}>{label}</Text>
        <Text size="caption" tone="muted" numberOfLines={2}>{sub}</Text>
      </View>
    </Pressable>
  );
}
