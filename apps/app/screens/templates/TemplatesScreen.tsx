import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, ErrorState, LoadingState, Row, showToast } from "@vyre/ui";
import { IconTile } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { errWords, rowLine, type Row as TemplateRow } from "./model";
import { templates } from "./templates";

type Lib = Awaited<ReturnType<typeof templates.library>>;

/** /u/templates: the project templates of this Space, and the ones the Kits ship. A template is a tree of stages and tasks; project pages, @Engineer and the Flow step "Start a project from a template" all run it. */
export default function TemplatesScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [lib, setLib] = useState<Lib>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { setErr(""); templates.list().then(setRows).catch((e) => setErr(errWords(e))); templates.library().then(setLib).catch(() => setLib([])); }, []);
  useEffect(load, [load]);
  const install = async (id: string) => {
    setBusy(id);
    try { const v = await templates.install(id); showToast(`${v.name} is a draft. Try it, then put it live.`); router.push(`/u/templates/${v.template}` as never); } catch (e) { showToast(errWords(e)); } finally { setBusy(""); }
  };
  const have = new Set((rows || []).map((r) => r.name));
  return (
    <Frame back="/u/projects" title="Templates" sub="A template is stages and tasks a project follows: who does each task, the checklist that proves it done, what needs a yes. Ask @Engineer to build or change one.">
      <Sec title="In this Space">
        {err ? <Card flush><ErrorState title="Templates did not load" reason={err} retry={load} /></Card> : null}
        {rows === null && !err ? <LoadingState rows={3} /> : null}
        {rows && !rows.length ? <Card><EmptyState title="No templates yet" body="Install one from a Kit below, or ask @Engineer to write one from a description." /></Card> : null}
        {rows && rows.length ? (
          <Card flush>
            {rows.map((r, i) => (
              <View key={r.template}>{i ? <Divider /> : null}
                <Row lead={<IconTile icon="box" />} title={r.name} sub={rowLine(r)} end={<View className="flex-row items-center gap-s2">{r.tags.slice(0, 2).map((t) => <Chip key={t}>{t}</Chip>)}<Button kind="ghost" size="sm" label="Open" onPress={() => router.push(`/u/templates/${r.template}` as never)} /></View>} />
              </View>
            ))}
          </Card>
        ) : null}
      </Sec>
      {lib.length ? (
        <Sec title="From Kits">
          <Card flush>
            {lib.map((k, i) => (
              <View key={k.id}>{i ? <Divider /> : null}
                <Row lead={<IconTile icon="box" />} title={k.name} sub={`${k.kit} Kit · ${k.stages} stages, ${k.tasks} tasks. ${k.description}`}
                  end={have.has(k.name) ? <Chip tone="ok">Added</Chip> : <Button kind="primary" size="sm" label="Add as a draft" loading={busy === k.id} onPress={() => void install(k.id)} />} />
              </View>
            ))}
          </Card>
        </Sec>
      ) : null}
    </Frame>
  );
}
