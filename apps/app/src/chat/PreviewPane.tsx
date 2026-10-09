// A preview open in Vyre (R031-22): a column beside the chat on a computer, a full-screen sheet on a phone. It asks the box for a one-time address made for a frame (previews.url with embed), shows the page, and has
// the few things a pane needs: Reload (a new sign-in), Open in browser, Close. Nothing about the page is changed. If the page does not come up, it says so in words and offers the log.
import { useCallback, useEffect, useState } from "react";
import { Modal, Platform, Linking, View } from "react-native";
import { Button, IconButton, Text, useUiTheme } from "@vyre/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tool } from "../real/box";
import { PreviewFrame } from "./PreviewFrame";
import { closePreview, usePreviewPane } from "./previewPane";

export function PreviewPane({ phone }: { phone: boolean }) {
  const open = usePreviewPane();
  if (!open) return null;
  return phone ? <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={closePreview}><Inner id={open.id} title={open.title} phone /></Modal> : <Inner id={open.id} title={open.title} phone={false} />;
}

function Inner({ id, title, phone }: { id: string; title: string; phone: boolean }) {
  const { color } = useUiTheme();
  const inset = useSafeAreaInsets();
  const [src, setSrc] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [n, setN] = useState(0);
  const load = useCallback(async () => {
    setProblem(""); setSrc(null);
    try { setSrc((await tool<{ url: string }>("previews.url", { id, embed: true })).url); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "It did not open."); }
  }, [id]);
  useEffect(() => { void load(); }, [load, n]);
  const browser = async () => { try { const u = (await tool<{ url: string }>("previews.url", { id })).url; if (Platform.OS === "web") window.open(u, "_blank", "noopener"); else void Linking.openURL(u); } catch (e) { setProblem(e instanceof Error && e.message ? e.message : "It did not open."); } };
  return (
    <View accessibilityLabel={`${title}, open`} style={phone ? { flex: 1, backgroundColor: color["surface-1"], paddingTop: inset.top, paddingBottom: inset.bottom } : { flex: 1.1, minWidth: 360, borderLeftWidth: 1, borderLeftColor: color.edge, backgroundColor: color["surface-1"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 52, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: color.edge }}>
        <Text strong numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{title}</Text>
        <IconButton icon="refresh" label="Reload" onPress={() => setN((x) => x + 1)} />
        <IconButton icon="external" label="Open in browser" onPress={browser} />
        <IconButton icon="x" label="Close" onPress={closePreview} />
      </View>
      <View style={{ flex: 1 }}>
        {src ? <PreviewFrame key={`${id}-${n}`} src={src} title={title} />
          : <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
              <Text tone={problem ? "default" : "label"} style={{ textAlign: "center" }}>{problem || "Opening"}</Text>
              {problem ? <Button kind="ghost" size="sm" label="Try again" onPress={() => setN((x) => x + 1)} /> : null}
            </View>}
      </View>
    </View>
  );
}
