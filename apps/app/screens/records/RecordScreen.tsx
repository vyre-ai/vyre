import { useCallback } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Chip, EmptyState, ErrorState, RecordPage, Text, titleOf, urnParam, useFieldEnv, useRecordEvents, useRecordsWorld } from "@vyre/ui";

/** /u/record/<id>: one record's page. The id is the record's urn (vyre://space/type/id, encoded) or its bare id (the uuid); both find the same record. */
export function RecordScreen({ id }: { id: string }) {
  const router = useRouter();
  const { data: world, loading, error, reload } = useRecordsWorld();
  const open = useCallback((urn: string) => router.push(`/u/record/${urn.split("/").pop()}` as never), [router]);
  const env = useFieldEnv(world, open);
  const urn = urnParam(id);
  const rec = world ? Object.values(world.byType).flat().find((r) => (urn ? r.urn === urn : r.id === id)) : undefined;
  const events = useRecordEvents(rec?.urn);
  const back = () => (router.canGoBack() ? router.back() : router.replace(`/u/records/${rec?.type ?? "contact"}` as never));
  if (error && !world) return <ErrorState title="Could not load this record" reason={error.message} retry={reload} />;
  if (loading && !world) return <View className="p-s6"><Text tone="label">Loading</Text></View>;
  const def = rec && world?.types.find((t) => t.name === rec.type);
  if (!world || !rec || !def) return <EmptyState title="That record is not here" body="It may have been removed, or it lives in a space you cannot see." action={{ label: "Go back", onPress: back }} />;
  return (
    <ScrollView contentContainerClassName="gap-s4 p-s4 max-w-page w-full self-center">
      <View className="flex-row items-center gap-s3">
        <Button size="sm" kind="ghost" label={"‹ Back"} accessibilityLabel="Back" onPress={back} />
      </View>
      <View className="gap-s2">
        <Text size="page" strong>{titleOf(def, rec)}</Text>
        <View className="flex-row flex-wrap gap-s2"><Chip>{def.label}</Chip></View>
      </View>
      <RecordPage def={def} rec={rec} world={world} events={events.data ?? []} env={env} onOpen={open} />
    </ScrollView>
  );
}
