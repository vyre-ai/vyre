import { useCallback, useEffect, useState } from "react";
import { useStore } from "@vyre/ui";
import type { RecordsWorld } from "../../ui/views/shared";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Appear, allowsMock, Text, showToast, factsOf, EmptyState, ErrorState, PageHeader, RecordPage, SkeletonRows, titleOf, urnParam, useFieldEnv, useRecordEvents, useRecordsWorld, viewDefOf } from "@vyre/ui";
import type { MenuItem } from "@vyre/ui";
import { RecordHeader } from "../../ui/views/RecordHeader";
import { recordIdOf } from "../../ui/records/record-id.js";
import { copyAndTell, recordLink } from "../../ui/records/clipboard";
import { useShowEmpty } from "../../src/state/record-prefs";
import { href } from "../../../../lib/tags.js";
import { useShell } from "../shell/shared";
import { RecordHistory } from "./RecordHistory";
import { Connections } from "./Connections";
import { HeaderFields } from "./HeaderFields";
import { useTypeLayout } from "./layout-state";
import { pinnedFacts } from "../../ui/records/logic.js";
import { templateLabel } from "../../ui/records/template-names.js";
import { useMoveStage } from "./MoveStage";
import { DocumentsBar } from "./DocumentsBar";
import { Roles } from "./Roles";
import { QuickActions } from "./QuickActions";
import { ShareControl } from "./ShareControl";
import { isShareable } from "./share-model.js";
import { relatedRecords } from "../../ui/views/logic.js";
import { tool } from "../../src/real/box";
import { emailOf } from "../shell/module-view.js";
import { openExternal } from "../../src/shell/open-external";
import { plainError } from "../../src/real/error-note.js";
import { recordsApi } from "./records-api";
import { useRecordsAccess } from "./records-access";
import { recordMenu } from "./record-menu.js";


