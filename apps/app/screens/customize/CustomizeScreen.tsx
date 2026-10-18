import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, LoadingState, ModelMap, Text, allowsMock, showToast, useRecordsWorld } from "@vyre/ui";
import type { MapType } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useSpaces } from "../shell/state";
import { useKernelTypes } from "./kernel-types";
import { AddTypeSheet } from "./AddTypeSheet";

/** Settings, Customize: the model of the space (every record type, its counts and links), and Add a type. A type opens to its fields, groups and stages. */
export function CustomizeScreen() {
  const router = useRouter();
  const { defs, load, loading, error, create, busy } = useKernelTypes();
  const working = Object.values(busy);
  const showing = useSpaces((s) => s.space);
  const { data: world } = useRecordsWorld();
  const [adding, setAdding] = useState(false);
  useEffect(() => { void load(!allowsMock() && showing !== "all" ? showing : undefined); }, [showing]);
  const plural = (n: string) => defs.find((d) => d.name === n)?.label ?? n;
  const types: MapType[] = defs.map((d) => ({
    name: d.name, label: d.label, plural: d.plural as string ?? `${d.label}s`, fields: d.fields.length, records: world?.byType[d.name]?.length ?? 0,
    links: d.fields.filter((f: any) => f.kind === "link" && f.to).map((f: any) => ({ to: f.to, label: plural(f.to), many: !!f.many })),
  }));
  return (
    <Page title="Objects" sub="Objects, fields and groups">
      {error ? <Banner tone="warn">{error}</Banner> : null}
      {working.length ? <Banner><Text strong>{`Setting up ${working.join(", ")} in Records...`}</Text><Text size="caption" tone="muted">This can take a minute. You can leave this page; it finishes on its own.</Text></Banner> : null}
      {loading && !defs.length ? <LoadingState rows={3} /> : <ModelMap types={types} onOpen={(n) => router.push(`/u/settings/customize/${n}` as never)} />}
      <View className="flex-row"><Button kind="primary" icon="plus" label="Add a type" loading={working.length > 0} disabled={working.length > 0} onPress={() => setAdding(true)} /></View>
      <AddTypeSheet open={adding} onClose={() => setAdding(false)} space={showing} taken={defs.map((x) => x.name)} onAdd={(t, plural) => { create(t); showToast(`${plural} added.`); }} />
    </Page>
  );
}
