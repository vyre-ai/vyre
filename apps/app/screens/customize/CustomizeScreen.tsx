import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, Divider, Field, Row, Segmented, Sheet, Switch, Text, allowsMock, showToast, markRef, Banner, LoadingState } from "@vyre/ui";
import { Page } from "../places/Frame";
import { CUSTOMIZE_SPACES } from "./data";
import { useTypes } from "./state";
import { useSpaces } from "../shell/state";
import { useShell } from "../shell/shared";
import { showingName } from "../shell/real-model";
import { TEMPLATES, buildType, templateName, typeLine } from "./logic.js";

/** Settings, Customize: the types a space owns, with their fields and stages. Add a type from a template. */
export function CustomizeScreen() {
  const router = useRouter();
  const { types, add, load, loading, error } = useTypes();
  const real = !allowsMock();
  const showing = useSpaces((s) => s.space);
  const shell = useShell((s) => s.data);
  useEffect(() => { void load(real && showing !== "all" ? showing : undefined); }, [showing]);
  const [space, setSpace] = useState("juniper");
  const [sheet, setSheet] = useState<null | { tpl: string; name: string; work: boolean }>(null);
  const list = real ? types : types.filter((t) => t.spaces.includes(space));
  const spaceName = real ? showingName(shell, showing) : CUSTOMIZE_SPACES.find(([id]) => id === space)?.[1] ?? space;
  return (
    <Page title="Customize" sub={real ? `Types, fields and stages in ${spaceName}` : spaceName} back="/u/settings">
      {real ? null : <Segmented label="Space" value={space} onChange={setSpace} options={CUSTOMIZE_SPACES} />}
      {error ? <Banner tone="warn">{error}</Banner> : null}
      {real && loading && !types.length ? <LoadingState rows={3} /> : null}
      <Card flush>
        {list.map((t, i) => (
          <View key={t.id}>
            {i ? <Divider /> : null}
            <Row lead={<Avatar of={markRef("project", t.plural, t.id)} />} title={t.plural} sub={typeLine(t)} end={t.kit ? <Chip>Kit</Chip> : undefined} onPress={() => router.push(`/u/settings/customize/${t.id}` as never)} />
          </View>
        ))}
      </Card>
      <View className="flex-row"><Button kind="primary" icon="plus" label="Add a type" onPress={() => setSheet({ tpl: "blank", name: templateName("blank"), work: true })} /></View>
      <Sheet open={!!sheet} onClose={() => setSheet(null)} title="Add a type">
        {sheet ? (
          <>
            <Text tone="muted">{`A new kind of record for ${spaceName}. It gets a list, a board and a record page.`}</Text>
            <Segmented label="Start from" value={sheet.tpl} onChange={(tpl) => setSheet({ ...sheet, tpl, name: templateName(tpl) })} options={TEMPLATES as [string, string][]} />
            <Field label="Name (one of them)" value={sheet.name} onChangeText={(name) => setSheet({ ...sheet, name })} />
            <Card><Row title="Holds work" sub="Tasks, stages, members and chats on every one." end={<Switch label="Holds work" on={sheet.work} onChange={(work) => setSheet({ ...sheet, work })} />} /></Card>
            <View className="flex-row gap-s2">
              <Button kind="primary" label="Add type" onPress={() => {
                const t = buildType(sheet.tpl, sheet.name, sheet.work, space, types.map((x) => x.id));
                add(t); setSheet(null); showToast(`${t.plural} added to ${spaceName}.`);
              }} />
              <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
            </View>
          </>
        ) : null}
      </Sheet>
    </Page>
  );
}
