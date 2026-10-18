import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, EmptyState, ErrorState, Field, LoadingState, Menu, Row, Text, showToast, useWork } from "@vyre/ui";
import { MenuRow } from "../../ui/blocks/RowMenu";
import { IconTile } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { usePhone } from "../places/Page";
import { errWords, type Body, type Row as TemplateRow } from "./model";
import { starterBody } from "./compose";
import { cardOf, filterRows, playbookPath, PLAYBOOK, TEMPLATES_LABEL } from "./board";
import { sentenceOf } from "./page";
import { duplicateBody } from "./use";
import { useMayMakeTemplates } from "./role";
import { DescribeSheet } from "./DescribeSheet";
import { openEngineer } from "../engineer/openEngineer";
import { templates } from "./templates";

type Lib = Awaited<ReturnType<typeof templates.library>>;

/**
 * /u/playbooks (and the old /u/templates): the list of this Space's playbooks as cards: its name, what its projects are called, its stages as a strip, its counts and the one thing you do with it, "Start a campaign". Live and drafts sit in
 * two groups; a quiet "..." has Duplicate. "+ New" offers a blank one, one from a Kit, or "Describe it" to the Engineer.
 */
export default function TemplatesScreen() {
  const router = useRouter();
  const phone = usePhone();
  const mayMake = useMayMakeTemplates();
  const work = useWork();
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [bodies, setBodies] = useState<Record<string, Body>>({});
  const [lib, setLib] = useState<Lib>([]);
  const [showKits, setShowKits] = useState(false);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [describing, setDescribing] = useState(false);
  const [idea, setIdea] = useState("");
  const load = useCallback(() => { setErr(""); templates.list().then(setRows).catch((e) => setErr(errWords(e))); templates.library().then(setLib).catch(() => setLib([])); }, []);
  useEffect(load, [load]);
  useEffect(() => { (rows || []).forEach((r) => { if (!bodies[r.template]) templates.get(r.template, r.live ?? r.latest).then((v) => v.body && setBodies((b) => ({ ...b, [r.template]: v.body! }))).catch(() => undefined); }); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  // the projects each playbook has started, by name (a project that is archived is not "used by")
  const used = useMemo(() => { const m = new Map<string, string[]>(); for (const i of (work.data?.items ?? []) as any[]) { const t = i.row?.data?.template, name = i.row?.data?.name; if (i.def?.name === "project" && t && name && i.row?.data?.status !== "archived") m.set(String(t), [...(m.get(String(t)) || []), String(name)]); } return m; }, [work.data]);
  const shown = filterRows(rows || [], query, "all");
  const items = shown.map((r) => ({ r, c: cardOf(r, bodies[r.template] ?? null, used.get(r.template) || []), group: cardOf(r, null).group }));
  const act = async (name: string, fn: () => Promise<void>) => { setBusy(name); try { await fn(); } catch (e) { showToast(errWords(e)); } finally { setBusy(""); } };
  // a blank playbook is made at once and opened as a board to write on: no form first
  const startBlank = () => act("new", async () => { const id = `tpl_untitled-${Math.random().toString(36).slice(2, 7)}`; const v = await templates.define(starterBody(), id, "started blank"); router.push(playbookPath(v.template) as never); });
  const install = (id: string) => act(id, async () => { const v = await templates.install(id); showToast(`${v.name} is a draft. Open it, try it, then publish it.`); router.push(playbookPath(v.template) as never); });
  const copy = (r: TemplateRow) => act(r.template, async () => { const v = await templates.get(r.template); const c = await templates.define(duplicateBody(v.body!), undefined, `a copy of ${r.name}`); showToast(`${c.name} is a draft.`); router.push(playbookPath(c.template) as never); });
  const have = new Set((rows || []).map((r) => r.name));
  // a calm row: the playbook as one sentence, its counts and where it is used under it, Live or Draft and the version on the right
  const row = (r: TemplateRow, c: ReturnType<typeof cardOf>) => {
    const b = bodies[r.template];
    return (
      <MenuRow key={r.template} items={mayMake ? [{ label: "Duplicate", onPress: () => void copy(r) }] : []}>
        {(menu) => (
          <Row lead={<IconTile icon="box" />} title={b ? sentenceOf(b, true) : c.name} sub={[c.counts, c.usedBy].filter(Boolean).join(" · ")} onPress={() => router.push(playbookPath(r.template) as never)}
            end={<View className="flex-row items-center gap-s2"><Chip tone={r.live !== null ? "ok" : "plain"}>{r.live !== null ? "Live" : "Draft"}</Chip><Text size="caption" tone="label">{`v${r.live ?? r.latest}`}</Text>{menu}</View>} />
        )}
      </MenuRow>
    );
  };
  return (
    <Frame title={TEMPLATES_LABEL} sub={rows ? `${rows.length} ${rows.length === 1 ? PLAYBOOK.one : PLAYBOOK.many}` : undefined}
      actions={mayMake ? <Menu trigger={<Button kind="primary" size="sm" icon="plus" label="New playbook" />} items={[
        { label: "New blank playbook", onPress: () => void startBlank() },
        { label: "From a kit", onPress: () => setShowKits(true) },
        { label: "Describe a playbook to the Engineer", onPress: () => setDescribing(true) },
      ]} /> : undefined}>
      <Text tone="muted">A playbook is a kind of project your team runs again and again: its stages, the to-dos in each, who does what, and the Flows that run inside it. Start a project from one in a click.</Text>
      {mayMake ? (
        <View className="flex-row items-end gap-s2">
          <View className="min-w-0 flex-1"><Field label="Describe a kind of project" value={idea} onChangeText={setIdea} placeholder="For example: a product launch: brief, draft, review, launch, wrap up" /></View>
          <Button kind="primary" size="sm" label="Draft it" disabled={!idea.trim()} onPress={() => { const words = idea.trim(); setIdea(""); openEngineer(router, { source: "playbook", words }); }} />
        </View>
      ) : null}
      <Field name="Search" value={query} onChangeText={setQuery} placeholder={`Search ${TEMPLATES_LABEL.toLowerCase()}`} />
      {err ? <Card flush><ErrorState title={`${TEMPLATES_LABEL} did not load`} reason={err} retry={load} /></Card> : null}
      {rows === null && !err ? <LoadingState rows={3} /> : null}
      {rows && !rows.length ? (
        <View className="flex-row flex-wrap gap-s3">
          {[
            { t: "Start blank", b: "Write the stages and tasks as a list.", on: () => void startBlank(), go: true },
            { t: "Start from a kit", b: "Add a playbook a Kit ships, then change it.", on: () => setShowKits(true), go: true },
            { t: "Describe it", b: "Tell the Engineer what the work is and it drafts one.", on: () => setDescribing(true), go: true },
          ].map((o) => (
            <Pressable key={o.t} accessibilityRole="button" accessibilityLabel={o.t} onPress={o.on} style={{ width: phone ? "100%" : 300 }}>
              <Card><View className="gap-s1 p-s4"><Text strong>{o.t}</Text><Text size="caption" tone="muted">{o.b}</Text></View></Card>
            </Pressable>
          ))}
        </View>
      ) : null}
      {rows && rows.length && !items.length ? <Card><EmptyState title="No match" body="Try another word, or show All." /></Card> : null}
      {items.length ? <Card flush>{items.map((i) => row(i.r, i.c))}</Card> : null}
      {showKits && lib.length ? (
        <Sec title="From Kits">
          <Card flush>
            {lib.map((k) => (
              <Row key={k.id} lead={<IconTile icon="box" />} title={k.name} sub={`${k.kit} Kit · ${k.stages} stages, ${k.tasks} tasks. ${k.description}`}
                end={have.has(k.name) ? <Chip tone="ok">Added</Chip> : <Button kind="primary" size="sm" label="Add as a draft" loading={busy === k.id} onPress={() => void install(k.id)} />} />
            ))}
          </Card>
        </Sec>
      ) : showKits ? <Card><EmptyState title="No Kits to add from" body="None of your Kits ships a playbook yet." /></Card> : null}
      <DescribeSheet open={describing} title="Describe a playbook" question="What kind of work is this playbook for?" placeholder="For example: taking on a new estate planning client, from the first call to the signed documents" cta="Ask the Engineer" onClose={() => setDescribing(false)} onSend={(words) => { setDescribing(false); openEngineer(router, { source: "playbook", words }); }} />
    </Frame>
  );
}
