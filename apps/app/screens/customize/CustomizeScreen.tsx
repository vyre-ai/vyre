import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, LoadingState, ModelMap, Sheet, Text, TypeStarter, allowsMock, showToast, useRecordsWorld } from "@vyre/ui";
import type { MapType, Starter } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useSpaces } from "../shell/state";
import { useKernelTypes } from "./kernel-types";
import { TEMPLATES, buildType, templateBlurb, templateName } from "./logic.js";
import { toKernelType } from "./real-model.js";

const STARTERS: Starter[] = [
  { id: "blank", label: "Blank", blurb: "One field, Title. Add the rest yourself.", fields: ["Title"] },
  ...TEMPLATES.filter(([id]) => id !== "blank").map(([id, label]) => ({ id, label, blurb: templateBlurb(id), fields: buildType(id, "x", false, "s").fields.map((f: any) => f.label) })),
];

/** Settings, Customize: the model of the space (every record type, its counts and links), and Add a type. A type opens to its fields, groups and stages. */
export function CustomizeScreen() {
  const router = useRouter();
  const { defs, load, loading, error, create, busy } = useKernelTypes();
  const working = Object.values(busy);
  const showing = useSpaces((s) => s.space);
  const { data: world } = useRecordsWorld();
  const [sheet, setSheet] = useState<null | { id: string; name: string; work: boolean }>(null);
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
      <View className="flex-row"><Button kind="primary" icon="plus" label="Add a type" loading={working.length > 0} disabled={working.length > 0} onPress={() => setSheet({ id: "blank", name: templateName("blank"), work: true })} /></View>
      <Sheet open={!!sheet} onClose={() => setSheet(null)} title="Add a type">
        {sheet ? (
          <View className="gap-s3">
            <Text tone="muted">A new kind of record. It gets a list, a board and a record page.</Text>
            <TypeStarter starters={STARTERS} picked={sheet.id} onPick={(id) => setSheet({ ...sheet, id, name: templateName(id) })} name={sheet.name} onName={(name) => setSheet({ ...sheet, name })} work={sheet.work} onWork={(work) => setSheet({ ...sheet, work })} />
            <View className="flex-row gap-s2">
              <Button kind="primary" label="Add type" onPress={() => {
                const t = buildType(sheet.id, sheet.name, sheet.work, showing, defs.map((x) => x.name));
                create(toKernelType(t, undefined) as any); setSheet(null); showToast(`${t.plural} added.`);
              }} />
              <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
            </View>
          </View>
        ) : null}
      </Sheet>
    </Page>
  );
}
