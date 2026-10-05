import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Divider, EmptyState, Field, Row, SectionLabel, Text, titleOf, useRecordsWorld } from "@vyre/ui";
import { Page } from "../places/Frame";
import { tool } from "../../src/real/box";
import { groupsOf, recordGroup, routeFor, type Group } from "./search-model.js";

/** /u/search: one box over the person's records and what the box can find (files, vault names, artifacts, GitHub). Names only; a sealed value is never searched. */
export default function SearchScreen() {
  const router = useRouter();
  const { data: world } = useRecordsWorld();
  const [q, setQ] = useState("");
  const [fromBox, setFromBox] = useState<Group[]>([]);
  const [down, setDown] = useState<string[]>([]);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) { setFromBox([]); setDown([]); return; }
    let live = true;
    const t = setTimeout(() => {
      tool<{ groups?: unknown[]; unavailable?: string[] }>("mentions.search", { q: text, limit: 8 }).then((a) => { if (live) { setFromBox(groupsOf(a)); setDown(a?.unavailable ?? []); } }).catch(() => { if (live) { setFromBox([]); setDown([]); } });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const mine = useMemo(() => recordGroup(world, q, (d, r) => titleOf(d, r)), [world, q]);
  const groups = [...(mine ? [mine] : []), ...fromBox];
  const text = q.trim();
  return (
    <Page top title="Search">
      <Field label="Search" name="Search" value={q} onChangeText={setQ} placeholder="A person, a matter, a file" />
      {text.length < 2 ? <Card><EmptyState title="Search your records and files" body="Type two letters or more. Sealed values are never searched." /></Card>
        : !groups.length ? <Card><EmptyState title={`Nothing found for "${text}"`} body={down.length ? `${down.join(", ")} did not answer in time.` : "Try another word."} /></Card>
        : groups.map((g) => (
          <View key={g.kind} className="gap-s1">
            <SectionLabel>{g.label}</SectionLabel>
            <Card flush>
              {g.items.map((it, i) => {
                const to = routeFor(g.kind, it.id);
                return <View key={it.id}>{i ? <Divider /> : null}<Row dense title={it.name} sub={it.hint} chevron={Boolean(to)} onPress={to ? () => router.push(to as never) : undefined} /></View>;
              })}
            </Card>
          </View>
        ))}
      {down.length && groups.length ? <Text size="caption" tone="label">{`${down.join(", ")} did not answer in time.`}</Text> : null}
    </Page>
  );
}
