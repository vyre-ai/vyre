import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, EmptyState, Text, titleOf, ErrorState, LoadingState, PageHeader, RecordForm, createPayload, prefillFromLink, formErrors, showToast, useFieldEnv, useRecordsWorld, useStore, viewDefOf } from "@vyre/ui";

import { findDupes } from "./dupes.js";
import { plainError } from "../../src/real/error-note.js";

const say = (e: unknown) => plainError(e, "That did not save.");

/** /u/record/new?type=<name>: the create form of any type, drawn from its definition, in its groups. A sealed value is put after the record exists, through the same putSealed a sealed field always used. */
export function RecordNewScreen() {
  const { type, via, to } = useLocalSearchParams<{ type: string; via?: string; to?: string }>();
  const router = useRouter();
  const store = useStore();
  const { data: world, loading, error, reload } = useRecordsWorld();
  const env = useFieldEnv(world, (urn: string) => router.push(`/u/record/${urn.split("/").pop()}` as never));
  const [values, setValues] = useState<Record<string, any>>({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = !!world?.types.find((t: any) => t.name === type);
  // Started from another record's page: it begins linked to that record.
  useEffect(() => { const d = world?.types.find((t: any) => t.name === type); if (d && via && to) setValues((v) => ({ ...prefillFromLink(d, String(via), String(to)), ...v })); }, [ready]);
  const back = () => (router.canGoBack() ? router.back() : router.replace(`/u/records/${type}` as never));
  if (error && !world) return <ErrorState title="Records did not load" reason={plainError(error, "Records did not answer.")} retry={reload} />;
  if (loading && !world) return <View className="min-h-0 flex-1"><PageHeader title="New" onBack={back} /><LoadingState rows={4} /></View>;
  const def = world?.types.find((t: any) => t.name === type);
  if (!def) return <EmptyState title="That type is not here" body={`This space has no record type called "${type}".`} action={{ label: "Go back", onPress: back }} />;
  const fields = def.fields.map((f: any) => ({ ...f, sealed: f.kind === "sealed" || !!f.seal }));
  const errors = tried ? formErrors(fields, values) : {};
  const noun = def.label.toLowerCase();
  // Someone who looks like the person being typed: shown as a hint above the form, never in the way.
  const dupes = findDupes(def, world?.byType[def.name] ?? [], values, (r: any) => titleOf(def, r));
  const create = async (another: boolean) => {
    if (Object.keys(formErrors(fields, values)).length) { setTried(true); return; }
    const { plain, sealed } = createPayload(fields, values);
    setBusy(true);
    try {
      const rec: any = await store.create(def.name, plain);
      for (const [name, v] of Object.entries(sealed)) await store.putSealed(rec.urn, name, String(v));
      showToast(`${def.label} created.`);
      if (another) { setValues({}); setTried(false); setBusy(false); return; }
      router.replace(`/u/record/${rec.id}` as never);
    } catch (e) { setBusy(false); showToast(say(e)); }
  };
  return (
    <View className="min-h-0 flex-1">
      <PageHeader title={`New ${noun}`} context={viewDefOf(def).plural} onBack={back} />
      <ScrollView contentContainerClassName="gap-s4 px-s4 pb-s12 pt-s2 max-w-page w-full self-center">
        {dupes.length ? (
          <Banner tone="warn">
            <Text strong>{`Looks like ${dupes[0].title} already exists.`}</Text>
            <Text size="caption" tone="muted">{`It has ${dupes[0].why}. Open it instead, or go on if it is someone else.`}</Text>
            <View className="flex-row flex-wrap gap-s2">{dupes.map((d) => <Button key={d.urn} kind="secondary" size="sm" label={`Open ${d.title}`} onPress={() => router.push(`/u/record/${d.urn.split("/").pop()}` as never)} />)}</View>
          </Banner>
        ) : null}
        {tried && Object.keys(errors).length ? <Banner tone="warn">{`${Object.keys(errors).length} ${Object.keys(errors).length === 1 ? "field needs" : "fields need"} a value.`}</Banner> : null}
        <RecordForm fields={fields} groups={def.groups ?? []} values={values} onChange={(n, v) => setValues({ ...values, [n]: v })} errors={errors} env={env} noun={noun}
          onCreate={() => { if (!busy) void create(false); }} onCreateMore={() => { if (!busy) void create(true); }} onCancel={back} />
      </ScrollView>
    </View>
  );
}
