import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, EmptyState, ErrorState, Field, GroupedList, LoadingState, Menu, Row, Text, showToast, useWork } from "@vyre/ui";
import { MenuRow } from "../../ui/blocks/RowMenu";
import { IconTile } from "../places/Page";
import { Frame, Sec } from "../places/Frame";
import { usePhone } from "../places/Page";
import { StartSheet, type StartExtras } from "../projects/StartSheet";
import { errWords, projectIdOf, startWords, type Body, type Row as TemplateRow } from "./model";
import { starterBody } from "./compose";
import { cardOf, filterRows, playbookPath, PLAYBOOK, TEMPLATES_LABEL } from "./board";
import { duplicateBody } from "./use";
import { useMayMakeTemplates } from "./role";
import { templates } from "./templates";

type Lib = Awaited<ReturnType<typeof templates.library>>;

/**
 * /u/playbooks (and the old /u/templates): the list of this Space's playbooks as cards: its name, what its projects are called, its stages as a strip, its counts and the one thing you do with it, "Start a matter". Live and drafts sit in
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
  const [starting, setStarting] = useState<TemplateRow | null>(null);
  const load = useCallback(() => { setErr(""); templates.list().then(setRows).catch((e) => setErr(errWords(e))); templates.library().then(setLib).catch(() => setLib([])); }, []);
  useEffect(load, [load]);
  useEffect(() => { (rows || []).forEach((r) => { if (!bodies[r.template]) templates.get(r.template, r.live ?? r.latest).then((v) => v.body && setBodies((b) => ({ ...b, [r.template]: v.body! }))).catch(() => undefined); }); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = useMemo(() => { const m = new Map<string, number>(); for (const i of (work.data?.items ?? []) as any[]) { const t = i.row?.data?.template; if (i.def?.name === "project" && t) m.set(String(t), (m.get(String(t)) || 0) + 1); } return m; }, [work.data]);
  const shown = filterRows(rows || [], query, "all");
  const items = shown.map((r) => ({ r, c: cardOf(r, bodies[r.template] ?? null, running.get(r.template) || 0), group: cardOf(r, null, 0).group }));
  const act = async (name: string, fn: () => Promise<void>) => { setBusy(name); try { await fn(); } catch (e) { showToast(errWords(e)); } finally { setBusy(""); } };
  // a blank playbook is made at once and opened as a board to write on: no form first
  const startBlank = () => act("new", async () => { const id = `tpl_untitled-${Math.random().toString(36).slice(2, 7)}`; const v = await templates.define(starterBody(), id, "started blank"); router.push(playbookPath(v.template) as never); });
  const install = (id: string) => act(id, async () => { const v = await templates.install(id); showToast(`${v.name} is a draft. Open it, try it, then publish it.`); router.push(playbookPath(v.template) as never); });
  const copy = (r: TemplateRow) => act(r.template, async () => { const v = await templates.get(r.template); const c = await templates.define(duplicateBody(v.body!), undefined, `a copy of ${r.name}`); showToast(`${c.name} is a draft.`); router.push(playbookPath(c.template) as never); });
  const start = (name: string, extras: StartExtras) => act("start", async () => { const r = await templates.start(starting!.template, name, extras); setStarting(null); showToast(startWords(name, r)); router.push(`/u/project/${projectIdOf(r.project)}` as never); });
  const have = new Set((rows || []).map((r) => r.name));
  const card = (r: TemplateRow, c: ReturnType<typeof cardOf>) => (
    <MenuRow items={mayMake ? [{ label: "Duplicate", onPress: () => void copy(r) }] : []}>
      {(menu) => (
        <Card><View className="gap-s3 p-s4">
          <Pressable accessibilityRole="button" accessibilityLabel={`Open ${c.name}`} onPress={() => router.push(playbookPath(r.template) as never)}>
            <View className="flex-row items-center gap-s3">
              <IconTile icon="box" />
              <View className="min-w-0 flex-1">
                <Text strong numberOfLines={1}>{c.name}</Text>
                <Text size="caption" tone="label" numberOfLines={1}>{`${c.projects} · ${c.status}`}</Text>
              </View>
                            {menu}
            </View>
          </Pressable>
          {c.stages.length ? <Text size="caption" tone="label" numberOfLines={1}>{c.stages.join("  ›  ")}</Text> : null}
          <View className="flex-row flex-wrap items-center gap-s2">
            <Text size="caption" tone="muted" numberOfLines={1}>{c.counts || " "}</Text>
            <View className="ml-auto">{r.live !== null ? <Button kind="primary" size="sm" label={c.start} onPress={() => setStarting(r)} /> : <Button kind="primary" size="sm" label="Open" onPress={() => router.push(playbookPath(r.template) as never)} />}</View>
          </View>
        </View></Card>
      )}
    </MenuRow>
  );
  return (
    <Frame title={TEMPLATES_LABEL} sub={rows ? `${rows.length} ${rows.length === 1 ? PLAYBOOK.one : PLAYBOOK.many}` : undefined}
      actions={mayMake ? <Menu trigger={<Button kind="primary" size="sm" icon="plus" label="New playbook" />} items={[
        { label: "New blank playbook", onPress: () => void startBlank() },
        { label: "From a kit", onPress: () => setShowKits(true) },
        { label: "Describe a playbook to the Engineer", onPress: () => router.push("/u/engineer" as never) },
      ]} /> : undefined}>
      <Field name="Search" value={query} onChangeText={setQuery} placeholder={`Search ${TEMPLATES_LABEL.toLowerCase()}`} />
      {err ? <Card flush><ErrorState title={`${TEMPLATES_LABEL} did not load`} reason={err} retry={load} /></Card> : null}
      {rows === null && !err ? <LoadingState rows={3} /> : null}
      {rows && !rows.length ? (
        <View className="flex-row flex-wrap gap-s3">
          {[
            { t: "Start blank", b: "Write the stages and tasks as a list.", on: () => void startBlank(), go: true },
            { t: "Start from a kit", b: "Add a playbook a Kit ships, then change it.", on: () => setShowKits(true), go: true },
            { t: "Describe it", b: "Tell the Engineer what the work is and it drafts one.", on: () => router.push("/u/engineer" as never), go: true },
          ].map((o) => (
            <Pressable key={o.t} accessibilityRole="button" accessibilityLabel={o.t} onPress={o.on} style={{ width: phone ? "100%" : 300 }}>
              <Card><View className="gap-s1 p-s4"><Text strong>{o.t}</Text><Text size="caption" tone="muted">{o.b}</Text></View></Card>
            </Pressable>
          ))}
        </View>
      ) : null}
      {rows && rows.length && !items.length ? <Card><EmptyState title="No match" body="Try another word, or show All." /></Card> : null}
      {items.length ? (
        <GroupedList groups={[{ name: "Live" }, { name: "Drafts" }].filter((g) => items.some((i) => i.group === g.name))} items={items.map((i) => ({ ...i, group: i.group }))} itemNoun="playbooks"
          renderItems={(list) => <View className="flex-row flex-wrap gap-s3">{list.map((i) => <View key={i.r.template} style={{ width: phone ? "100%" : 340 }}>{card(i.r, i.c)}</View>)}</View>} />
      ) : null}
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
      <StartSheet noun={starting ? (bodies[starting.template]?.noun?.one || starting.noun?.one || "project") : "project"} open={starting !== null} busy={busy === "start"} onClose={() => setStarting(null)} onStart={(n, x) => void start(n, x)} />
    </Frame>
  );
}