/** /u/record/<id>: one record's page. The id is the record's urn (vyre://space/type/id, encoded) or its bare id (the uuid); both find the same record. */
export function RecordScreen({ id, onClose, onOpen }: { id: string; onClose?: () => void; onOpen?: (urn: string) => void }) {
  const router = useRouter();
  const SPACES = useShell((s) => s.data.spaces);
  const { data: whole, loading, error, reload } = useRecordsWorld();
  const urn = urnParam(id);
  // Opened by its address (a link, the Records side panel): the record itself is read with records.get beside the types, so its page draws without waiting for every record of
  // every type, and a record the world does not hold yet is still found. The whole world (shared with Records) fills in links and related records behind it.
  const store = useStore();
  const [direct, setDirect] = useState<{ urn: string; world: RecordsWorld | null; missing: boolean } | null>(null);
  const inWhole = whole && urn ? Object.values(whole.byType).flat().some((r: any) => r.urn === urn) : false;
  useEffect(() => {
    if (!urn || inWhole) return;
    let live = true;
    void Promise.all([store.get(urn).catch(() => null), Promise.resolve(store.types()).catch(() => null)]).then(([r, types]) => {
      if (!live || !types) return;
      setDirect({ urn, missing: !r, world: r ? { types: types as any[], byType: { [r.type]: [r] }, actors: whole?.actors ?? [], me: whole?.me, partial: true } : null });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urn, inWhole, store]);
  const answered = direct && direct.urn === urn ? direct : null;
  const world: RecordsWorld | undefined = inWhole || !urn ? whole : answered?.world ?? whole;
  /** Asked for by address and not yet answered: the page waits for records.get before it says the record is not here. */
  const waiting = Boolean(urn && !inWhole && !answered);
  const open = useCallback((urn: string) => (onOpen ? onOpen(urn) : router.push(`/u/record/${urn.split("/").pop()}` as never)), [router, onOpen]);
  const openTag = useCallback((t: string) => router.push(href(t) as never), [router]);
  const env = useFieldEnv(world, open, openTag);
  const mv = useMoveStage(env, reload);
  const rec = world ? Object.values(world.byType).flat().find((r) => (urn ? r.urn === urn : r.id === id)) : undefined;
  const lay = useTypeLayout(rec?.type);
  const [logged, setLogged] = useState(0);
  const [who, setWho] = useState<"person" | "assistant">("person");
  const [showEmpty, setShowEmpty] = useShowEmpty();
  const [headerOpen, setHeaderOpen] = useState(false);
  useEffect(() => { setWho("person"); }, [rec?.urn]);
  const events = useRecordEvents(rec?.urn);
  // A Contact with an e-mail gets "Send for signature" when the Documents app is installed: its view opens with the e-mail already in the form.
  const [canSend, setCanSend] = useState(false);
  const access = useRecordsAccess();
  const isContact = rec?.type === "contact";
  useEffect(() => {
    if (!isContact) { setCanSend(false); return; }
    let live = true;
    tool<{ commands: { module: string; id: string }[] }>("views.list", {}).then((r) => { if (live) setCanSend(r.commands.some((c) => c.module === "appmods" && c.id === "documents-send")); }).catch(() => { if (live) setCanSend(false); });
    return () => { live = false; };
  }, [isContact]);
  const email = emailOf(rec?.data);
  const back = () => (onClose ? onClose() : router.canGoBack() ? router.back() : router.replace(`/u/records/${rec?.type ?? "contact"}` as never));
  // Every wait has a limit: loading rows that have not turned into a record after 20 s become a plain error with Try again.
  const stillWaiting = Boolean((loading && !world) || (waiting && !rec));
  const [tired, setTired] = useState(false);
  useEffect(() => {
    if (!stillWaiting) { setTired(false); return; }
    const t = setTimeout(() => setTired(true), 20_000);
    return () => clearTimeout(t);
  }, [stillWaiting]);
  if ((error && !world) || (tired && stillWaiting)) return <ErrorState title="This record did not load" reason={error ? plainError(error, "Records did not answer.") : "Records is taking too long to answer."} retry={() => { setTired(false); reload(); }} />;
  if (stillWaiting) return <View className="min-h-0 flex-1"><PageHeader title="Record" onBack={back} /><View className="p-s4"><SkeletonRows rows={4} /></View></View>;
  const def = rec && world?.types.find((t) => t.name === rec.type);
  if (!world || !rec || !def) return <EmptyState title="That record is not here" body="It may have been removed, or it lives in a space you cannot see." action={{ label: "Go back", onPress: back }} />;
  const title = titleOf(def, rec);
  const space = SPACES.find((s) => s.id === rec.labels?.source_spaces?.[0])?.name;
  const vd = viewDefOf(def);
  // Delete moves the record to the bin, with Undo; Delete for good is in the Bin (records-api.ts, Bin.tsx)
  const remove = () => {
    const urn = rec.urn;
    void recordsApi.remove(urn, rec.version).then((r) => {
      if (r.error) { showToast(plainError(r.error, "That did not delete.")); return; }
      showToast(`${title} moved to the bin.`, { label: "Undo", run: () => { void recordsApi.restore(urn).then((x) => { if (x.error) showToast(plainError(x.error, "That did not come back.")); else reload(); }); } });
      back();
    });
  };
  // One header: the face, the name, "Project · Juniper Studio", and the ID at the end of that line. Chat and More sit at the right.
  const idText = recordIdOf(rec);
  const folder = typeof rec.data?.drive_path === "string" ? rec.data.drive_path.trim() : "";
  const dial = typeof rec.data?.phone === "string" && rec.data.phone ? String(rec.data.phone) : "";
  const menu: MenuItem[] = recordMenu({ id: idText, agent: who === "assistant", canAgent: !access.joined, showEmpty, files: !!folder, dial: !!dial }).map((item) => ({
    ...item,
    onPress: () => {
      if (item.id === "copy-id") void copyAndTell(idText);
      else if (item.id === "copy-link") void copyAndTell(recordLink(rec.id));
      else if (item.id === "agent") setWho((w) => (w === "assistant" ? "person" : "assistant"));
      else if (item.id === "empty") setShowEmpty(!showEmpty);
      else if (item.id === "files") router.push(`/u/files?folder=${encodeURIComponent(folder)}` as never);
      else if (item.id === "dial") void openExternal(`tel:${dial.replace(/\s/g, "")}`);
      else if (item.id === "header") setHeaderOpen(true);
      else if (item.id === "delete") remove();
    },
  }));
  const idLabel = def.fields.find((f: any) => f.name === "ref")?.label;
  const pinnedAll: string[] | undefined = Array.isArray(lay.layout?.header_fields?.default) ? lay.layout.header_fields.default : undefined;
  const pinned = pinnedAll?.filter((n) => n !== "ref");
  const templateName = def.fields.find((x: any) => x.name === "template")?.label;
  const facts = (pinned ? pinnedFacts(def, rec, pinned) : factsOf(def, rec)).filter(([l]) => l !== idLabel).map(([l, v]) => [l, rec.type === "project" && l === templateName ? templateLabel(v) : v] as [string, any]);
  const headerNames = (pinned ?? factsOf(def, rec).map(([l]) => def.fields.find((f: any) => f.label === l)?.name).filter(Boolean) as string[]).filter((n) => n !== "ref");
  return (
    <View className="min-h-0 flex-1">
      <RecordHeader title={title} context={[def.label, space].filter(Boolean).join(" \u00B7 ")} id={idText || undefined} faces={[{ kind: vd.initials ? "person" : "project", id: rec.id, name: title, seed: rec.data?.avatar_seed }]} onBack={back} onChat={() => router.push(`/u/chats/new?about=${encodeURIComponent(rec.urn)}&name=${encodeURIComponent(title)}` as never)} menu={menu} />
      {rec.type === "contact" || rec.type === "organization" ? <View className="px-s4 pt-s2"><Roles urn={rec.urn} name={title} onOpen={open} /></View> : null}
      {isShareable(rec.type) ? <View className="px-s4 pt-s2"><ShareControl urn={rec.urn} type={rec.type} record={typeof rec.data?.record === "object" ? rec.data.record?.urn : typeof rec.data?.record === "string" ? rec.data.record : undefined} value={String(rec.data?.visibility ?? "private")} onDone={reload} /></View> : null}
      <View className="px-s4 pt-s2"><QuickActions email={email || undefined} urn={rec.urn} onLogged={() => setLogged((n) => n + 1)} /></View>
      <View className="px-s4 pt-s2"><DocumentsBar def={def} rec={rec} related={relatedRecords(world.types, world.byType, def, rec)} email={email} canSend={canSend || allowsMock()} /></View>
      {facts.length ? (
        <View className="flex-row flex-wrap items-start gap-x-s4 gap-y-s2 px-s4 pt-s2">
          {facts.map(([l, v]) => (
            <View key={l} className="min-w-[96px] gap-s1">
              <Text size="caption" tone="label">{l}</Text>
              {v === null ? <Text tone="faint">Add</Text> : <Text strong numberOfLines={1}>{String(v)}</Text>}
            </View>
          ))}
        </View>
      ) : null}
      <HeaderFields trigger={false} open={headerOpen} onOpen={setHeaderOpen} fields={def.fields.filter((f: any) => f.name !== "ref" && f.kind !== "sealed" && !f.seal).map((f: any) => ({ name: f.name, label: String(f.label ?? f.name) }))} names={headerNames} spaceScope={lay.scope === "space"} onNames={(n) => void lay.save("header_fields", { ...(lay.layout.header_fields ?? {}), default: n })} />
      <ScrollView contentContainerClassName="gap-s5 px-s4 pb-s12 pt-s2 max-w-page w-full self-center">
        <Appear index={1}><RecordPage def={def} rec={rec} world={world} canCustomize={access.admin} canSeal={access.ownServer} who={who} onWho={setWho} onStage={(st) => { void mv.go(rec, def, st); }} events={events.data ?? []} env={env} onOpen={open} story={<View><Connections urn={rec.urn} env={env} onOpen={open} /><RecordHistory urn={rec.urn} refresh={logged} me={(world as { me?: string }).me} /></View>} onNew={(t, via) => router.push(`/u/record/new?type=${t}&via=${encodeURIComponent(via)}&to=${encodeURIComponent(rec.urn)}` as never)} /></Appear>
      </ScrollView>
      {mv.sheet}
    </View>
  );
}
