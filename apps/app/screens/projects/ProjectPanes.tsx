import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, Field, Icon, IconButton, allowsMock, LoadingState, Row, SectionLabel, SpaceTag, Text, showToast } from "@vyre/ui";
import type { IconName } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { TimelineEntries, type Entry } from "./TimelineList";
import { spaceList } from "../drive/real";
import { usePlaceText } from "../../src/real/PlaceTag";
import { treeOf, type Body } from "../templates/model";
import { ChatsList } from "../chats/ChatsList";
import { chatsFrom, chatsOrdered, sampleChats, type ChatRow } from "../chats/chats-model.js";
import { useChatMenu } from "../chats/useChatMenu";

/** A project's chats (work.chat.list for the project, by short name or record id): the same rows and the same row menu as the Chat list; the ones the person is in open, the others only show that they exist. */
export function ChatsPane({ refId, slug, name }: { refId: string; slug: string; name?: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    // The sample world has no box: its chats are the sample ones filed under this project's name (or a few, so the page shows what a busy project looks like).
    if (allowsMock()) { const all = chatsOrdered(sampleChats(Date.now())); const mine = all.filter((c) => c.project === name); setRows(mine.length ? mine : all.slice(0, 3)); return; }
    void callT("work.chat.list", { project: refId, limit: 50 }).then((r) => setRows(r.error ? [] : chatsOrdered(chatsFrom(r.data))));
  }, [refId, n, name]);
  const { menu, sheets } = useChatMenu(rows ?? [], () => setN((x) => x + 1));
  const [now] = useState(Date.now());
  if (rows === null) return <LoadingState rows={3} />;
  return (
    <View className="gap-s3">
      <View className="flex-row"><Button kind="primary" size="sm" icon="plus" label="New chat" onPress={() => router.push(`/u/chats/new?project=${encodeURIComponent(slug || refId)}` as never)} /></View>
      {rows.length === 0 ? <EmptyState title="No chats yet" body="Start one here and it belongs to this project." /> : <ChatsList rows={rows} now={now} places={null} menu={menu} onOpen={(id) => router.push({ pathname: "/u/chats/[id]", params: { id } })} />}
      {sheets}
    </View>
  );
}

/** The project's own files (Projects/<id>/files): sealed at rest, opened only by the project's members. Opening one is the Drive's job. */
export function FilesPane({ id }: { id: string }) {
  const fileTag = usePlaceText("showing");
  const router = useRouter();
  const [rows, setRows] = useState<{ path?: string; name?: string }[] | null>(null);
  // The Files screen's own door (files.drive.space.list); files.list is not a tool any module registers.
  useEffect(() => { void spaceList(undefined, `Projects/${id}/files`).then((r) => setRows(r.entries.filter((e) => e.path && (allowsMock() || String(e.path).startsWith(`Projects/${id}/files/`))))).catch(() => setRows([])); }, [id]);
  if (rows === null) return <LoadingState rows={3} />;
  return (
    <View className="gap-s3">
      <View className="flex-row"><Button kind="ghost" size="sm" label="Open in Files" onPress={() => router.push("/u/files" as never)} /></View>
      {rows.length === 0 ? <EmptyState title="No files yet" body="Files kept here are encrypted and open only to this project's members and the agents working on it." /> : (
        <Card flush>{rows.slice(0, 5).map((f, i) => (<View key={f.path || i}>{i ? <Divider /> : null}<Row dense title={String(f.name || (f.path || "").split("/").pop() || "file")} end={fileTag ? <SpaceTag text={fileTag} /> : undefined} /></View>))}{rows.length > 5 ? <><Divider /><Row dense title={`${rows.length - 5} more in Files`} chevron onPress={() => router.push("/u/files" as never)} /></> : null}</Card>
      )}
    </View>
  );
}

type Fact = { id: string; urn?: string; text: string; source?: string; scope?: string; by?: string; filed_at?: string | number; kind?: string };
/** "From a chat", "From a file" or "Added by hand", and where to open it. */
function sourceOf(f: Fact): { line: string; href: string | null } {
  const s = String(f.source || "");
  const chat = /^(?:chat|session|thread):(.+)$/.exec(s);
  if (chat) return { line: "From a chat", href: `/u/chats/${encodeURIComponent(chat[1])}` };
  if (s.startsWith("vyre://") || s.includes("/files/")) return { line: "From a file", href: "/u/files" };
  return { line: s ? `From ${s}` : "Added by hand", href: null };
}
const whenOf = (t: string | number | undefined): string => { const n = typeof t === "number" ? t : t ? Date.parse(t) : NaN; if (!Number.isFinite(n)) return ""; const d = Math.floor((Date.now() - n) / 86400000); return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(n).toLocaleDateString(); };

