// The Instructions editor: a short rendered preview and an Edit button that opens the document in a large overlay (the shared markdown editor, saved as you write). Kept in its own file so FolderDocs loads it
// lazily: the overlay's viewer also knows PDFs and Office files, and a page that only edits instructions must not load those renderers at start.
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, DocOverlay, Markdown, Text } from "@vyre/ui";
import { RefChip } from "../../ui/files/RefChip";
import { kindOf as refKind } from "../../../../lib/doc-refs.js";
import type { FileSource } from "../../ui/files/source";
import { DocMentionPanel } from "../../src/chat/DocMentionPanel";
import { refRoute } from "../../ui/files/ref-model.js";
import { Sec } from "../places/Frame";
import { DOC_NAME, VERSION_SPACING, type DocsApi } from "./model.ts";

export default function DocsViewerEditor({ api, who, title = "Instructions" }: { api: DocsApi; who: string; title?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const source = useMemo<FileSource>(() => ({
    load: async () => ({ text: (await api.docs())[DOC_NAME] ?? "" }),
    save: api.canEdit === false ? undefined : async (t) => { await api.saveDoc(DOC_NAME, t); },
  }), [api.id, api.canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { let live = true; api.docs().then((d) => { if (live) setText(d[DOC_NAME] ?? ""); }).catch(() => { if (live) setText(""); }); return () => { live = false; }; }, [api.id, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = api.canEdit !== false;
  // A reference chip opens what it names; the overlay closes first so the page is the one in front.
  const openRef = (urn: string) => { setOpen(false); setTick((n) => n + 1); router.push(refRoute(urn) as never); };
  return (
    <Sec title={title}>
      <Text size="caption" tone="label">{`${DOC_NAME}. Who ${who} is and how it works. Every tool and model reads it.`}</Text>
      <Card>
        <View style={{ maxHeight: 180, overflow: "hidden" }}>
          {text ? <Markdown text={text} renderRef={(r) => <RefChip lead={r.lead} name={r.name} kind={refKind(r.urn)} onOpen={() => openRef(r.urn)} />} /> : <Text tone="muted">{text === null ? "Loading..." : `Nothing written yet. ${edit ? "Edit to say who " + who + " is and how it works." : ""}`}</Text>}
        </View>
        <View className="flex-row pt-s2"><Button size="sm" kind="secondary" icon="edit" label={edit ? "Edit" : "Open"} onPress={() => setOpen(true)} /></View>
      </Card>
      <DocOverlay open={open} onClose={() => { setOpen(false); setTick((n) => n + 1); }} title="Instructions" name={DOC_NAME} source={source} kind="markdown" readOnly={!edit} spacing={api.versioned ? VERSION_SPACING : 0} assist={edit ? DocMentionPanel : undefined} onOpenRef={openRef} />
    </Sec>
  );
}
