// A chat's Files panel: the files this chat made or received, by name, each with Share to project / Unshare, a mark on the shared ones, and a preview where the file renders (text and images).
// The names come from the chat's own sealed index (work.file.list), so only people in the chat see them. Sharing opens that one file to the project's members and nothing else.
import { useCallback, useEffect, useState } from "react";
import { Image, Platform, View } from "react-native";
import { createElement } from "react";
import { Banner, Button, Card, Chip, Icon, Divider, EmptyState, ErrorState, LoadingState, Row, SectionLabel, Text, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { spaceRead } from "../drive/real";
import { bytesOf, textOf } from "../drive/real-model";
import { canPreview, fileIcon, groupFiles, previewKind, shareAction, shareLine, sizeLine, summary, type ChatFile } from "./files-model.js";

type Shown = { text?: string; image?: string; pdf?: string; failed?: boolean };
const mimeOf = (name: string) => (/\.png$/i.test(name) ? "image/png" : /\.gif$/i.test(name) ? "image/gif" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg");

export function ChatFiles({ chat }: { chat: string }) {
  const [files, setFiles] = useState<ChatFile[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState("");
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const load = useCallback(() => {
    setErr("");
    void callT<{ files?: ChatFile[] }>("work.file.list", { chat }).then((r) => { if (r.error) setErr(r.error.message || "The files could not be read."); else setFiles(r.data?.files ?? []); });
  }, [chat]);
  useEffect(load, [load]);

  const show = (f: ChatFile) => {
    setOpen(open === f.path ? "" : f.path);
    if (open === f.path || shown[f.path] || !canPreview(f)) return;
    spaceRead(undefined, f.path).then((r) => {
      const kind = previewKind(f.name);
      setShown((s) => ({ ...s, [f.path]: kind === "image" ? { image: `data:${mimeOf(f.name)};base64,${r.base64}` } : kind === "pdf" ? { pdf: `data:application/pdf;base64,${r.base64}` } : { text: textOf(bytesOf(r.base64)) } }));
    }).catch(() => setShown((s) => ({ ...s, [f.path]: { failed: true } })));
  };
  const toggle = async (f: ChatFile) => {
    const act = shareAction(f);
    setBusy(f.path); setProblem("");
    const r = await callT(act.tool, { path: f.path });
    setBusy("");
    if (r.error) setProblem(r.error.message || "That did not go through.");
    else { showToast(f.shared ? "Taken back. The project no longer opens it." : "Shared. The project's members open this file."); load(); }
  };

  if (err) return <Card flush><ErrorState title="The files did not load" reason={err} retry={load} /></Card>;
  if (!files) return <LoadingState rows={4} />;
  if (!files.length) return <EmptyState title="No files yet" body="Files you drop into this chat, and files an assistant makes here, show up here. They are encrypted to the people in the chat." />;
  const g = groupFiles(files);
  const section = (title: string, list: ChatFile[]) => list.length ? (
    <View>
      <SectionLabel>{title}</SectionLabel>
      <Card flush>
        {list.map((f, i) => (
          <View key={f.path}>
            {i ? <Divider /> : null}
            <Row dense lead={<View className="pr-s3"><Icon name={fileIcon(f.name)} /></View>} title={f.name} sub={sizeLine(f.size)} end={f.shared ? <Chip>Shared with project</Chip> : undefined} chevron onPress={() => show(f)} />
            {open === f.path ? (
              <View className="gap-s2 px-s3 pb-s3">
                <Text tone="muted">{shareLine(f)}</Text>
                <View className="flex-row gap-s2">
                  <Button kind={f.shared ? "ghost" : "primary"} size="sm" label={shareAction(f).label} disabled={busy === f.path} onPress={() => void toggle(f)} />
                </View>
                {shown[f.path]?.text !== undefined ? <Card><Text selectable>{shown[f.path].text}</Text></Card> : null}
                {shown[f.path]?.image ? <Image accessibilityLabel={f.name} source={{ uri: shown[f.path].image }} style={{ width: "100%", height: 240 }} resizeMode="contain" /> : null}
                {shown[f.path]?.pdf ? (Platform.OS === "web" ? createElement("iframe", { title: f.name, src: shown[f.path].pdf, style: { width: "100%", height: 420, border: 0, borderRadius: 8 } }) : <Text tone="muted">PDFs open from Drive on this device.</Text>) : null}
                {shown[f.path]?.failed ? <Banner tone="warn">This file could not be opened here.</Banner> : null}
                {!canPreview(f) ? <Text tone="muted">No preview here. Open it from Drive.</Text> : null}
              </View>
            ) : null}
          </View>
        ))}
      </Card>
    </View>
  ) : null;
  return (
    <View className="gap-s2">
      <Text tone="muted">{summary(files)}</Text>
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {section("Made here", g.made)}
      {section("Received", g.received)}
    </View>
  );
}