/** What this project has learned (memory.space.recall for the project): each item says what was learned, where it came from and when, with Pin, Edit and Forget, and an "Add a memory" field (memory.space.file, memory.space.retire, memory.pin). */
export function MemoryPane({ id }: { id: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<Fact[] | null>(null);
  const [n, setN] = useState(0);
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => { void callT<{ facts?: Fact[] }>("memory.space.recall", { project: id, limit: 50 }).then((r) => setRows(r.error ? [] : r.data?.facts ?? [])); }, [id, n]);
  const again = () => setN((x) => x + 1);
  const fail = (e?: { message: string }) => { if (e) showToast(e.message || "That did not go through."); else again(); };
  const add = async () => { const t = adding.trim(); if (!t) return; const r = await callT("memory.space.file", { text: t, source: "note:by-hand", kind: "note", scope: `project:${id}` }); if (!r.error) setAdding(""); fail(r.error); };
  const forget = async (f: Fact) => fail((await callT("memory.space.retire", { id: f.id })).error);
  const pin = async (f: Fact) => fail((await callT("memory.pin", { node: f.urn || f.id, scope: `project:${id}` })).error);
  const saveEdit = async (f: Fact) => { if (!editing || !editing.text.trim()) return; const r = await callT("memory.space.file", { text: editing.text.trim(), source: f.source || "note:by-hand", kind: f.kind || "note", scope: `project:${id}` }); if (r.error) { fail(r.error); return; } await callT("memory.space.retire", { id: f.id }); setEditing(null); again(); };
  if (rows === null) return <LoadingState rows={3} />;
  return (
    <View className="gap-s2">
      {rows.length ? (
        <Card flush>
          {rows.map((f, i) => {
            const src = sourceOf(f);
            return (
              <View key={f.id}>{i ? <Divider /> : null}
                {editing?.id === f.id ? (
                  <View className="gap-s2 p-s3"><Field name="Edit this memory" value={editing.text} onChangeText={(t) => setEditing({ id: f.id, text: t })} multiline lines={3} /><View className="flex-row gap-s2"><Button size="sm" label="Save" onPress={() => void saveEdit(f)} /><Button size="sm" kind="ghost" label="Cancel" onPress={() => setEditing(null)} /></View></View>
                ) : (
                  <Row dense title={f.text} sub={[src.line, whenOf(f.filed_at), f.by].filter(Boolean).join(" · ")} onPress={src.href ? () => router.push(src.href as never) : undefined}
                    end={<View className="flex-row"><IconButton icon="pin" label="Pin this memory" onPress={() => void pin(f)} /><IconButton icon="edit" label="Edit this memory" onPress={() => setEditing({ id: f.id, text: f.text })} /><IconButton icon="trash" label="Forget this memory" onPress={() => void forget(f)} /></View>} />
                )}
              </View>
            );
          })}
        </Card>
      ) : <EmptyState title="Nothing remembered yet" body="What is learned in this project's chats and files shows here, with where it came from." />}
      <Field name="Add a memory" value={adding} onChangeText={setAdding} placeholder="Something every chat here should remember" />
      <View className="self-start"><Button size="sm" kind="secondary" label="Add a memory" disabled={!adding.trim()} onPress={() => void add()} /></View>
    </View>
  );
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

/** The project's story, newest first and grouped by day (work.timeline): stages it moved through, tasks done, messages sent, files shared, chats and Flow runs, each a type mark and one plain line. */
export function TimelinePane({ slug }: { slug: string }) {
  const [rows, setRows] = useState<Entry[] | null>(null);
  useEffect(() => { void callT<{ entries?: Entry[] }>("work.timeline", { project: slug, limit: 200 }).then((r) => setRows(r.error ? [] : r.data?.entries ?? [])); }, [slug]);
  if (rows === null) return <LoadingState rows={3} />;
  if (!rows.length) return <EmptyState title="Nothing on the timeline yet" body="Stages, tasks, messages, files and shared chats linked to this project show here, newest first." />;
  return <TimelineEntries rows={rows} />;
}
