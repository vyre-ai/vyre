// The strip under a project's title: where it is in its stages (a pill with the full stage name and its place in the template) and who has access (faces, with Manage going to the Team tab).
// Stages and people are read from what the page already has (the record's pinned template snapshot) and projects.list (a project's people); nothing new on the server.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Chip, Text, markRef } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";

/** "Stage 2 of 5" and the stage's name from the project's pinned template, or null for a free-flow project. */
export function stageOf(data: Record<string, unknown> | undefined | null): { name: string; at: number; of: number } | null {
  if (!data || typeof data.template_snapshot !== "string") return null;
  try {
    const stages: { name?: string }[] = JSON.parse(data.template_snapshot).stages ?? [];
    const cur = String(data.template_stage ?? "");
    const i = stages.findIndex((s) => String(s.name ?? "").replace(/^\d+\.\s*/, "") === cur.replace(/^\d+\.\s*/, ""));
    return cur ? { name: cur.replace(/^\d+\.\s*/, ""), at: i + 1, of: stages.length } : null;
  } catch { return null; }
}

/** The names of the people on a project (projects.list's `people` for its short name). */
function usePeople(slug: string) {
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    if (!slug) return;
    let live = true;
    void callT<{ projects?: { slug?: string; people?: string[] | string }[] }>("projects.list", {}).then((r) => {
      const row = r.data?.projects?.find((p) => p.slug === slug);
      const list = Array.isArray(row?.people) ? row!.people : typeof row?.people === "string" ? row.people.split(",") : [];
      if (live) setPeople(list.map((x) => String(x).trim()).filter(Boolean));
    });
    return () => { live = false; };
  }, [slug]);
  return people;
}

export function ProjectHeaderStrip({ data, slug, onManage }: { data: Record<string, unknown> | undefined; slug: string; onManage: () => void }) {
  const stage = stageOf(data);
  const people = usePeople(slug);
  if (!stage && !people.length) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-s3">
      {stage ? <Chip tone="accent" icon="flows">{`Stage ${stage.at > 0 ? `${stage.at} of ${stage.of}: ` : ""}${stage.name}`}</Chip> : null}
      <View className="flex-1" />
      {people.length ? (
        <View className="flex-row items-center gap-s2" accessibilityLabel={`Access: ${people.join(", ")}`}>
          <View className="flex-row">{people.slice(0, 4).map((n, i) => <View key={n} style={{ marginLeft: i ? -8 : 0 }}><Avatar of={markRef("person", n)} size={24} /></View>)}</View>
          <Text size="caption" tone="label">{people.length === 1 ? people[0] : `${people.length} people`}</Text>
        </View>
      ) : null}
      <Button kind="ghost" size="sm" label="Manage access" onPress={onManage} />
    </View>
  );
}
