// The Instructions editor on the shared Markdown viewer and editor Files uses. Kept in its own file so FolderDocs loads it lazily: the viewer also knows PDFs and Office files, and a page that only
// edits instructions must not load those renderers at start.
import { useMemo } from "react";
import { Card, FileViewer, Text, showToast } from "@vyre/ui";
import type { FileSource } from "../../ui/files/source";
import { Sec } from "../places/Frame";
import { DOC_NAME, type DocsApi } from "./model.ts";

/**
 * An agent's or a project's instructions (AGENTS.md), shown and edited in the one Markdown viewer and editor Files uses (FileViewer): rendered by default, Edit to change it, Cmd+S, an unsaved-changes
 * guard. This is only the wiring: which file, how it loads and where it saves.
 */
export default function DocsViewerEditor({ api, who, title = "Instructions" }: { api: DocsApi; who: string; title?: string }) {
  const shown = DOC_NAME;
  const source = useMemo<FileSource>(() => ({
    load: async () => ({ text: (await api.docs())[shown] ?? "" }),
    save: api.canEdit === false ? undefined : async (text) => { await api.saveDoc(shown, text); },
  }), [api.id, shown, api.canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sec title={title}>
      <Text size="caption" tone="label">{`${DOC_NAME}. Who ${who} is and how it works. Every tool and model reads it.`}</Text>
      <Card flush>
        <FileViewer key={`${api.id}:${shown}`} name={shown} kind="markdown" bare readOnly={api.canEdit === false} source={source} onSaved={() => showToast("Saved. It applies from the next chat.")} />
      </Card>
    </Sec>
  );
}

