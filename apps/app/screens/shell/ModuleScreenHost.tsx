import { useEffect, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { createElement } from "react";
import { Banner, Button, Text } from "@vyre/ui";
import { Page } from "../places/Frame";
import { tool } from "../../src/real/box";
import { useSidebar } from "./sidebar";
import { openHow, screenUrl, withTicket } from "./module-screen.js";

/**
 * A module's screen, from the sidebar. It lives on the module's own origin: the app asks the box for a one-time ticket that signs this person in there, then shows the page in the main pane
 * where the platform can embed it (a browser, the Mac and Windows windows) and in a new window where it cannot. Until the box can give a ticket (no app-module host on it) the plain address is used.
 */
export function ModuleScreenHost({ module, screen }: { module: string; screen: string }) {
  const { modules, loaded } = useSidebar();
  const plain = screenUrl(modules as never, module, screen);
  const label = modules.find((m) => m.module === module)?.screens.find((s) => s.id === screen)?.label ?? screen;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    if (!plain) return;
    let live = true;
    tool<unknown>("appmods.ticket", { module, screen }).then((a) => withTicket(plain, a)).catch(() => plain).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [plain, module, screen]);
  const how = openHow(Platform.OS);
  useEffect(() => { if (url && how === "window") Linking.openURL(url).catch((e) => setFailed(e instanceof Error ? e.message : "The window did not open.")); }, [url, how]);
  if (!loaded) return <Page title={label} back="/u/now"><Text tone="muted">Loading.</Text></Page>;
  if (!plain) return <Page title={label} back="/u/now"><Banner>This screen is not available here yet. Its module may not be installed on this server, or the server has not given it an address.</Banner></Page>;
  if (how === "pane") {
    return (
      <View className="min-h-0 flex-1">
        {url ? createElement("iframe", { src: url, title: label, style: { border: 0, width: "100%", height: "100%" }, referrerPolicy: "no-referrer", allow: "clipboard-write" }) : <Text tone="muted">Opening {label}.</Text>}
      </View>
    );
  }
  return (
    <Page title={label} back="/u/now">
      {failed ? <Banner tone="warn">{failed}</Banner> : <Text tone="muted">{`${label} opened in a new window.`}</Text>}
      {url ? <View className="flex-row"><Button label="Open it again" onPress={() => { void Linking.openURL(url); }} /></View> : null}
    </Page>
  );
}
