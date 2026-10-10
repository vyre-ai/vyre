// A live preview in the chat (R031-22, team/0.3.1/DESIGN-previews.md): something an agent is running, as one calm card. A poster, the name, one word for its state, and one verb at a time: Open when it is up,
// Restart or "Look at the log" when it is not. No port, no host, no command on the card; the address is asked of the box (previews.url, a one-time sign-in) at the moment the person opens it. Share is a sheet
// with three choices, the way a document is shared. State changes arrive as the chat's own frames (the card is patched in place), and every action asks the box and takes its answer.
import { useState } from "react";
import { Linking, Platform, View } from "react-native";
import { Banner, Button, Chip, Icon, IconButton, Menu, Segmented, Sheet, Text, showToast, useUiTheme } from "@vyre/ui";
import { Image } from "react-native";
import { openPreview } from "./previewPane";
import { usePreviewThumb } from "./usePreviewThumb";
import { tool } from "../real/box";
import { PublishSheet } from "./PreviewPublish";
import { canPublish, previewActions, previewWord, shareWord, lifeWord, SHARE_CHOICES, type PreviewBlock } from "./preview-model.js";

const say = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function PreviewCard({ block, sample }: { block: PreviewBlock; sample?: string }) {
  const { color, phone } = useUiTheme();
  const [now, setNow] = useState<Partial<PreviewBlock> | null>(null);
  const b = { ...block, ...(now ?? {}) } as PreviewBlock;
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(false);
  const [publish, setPublish] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const a = previewActions(b);
  const real = usePreviewThumb(sample ? "00000000" : b.id, b.thumb ?? 0);
  const thumb = sample ?? real;
  const word = previewWord(b.state);

  const run = async (what: () => Promise<unknown>, after?: (r: any) => void) => {
    setBusy(true); setProblem("");
    try { const r = await what(); after?.(r); const p = (r as { preview?: Partial<PreviewBlock> } | null)?.preview; if (p) setNow({ state: p.state, access: p.access, mode: p.mode } as Partial<PreviewBlock>); }
    catch (e) { setProblem(say(e, "That did not work.")); }
    finally { setBusy(false); }
  };
  const showLog = () => run(() => tool<{ log: string }>("previews.log", { id: b.id }), (r) => setLog(String(r.log || "Nothing was printed yet.")));
  const open = () => openPreview({ id: b.id, title: b.title });
  const inBrowser = () => run(() => tool<{ url: string }>("previews.url", { id: b.id }), (r) => { if (Platform.OS === "web") window.open(r.url, "_blank", "noopener"); else void Linking.openURL(r.url); });
  const more = [
    ...(a.open ? [{ label: "Open in browser", onPress: inBrowser }] : []),
    ...(a.keep ? [{ label: "Keep it running", onPress: () => run(() => tool("previews.keep", { id: b.id })) }] : []),
    ...(a.open && a.restart ? [{ label: "Restart", onPress: () => run(() => tool("previews.restart", { id: b.id })) }] : []),
    ...(a.log && a.open ? [{ label: "Look at the log", onPress: showLog }] : a.log && a.restart ? [{ label: "Look at the log", onPress: showLog }] : []),
    ...(a.stop ? [{ label: "Stop", onPress: () => run(() => tool("previews.stop", { id: b.id })), danger: true }] : []),
  ];

  return (
    <View accessible accessibilityLabel={`${b.title}, ${word.toLowerCase()}`} style={{ borderWidth: 1, borderColor: color.edge, backgroundColor: color["surface-2"], borderRadius: 14, overflow: "hidden", marginVertical: 4, maxWidth: 560 }}>
      <View accessibilityElementsHidden={!thumb} importantForAccessibility={thumb ? "yes" : "no-hide-descendants"} style={{ aspectRatio: 16 / 10, backgroundColor: color["surface-3"], alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {thumb ? <Image accessibilityLabel={`${b.title}, as it looks now`} source={{ uri: thumb }} resizeMode="cover" style={{ width: "100%", height: "100%", opacity: b.state === "live" ? 1 : 0.55 }} />
          : <Icon name="globe" size={24} tone={b.state === "live" ? "ok" : b.state === "crashed" ? "warn" : "label"} />}
      </View>
      <View style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text strong numberOfLines={2} style={{ flex: 1, minWidth: 0 }}>{b.title}</Text>
          <Chip tone={b.state === "live" ? "ok" : b.state === "crashed" ? "warn" : "plain"}>{word}</Chip>
        </View>
        <Text size="caption" tone="label">{b.state === "stopped" && b.mode === "session" ? "The server stopped. Ask the assistant to start it again." : `${shareWord(b.access)}${lifeWord(b.mode, b.state) ? ` · ${lifeWord(b.mode, b.state)}` : ""}`}</Text>
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {a.open ? <Button kind="primary" size={phone ? "md" : "sm"} icon="external" label="Open" disabled={busy} onPress={open} />
            : a.restart ? <Button kind="primary" size={phone ? "md" : "sm"} icon="refresh" label="Restart" disabled={busy} onPress={() => run(() => tool("previews.restart", { id: b.id }))} />
            : a.log ? <Button kind="primary" size={phone ? "md" : "sm"} label="Look at the log" disabled={busy} onPress={showLog} /> : null}
          <Button kind="ghost" size={phone ? "md" : "sm"} icon="share" label="Share" disabled={busy} onPress={() => setShare(true)} />
          {canPublish(b) ? <Button kind="ghost" size={phone ? "md" : "sm"} icon="publish" label="Publish" disabled={busy} onPress={() => setPublish(true)} /> : null}
          {more.length ? <Menu trigger={<IconButton icon="more" label="More" touch={phone} />} items={more} /> : null}
        </View>
      </View>
      {canPublish(b) ? <PublishSheet open={publish} onClose={() => setPublish(false)} preview={{ id: b.id, title: b.title }} /> : null}
      <Sheet open={share} onClose={() => setShare(false)} title="Who can open this">
        <View style={{ gap: 12 }}>
          <Segmented label="Who can open this" value={(b.access as "me" | "project" | "team")} onChange={(v) => run(() => tool("previews.share", { id: b.id, access: v }), () => showToast(`${shareWord(v)}.`))} options={SHARE_CHOICES} />
          <Text size="caption" tone="label">Whoever you choose gets it with their assistant. Sharing with anyone who has the link comes later.</Text>
        </View>
      </Sheet>
      <Sheet open={log !== null} onClose={() => setLog(null)} title="What it printed">
        <Text mono size="caption" selectable>{log ?? ""}</Text>
      </Sheet>
    </View>
  );
}
