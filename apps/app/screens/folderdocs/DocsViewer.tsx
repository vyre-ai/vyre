// The Instructions editor: a short rendered preview and an Edit button that opens the document in a large overlay (the shared markdown editor, saved as you write). Kept in its own file so FolderDocs loads it
// lazily: the overlay's viewer also knows PDFs and Office files, and a page that only edits instructions must not load those renderers at start.
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Card, DocOverlay, Markdown, Text } from "@vyre/ui";
import type { FileSource } from "../../ui/files/source";
import { Sec } from "../places/Frame";
import { DOC_NAME, VERSION_SPACING, type DocsApi } from "./model.ts";

export default function DocsViewerEditor({ api, who, title = "Instructions" }: { api: DocsApi; who: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const source = useMemo<FileSource>(() => ({
    load: async () => ({ text: (await api.docs())[DOC_NAME] ?? "" }),
    save: api.canEdit === false ? undefined : async (t) => { await api.saveDoc(DOC_NAME, t); },
  }), [api.id, api.canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { let live = true; api.docs().then((d) => { if (live) setText(d[DOC_NAME] ?? ""); }).catch(() => { if (live) setText(""); }); return () => { live = false; }; }, [api.id, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = api.canEdit !== false;
  return (
    <Sec title={title}>
      <Text size="caption" tone="label">{`${DOC_NAME}. Who ${who} is and how it works. Every tool and model reads it.`}</Text>
      <Card>
        <View style={{ maxHeight: 180, overflow: "hidden" }}>
          {text ? <Markdown text={text} /> : <Text tone="muted">{text === null ? "Loading..." : `Nothing written yet. ${edit ? "Edit to say who " + who + " is and how it works." : ""}`}</Text>}
        </View>
        <View className="flex-row pt-s2"><Button size="sm" kind="secondary" icon="edit" label={edit ? "Edit" : "Open"} onPress={() => setOpen(true)} /></View>
      </Card>
      <DocOverlay open={open} onClose={() => { setOpen(false); setTick((n) => n + 1); }} title="Instructions" name={DOC_NAME} source={source} kind="markdown" readOnly={!edit} spacing={api.versioned ? VERSION_SPACING : 0} />
    </Sec>
  );
}
