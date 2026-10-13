import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Linking } from "react-native";
import { useRouter } from "expo-router";
import { Appear, Banner, Button, Chip, IconButton, Menu, Sheet, Text, showToast, factsOf, EmptyState, ErrorState, PageHeader, RecordPage, SkeletonRows, titleOf, urnParam, useFieldEnv, useRecordEvents, useRecordsWorld, viewDefOf } from "@vyre/ui";
import { useShell } from "../shell/shared";
import { useSidebar } from "../shell/sidebar";
import { RecordTimeline } from "./RecordTimeline";
import { DocumentsBar } from "./DocumentsBar";
import { relatedRecords } from "../../ui/views/logic.js";
import { tool } from "../../src/real/box";
import { emailOf } from "../shell/module-view.js";


/** /u/record/<id>: one record's page. The id is the record's urn (vyre://space/type/id, encoded) or its bare id (the uuid); both find the same record. */
export function RecordScreen({ id }: { id: string }) {
  const router = useRouter();
  const SPACES = useShell((s) => s.data.spaces);
  const { data: world, loading, error, reload } = useRecordsWorld();
  const open = useCallback((urn: string) => router.push(`/u/record/${urn.split("/").pop()}` as never), [router]);
  const env = useFieldEnv(world, open);
  const urn = urnParam(id);
  const rec = world ? Object.values(world.byType).flat().find((r) => (urn ? r.urn === urn : r.id === id)) : undefined;
  const events = useRecordEvents(rec?.urn);
  // A Contact with an e-mail gets "Send for signature" when the Documents app is installed: its view opens with the e-mail already in the form.
  const [canSend, setCanSend] = useState(false);
  const [forgetting, setForgetting] = useState<null | { busy: boolean; problem: string }>(null);
  const admin = useSidebar((s) => s.canSetDefault);
  const isContact = rec?.type === "contact";
  useEffect(() => {
    if (!isContact) { setCanSend(false); return; }
    let live = true;
    tool<{ commands: { module: string; id: string }[] }>("views.list", {}).then((r) => { if (live) setCanSend(r.commands.some((c) => c.module === "appmods" && c.id === "documents-send")); }).catch(() => { if (live) setCanSend(false); });
    return () => { live = false; };
  }, [isContact]);
  const email = emailOf(rec?.data);
  const back = () => (router.canGoBack() ? router.back() : router.replace(`/u/records/${rec?.type ?? "contact"}` as never));
  if (error && !world) return <ErrorState title="This record did not load" reason={error.message} retry={reload} />;
  if (loading && !world) return <View className="min-h-0 flex-1"><PageHeader title="Record" onBack={back} /><View className="p-s4"><SkeletonRows rows={4} /></View></View>;
  const def = rec && world?.types.find((t) => t.name === rec.type);
  if (!world || !rec || !def) return <EmptyState title="That record is not here" body="It may have been removed, or it lives in a space you cannot see." action={{ label: "Go back", onPress: back }} />;
  const title = titleOf(def, rec);
  const space = SPACES.find((s) => s.id === rec.labels?.source_spaces?.[0])?.name;
  const vd = viewDefOf(def);
  // One header for the pushed page (ui-system.md section 7): the face or emblem, the title, "Matter \u00B7 Juniper Studio".
  return (
    <View className="min-h-0 flex-1">
      <PageHeader title={title} context={[def.label, space].filter(Boolean).join(" \u00B7 ")} faces={[{ kind: vd.initials ? "person" : "project", id: rec.id, name: title, seed: rec.data?.avatar_seed }]} onBack={back} actions={<View className="flex-row items-center gap-s2">{admin ? <Menu trigger={<IconButton icon="more" label="More" />} items={[{ label: "Delete for good...", onPress: () => setForgetting({ busy: false, problem: "" }) }]} /> : null}<Button kind="secondary" size="sm" label="Chat about this" onPress={() => router.push(`/u/chats/new?about=${encodeURIComponent(rec.urn)}&name=${encodeURIComponent(title)}` as never)} /></View>} />
      <View className="flex-row flex-wrap items-center gap-s2 px-s4 pt-s2">
        {factsOf(def, rec).map(([l, v]) => <Chip key={l}>{`${l}: ${v}`}</Chip>)}
        {email ? <Button kind="secondary" size="sm" icon="mail" label="Email" onPress={() => void Linking.openURL(`mailto:${email}`)} /> : null}
        {typeof rec.data?.phone === "string" && rec.data.phone ? <Button kind="secondary" size="sm" icon="phone" label="Call" onPress={() => void Linking.openURL(`tel:${String(rec.data.phone).replace(/\s/g, "")}`)} /> : null}
      </View>
      <View className="px-s4 pt-s2"><DocumentsBar def={def} rec={rec} related={relatedRecords(world.types, world.byType, def, rec)} email={email} canSend={canSend} /></View>
      <ScrollView contentContainerClassName="gap-s4 px-s4 pb-s12 pt-s2 max-w-page w-full self-center">
        <Appear index={1}><RecordPage def={def} rec={rec} world={world} events={events.data ?? []} env={env} onOpen={open} story={<RecordTimeline urn={rec.urn} />} onNew={(t, via) => router.push(`/u/record/new?type=${t}&via=${encodeURIComponent(via)}&to=${encodeURIComponent(rec.urn)}` as never)} /></Appear>
      </ScrollView>
      <Sheet open={!!forgetting} onClose={() => setForgetting(null)} title={`Forget ${title} for good?`}>
        {forgetting ? (
          <View className="gap-s3">
            <Text tone="muted">It cannot be undone. The text of every task about it is emptied, the record and its history are destroyed, its events lose their data and any sealed values are destroyed. Files linked to it stay in Files.</Text>
            <Text tone="muted">You approve it with your phone. An assistant can only propose it.</Text>
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
