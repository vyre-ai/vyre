import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, Icon, LoadingState, Row, SectionLabel, Text } from "@vyre/ui";
import type { IconName } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { dayKey, dayLabel } from "./days.js";
import { spaceList } from "../drive/real";
import { treeOf, type Body } from "../templates/model";

type Chat = { chat: string; title?: string; status?: string; last_active?: string };

/** A project's chats (work.chat.list by short name): the ones the person is in open, the others only show that they exist. */
export function ChatsPane({ slug }: { slug: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<Chat[] | null>(null);
  useEffect(() => { void callT<{ chats?: Chat[] }>("work.chat.list", { project: slug, limit: 50 }).then((r) => setRows(r.error ? [] : r.data?.chats ?? [])); }, [slug]);
  if (rows === null) return <LoadingState rows={3} />;
  return (
    <View className="gap-s3">
      <View className="flex-row"><Button kind="primary" size="sm" icon="plus" label="New chat" onPress={() => router.push(`/u/chats/new?project=${encodeURIComponent(slug)}` as never)} /></View>
      {rows.length === 0 ? <EmptyState title="No chats yet" body="Start one here and it belongs to this project." /> : (
        <Card flush>
          {rows.map((c, i) => (<View key={c.chat}>{i ? <Divider /> : null}<Row title={c.title || "New chat"} sub={c.status} onPress={() => router.push(`/u/chats/${c.chat}` as never)} /></View>))}
        </Card>
      )}
    </View>
  );
}

/** The project's own files (Projects/<id>/files): sealed at rest, opened only by the project's members. Opening one is the Drive's job. */
export function FilesPane({ id }: { id: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<{ path?: string; name?: string }[] | null>(null);
  useEffect(() => { void spaceList(undefined, `Projects/${id}/files`).then((r) => setRows(r.entries)).catch(() => setRows([])); }, [id]);
  if (rows === null) return <LoadingState rows={3} />;
  return (
    <View className="gap-s3">
      <View className="flex-row"><Button kind="ghost" size="sm" label="Open in Drive" onPress={() => router.push("/u/drive" as never)} /></View>
      {rows.length === 0 ? <EmptyState title="No files yet" body="Files kept here are encrypted and open only to this project's members and the agents working on it." /> : (
        <Card flush>{rows.map((f, i) => (<View key={f.path || i}>{i ? <Divider /> : null}<Row title={String(f.name || (f.path || "").split("/").pop() || "file")} /></View>))}</Card>
      )}
    </View>
  );
}

/** What the project's agents have learned here: the Space's facts, the agent's own and this project's, never another project's (memory.space.recall with the project). */
export function MemoryPane({ id }: { id: string }) {
  const [rows, setRows] = useState<{ id: string; text: string; scope?: string; by?: string }[] | null>(null);
  useEffect(() => { void callT<{ facts?: any[] }>("memory.space.recall", { project: id, limit: 50 }).then((r) => setRows(r.error ? [] : r.data?.facts ?? [])); }, [id]);
  if (rows === null) return <LoadingState rows={3} />;
  if (!rows.length) return <EmptyState title="Nothing remembered yet" body="Facts agents file in this project show here, with where each came from." />;
  return <Card flush>{rows.map((f, i) => (<View key={f.id}>{i ? <Divider /> : null}<Row title={f.text} sub={f.by} end={f.scope && f.scope.startsWith("project:") ? <Chip>This project</Chip> : undefined} /></View>))}</Card>;
}

/** The project's stages and tasks as it was pinned at start, with the stage it is in marked. */
export function StagesPane({ snapshot, stage, template }: { snapshot: string; stage?: string; template?: string }) {
  const router = useRouter();
  let body: Body | null = null;
  try { const j = JSON.parse(snapshot); body = { name: String(j.name || template || "Template"), stages: j.stages || [] }; } catch { body = null; }
  if (!body) return <EmptyState title="No stages" body="This project's stages could not be read." />;
  const tree = treeOf(body);
  return (
    <View className="gap-s3">
      {template ? <View className="flex-row"><Button kind="ghost" size="sm" label="Open the template" onPress={() => router.push(`/u/templates/${template}` as never)} /></View> : null}
      <Card flush>
        {tree.map((l, i) => {
          const here = l.depth === 0 && stage && l.text.replace(/^\d+\.\s*/, "") === stage;
          return (<View key={i}>{i ? <Divider /> : null}<Row title={l.text} sub={l.note} end={here ? <Chip tone="ok">Here</Chip> : undefined} /></View>);
        })}
      </Card>
      <Text size="caption" tone="label">Tasks appear in Now for whoever does them; the project moves on when a stage's required tasks are done.</Text>
    </View>
  );
}

type Entry = { type: string; kind: string; id: string; urn: string; title: string; line: string; at: number; mine?: boolean; shared?: boolean; chat?: string };
const ICON: Record<string, IconName> = { stage: "projects", task: "task", email: "mail", text: "chat", call: "phone", meeting: "cal", chat: "chat", file: "file", flow: "flows", document: "file", record: "records", person: "person" };
/** The project's story, newest first and grouped by day (work.timeline): stages it moved through, tasks done, messages sent, files shared, chats and Flow runs, each a type mark and one plain line. A chat shows when it is the viewer's or its people shared it, by title only. */
export function TimelinePane({ slug }: { slug: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<Entry[] | null>(null);
  useEffect(() => { void callT<{ entries?: Entry[] }>("work.timeline", { project: slug, limit: 200 }).then((r) => setRows(r.error ? [] : r.data?.entries ?? [])); }, [slug]);
  if (rows === null) return <LoadingState rows={3} />;
  if (!rows.length) return <EmptyState title="Nothing on the timeline yet" body="Stages, tasks, messages, files and shared chats linked to this project show here, newest first." />;
  const days: { key: string; at: number; items: Entry[] }[] = [];
  for (const e of rows) { const k = e.at ? dayKey(e.at) : "none"; const g = days[days.length - 1]; if (g && g.key === k) g.items.push(e); else days.push({ key: k, at: e.at, items: [e] }); }
  const open = (e: Entry) => router.push((e.type === "chat" && e.chat ? `/u/chats/${e.chat}` : e.type === "stage" || e.type === "project-start" || e.type === "file-share" || e.type === "flow-run" ? undefined : `/u/record/${e.id}`) as never);
  return (
    <View className="gap-s3">
      {days.map((g) => (
        <View key={g.key}>
          <SectionLabel>{dayLabel(g.at)}</SectionLabel>
          <Card flush>
            {g.items.map((e, i) => (
              <View key={`${e.type}:${e.id}`}>
                {i ? <Divider /> : null}
                <Row dense lead={<View className="pr-s3"><Icon name={ICON[e.kind] ?? "records"} /></View>} title={e.line} end={e.type === "chat" ? <Chip>{e.mine ? "Yours" : "Shared"}</Chip> : undefined}
                  onPress={e.type === "stage" || e.type === "project-start" || e.type === "file-share" ? undefined : () => open(e)} />
              </View>
            ))}
          </Card>
        </View>
      ))}
    </View>
  );
}
