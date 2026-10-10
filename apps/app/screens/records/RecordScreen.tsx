import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Appear, Button, EmptyState, ErrorState, PageHeader, RecordPage, SkeletonRows, titleOf, urnParam, useFieldEnv, useRecordEvents, useRecordsWorld, viewDefOf } from "@vyre/ui";
import { useShell } from "../shell/shared";
import { RecordTimeline } from "./RecordTimeline";
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
      <PageHeader title={title} context={[def.label, space].filter(Boolean).join(" \u00B7 ")} faces={[{ kind: vd.initials ? "person" : "project", id: rec.id, name: title, seed: rec.data?.avatar_seed }]} onBack={back} actions={<Button kind="secondary" size="sm" label="Chat about this" onPress={() => router.push(`/u/chats/new?about=${encodeURIComponent(rec.urn)}&name=${encodeURIComponent(title)}` as never)} />} />
      {canSend && email ? <View className="flex-row px-s4 pt-s2"><Button kind="ghost" size="sm" label="Send for signature" onPress={() => router.push(`/u/module/appmods/documents-send?q=${encodeURIComponent(email)}` as never)} /></View> : null}
      <ScrollView contentContainerClassName="gap-s4 px-s4 pb-s12 pt-s2 max-w-page w-full self-center">
        <Appear index={1}><RecordPage def={def} rec={rec} world={world} events={events.data ?? []} env={env} onOpen={open} story={<RecordTimeline urn={rec.urn} />} /></Appear>
      </ScrollView>
    </View>
  );
}
