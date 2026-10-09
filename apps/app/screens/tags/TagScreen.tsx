import { View } from "react-native";
import { useRouter } from "expo-router";
import { EmptyState, ErrorState, LargeTitleScreen, ListView, LoadingState, Text, useFieldEnv, useRecordsWorld, viewDefOf } from "@vyre/ui";
import { PinToSidebar } from "../shell/PinToSidebar";
import { href, normalize, parse } from "../../../../lib/tags.js";

/** /u/tags/<tag>: everything with this tag, one list per record type that carries tags (projects, chats, contacts, tasks ...). Pin it and it is a saved tag filter in the sidebar (R031-02). */
export function TagScreen({ tag }: { tag: string }) {
  const router = useRouter();
  const { data: world, loading, error, reload } = useRecordsWorld();
  const open = (urn: string) => router.push(`/u/record/${urn.split("/").pop()}` as never);
  const env = useFieldEnv(world, open);
  const t = normalize(tag);
  if (!t) return <EmptyState title="Not a tag" body="A tag is lower-case letters, numbers and dashes." />;
  if (error && !world) return <ErrorState title="Tags did not load" reason={error.message} retry={reload} />;
  if (loading && !world) return <LargeTitleScreen title={`#${t}`}><LoadingState rows={4} /></LargeTitleScreen>;
  const groups = (world?.types || [])
    .filter((d: any) => (d.fields || []).some((f: any) => f.name === "tags"))
    .map((d: any) => ({ def: d, rows: ((world as any).byType[d.name] || []).filter((r: any) => parse(r.data?.tags).includes(t)) }))
    .filter((g: any) => g.rows.length);
  return (
    <LargeTitleScreen title={`#${t}`} own onRefresh={reload}>
      <PinToSidebar id={`tag-${t}`} label={`#${t}`} href={href(t)} />
      {groups.length === 0 ? <EmptyState title="Nothing has this tag yet" body={`Tag a project, chat, contact or task with #${t} and it shows up here.`} /> : null}
      {groups.map((g: any) => (
        <View key={g.def.name} className="gap-s2">
          <Text size="caption" tone="label">{viewDefOf(g.def).plural}</Text>
          <ListView def={g.def} rows={g.rows} env={env} onOpen={(rec: any) => router.push(`/u/record/${rec.id}` as never)} />
        </View>
      ))}
    </LargeTitleScreen>
  );
}
