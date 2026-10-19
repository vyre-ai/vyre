import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Appear, allowsMock, Banner, Button, IconButton, Menu, Sheet, Text, showToast, factsOf, EmptyState, ErrorState, PageHeader, RecordPage, SkeletonRows, titleOf, urnParam, useFieldEnv, useRecordEvents, useRecordsWorld, viewDefOf } from "@vyre/ui";
import { href } from "../../../../lib/tags.js";
import { useShell } from "../shell/shared";
import { RecordHistory } from "./RecordHistory";
import { Connections } from "./Connections";
import { HeaderFields } from "./HeaderFields";
import { useTypeLayout } from "./layout-state";
import { pinnedFacts } from "../../ui/records/logic.js";
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


/** /u/record/<id>: one record's page. The id is the record's urn (vyre://space/type/id, encoded) or its bare id (the uuid); both find the same record. */
export function RecordScreen({ id, onClose, onOpen }: { id: string; onClose?: () => void; onOpen?: (urn: string) => void }) {
  const router = useRouter();
  const SPACES = useShell((s) => s.data.spaces);
  const { data: world, loading, error, reload } = useRecordsWorld();
  const open = useCallback((urn: string) => (onOpen ? onOpen(urn) : router.push(`/u/record/${urn.split("/").pop()}` as never)), [router, onOpen]);
  const openTag = useCallback((t: string) => router.push(href(t) as never), [router]);
  const env = useFieldEnv(world, open, openTag);
  const mv = useMoveStage(env, reload);
  const urn = urnParam(id);
  const rec = world ? Object.values(world.byType).flat().find((r) => (urn ? r.urn === urn : r.id === id)) : undefined;
  const lay = useTypeLayout(rec?.type);
  const [logged, setLogged] = useState(0);
  const events = useRecordEvents(rec?.urn);
  // A Contact with an e-mail gets "Send for signature" when the Documents app is installed: its view opens with the e-mail already in the form.
  const [canSend, setCanSend] = useState(false);
  const [forgetting, setForgetting] = useState<null | { busy: boolean; problem: string }>(null);
  const isContact = rec?.type === "contact";
  useEffect(() => {
    if (!isContact) { setCanSend(false); return; }
    let live = true;
    tool<{ commands: { module: string; id: string }[] }>("views.list", {}).then((r) => { if (live) setCanSend(r.commands.some((c) => c.module === "appmods" && c.id === "documents-send")); }).catch(() => { if (live) setCanSend(false); });
    return () => { live = false; };
  }, [isContact]);
  const email = emailOf(rec?.data);
  const back = () => (onClose ? onClose() : router.canGoBack() ? router.back() : router.replace(`/u/records/${rec?.type ?? "contact"}` as never));
  if (error && !world) return <ErrorState title="This record did not load" reason={error.message} retry={reload} />;
  if (loading && !world) return <View className="min-h-0 flex-1"><PageHeader title="Record" onBack={back} /><View className="p-s4"><SkeletonRows rows={4} /></View></View>;
  const def = rec && world?.types.find((t) => t.name === rec.type);
  if (!world || !rec || !def) return <EmptyState title="That record is not here" body="It may have been removed, or it lives in a space you cannot see." action={{ label: "Go back", onPress: back }} />;
  const title = titleOf(def, rec);
  const space = SPACES.find((s) => s.id === rec.labels?.source_spaces?.[0])?.name;
  const vd = viewDefOf(def);
  const pinned: string[] | undefined = Array.isArray(lay.layout?.header_fields?.default) ? lay.layout.header_fields.default : undefined;
  // One header for the pushed page (ui-system.md section 7): the face or emblem, the title, "Matter \u00B7 Juniper Studio".
  return (
    <View className="min-h-0 flex-1">
      <PageHeader title={title} context={[def.label, space].filter(Boolean).join(" \u00B7 ")} faces={[{ kind: vd.initials ? "person" : "project", id: rec.id, name: title, seed: rec.data?.avatar_seed }]} onBack={back} actions={<View className="flex-row items-center gap-s2"><Menu trigger={<IconButton icon="more" label="More" />} items={[{ label: "Delete for good...", onPress: () => setForgetting({ busy: false, problem: "" }) }]} /><Button kind="secondary" size="sm" label="Chat about this" onPress={() => router.push(`/u/chats/new?about=${encodeURIComponent(rec.urn)}&name=${encodeURIComponent(title)}` as never)} /></View>} />
      {rec.type === "contact" || rec.type === "organization" ? <View className="px-s4 pt-s2"><Roles urn={rec.urn} name={title} onOpen={open} /></View> : null}
      {isShareable(rec.type) ? <View className="px-s4 pt-s2"><ShareControl urn={rec.urn} type={rec.type} record={typeof rec.data?.record === "object" ? rec.data.record?.urn : typeof rec.data?.record === "string" ? rec.data.record : undefined} value={String(rec.data?.visibility ?? "private")} onDone={reload} /></View> : null}
      <View className="px-s4 pt-s2"><QuickActions email={email || undefined} urn={rec.urn} onLogged={() => setLogged((n) => n + 1)} /></View>
      <View className="px-s4 pt-s2"><DocumentsBar def={def} rec={rec} related={relatedRecords(world.types, world.byType, def, rec)} email={email} canSend={canSend || allowsMock()} /></View>
      <View className="flex-row flex-wrap items-start gap-x-s8 gap-y-s3 px-s4 pt-s3">
        {(pinned ? pinnedFacts(def, rec, pinned) : factsOf(def, rec)).map(([l, v]) => (
          <View key={l} className="min-w-[96px] gap-s1">
            <Text size="caption" tone="label">{l}</Text>
            {v === null ? <Text tone="faint">Add</Text> : <Text strong numberOfLines={1}>{String(v)}</Text>}
          </View>
        ))}
        {typeof rec.data?.phone === "string" && rec.data.phone ? <Button kind="secondary" size="sm" icon="phone" label="Call" onPress={() => void openExternal(`tel:${String(rec.data.phone).replace(/\s/g, "")}`)} /> : null}
        <View className="ml-auto">
          <HeaderFields fields={def.fields.filter((f: any) => f.kind !== "sealed" && !f.seal).map((f: any) => ({ name: f.name, label: String(f.label ?? f.name) }))} names={pinned ?? factsOf(def, rec).map(([l]) => def.fields.find((f: any) => f.label === l)?.name).filter(Boolean) as string[]} spaceScope={lay.scope === "space"} onNames={(n) => void lay.save("header_fields", { ...(lay.layout.header_fields ?? {}), default: n })} />
        </View>
      </View>
      <ScrollView contentContainerClassName="gap-s4 px-s4 pb-s12 pt-s2 max-w-page w-full self-center">
        <Appear index={1}><RecordPage def={def} rec={rec} world={world} onStage={(st) => { void mv.go(rec, def, st); }} events={events.data ?? []} env={env} onOpen={open} story={<View className="gap-s4"><Connections urn={rec.urn} env={env} onOpen={open} /><RecordHistory urn={rec.urn} refresh={logged} me={(world as { me?: string }).me} /></View>} onNew={(t, via) => router.push(`/u/record/new?type=${t}&via=${encodeURIComponent(via)}&to=${encodeURIComponent(rec.urn)}` as never)} /></Appear>
      </ScrollView>
      {mv.sheet}
      <Sheet open={!!forgetting} onClose={() => setForgetting(null)} title={`Forget ${title} for good?`}>
        {forgetting ? (
          <View className="gap-s3">
            <Text tone="muted">It cannot be undone. The text of every task about it is emptied, the record and its history are destroyed, its events lose their data and any sealed values are destroyed. Files linked to it stay in Files.</Text>
            <Text tone="muted">You approve it with your phone. An agent can only propose it.</Text>
            {forgetting.problem ? <Banner tone="warn">{forgetting.problem}</Banner> : null}
            <View className="flex-row gap-s2">
              <Button kind="primary" label="Forget it" loading={forgetting.busy} disabled={forgetting.busy} onPress={() => {
                setForgetting({ busy: true, problem: "" });
                tool<{ message?: string }>("records.forget", { urn: rec.urn }).then((r) => { setForgetting(null); showToast(r?.message?.split(".")[0] ? `${title} is forgotten.` : "Forgotten."); back(); }).catch((e) => setForgetting({ busy: false, problem: e instanceof Error ? e.message : "That did not work." }));
              }} />
              <Button kind="ghost" label="Cancel" onPress={() => setForgetting(null)} />
            </View>
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
