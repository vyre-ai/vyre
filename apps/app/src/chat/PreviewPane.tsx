// A preview open in Vyre (R031-22): a column beside the chat on a computer, a full-screen sheet on a phone. It asks the box for a one-time address made for a frame (previews.url with embed), shows the page, and has
// the few things a pane needs: Reload (a new sign-in), Open in browser, Close. Nothing about the page is changed. If the page does not come up, it says so in words and offers the log.
import { useCallback, useEffect, useState } from "react";
import { Modal, Platform, Linking, View } from "react-native";
import { Button, IconButton, Text, allowsMock, useUiTheme } from "@vyre/ui";
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
  // the sample world has no box: a stand-in page, so the pane can be seen as it looks with a real one
  const SAMPLE_PAGE = "data:text/html;base64," + (typeof btoa === "function" ? btoa('<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#faf9f6;color:#171716"><div style="background:#1f3a5f;color:#fff;padding:18px 24px;font-weight:600;font-size:20px">Juniper Studio</div><main style="max-width:520px;margin:0 auto;padding:28px 20px"><h1 style="font-size:28px;margin:0 0 4px">Tell us about your case</h1><p style="color:#6a675f;margin:0 0 20px">It takes about two minutes.</p><input placeholder="Your name" style="display:block;width:100%;box-sizing:border-box;padding:12px;border:1px solid #dcd9d1;border-radius:8px;margin-bottom:12px;font:inherit"><input placeholder="Date of the incident" style="display:block;width:100%;box-sizing:border-box;padding:12px;border:1px solid #dcd9d1;border-radius:8px;margin-bottom:12px;font:inherit"><input placeholder="Phone" style="display:block;width:100%;box-sizing:border-box;padding:12px;border:1px solid #dcd9d1;border-radius:8px;margin-bottom:18px;font:inherit"><button style="background:#4b3fcf;color:#fff;border:0;border-radius:24px;padding:12px 28px;font:inherit;font-weight:600">Send it</button></main>') : "");
  const load = useCallback(async () => {
    setProblem(""); setSrc(null);
    if (allowsMock()) { setSrc(SAMPLE_PAGE); return; }
    try { setSrc((await tool<{ url: string }>("previews.url", { id, embed: true })).url); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "It did not open."); }
  }, [id, SAMPLE_PAGE]);
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
