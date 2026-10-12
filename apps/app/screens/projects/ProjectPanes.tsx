import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, Icon, LoadingState, Row, SectionLabel, SpaceTag, Text } from "@vyre/ui";
import type { IconName } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { TimelineEntries, type Entry } from "./TimelineList";
import { spaceList } from "../drive/real";
import { showingJoined } from "../../src/real/team-join";
import { usePlaceText } from "../../src/real/PlaceTag";
import { pickFiles } from "../../src/chat/attach-pick";
import { ADD_WORDS, OPEN_WORDS, checkUpload, openedView } from "./files-model.js";
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

/** The project's own files (Projects/<id>/files): sealed at rest, opened only by the project's members. For a member of a joined team: the files through the team's door, open a text file and add one, within the limits the door carries (said first). */
export function FilesPane({ id }: { id: string }) {
  const fileTag = usePlaceText("showing");
  const router = useRouter();
  const [rows, setRows] = useState<{ path?: string; name?: string }[] | null>(null);
  const [member, setMember] = useState(false);
  const [problem, setProblem] = useState("");
  const [opened, setOpened] = useState<{ name: string; text?: string; words?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  // a member of a joined team lists the project's files through the team's door (files.list: the owner's and team's only); her own Drive screens are her home's
  useEffect(() => {
    void showingJoined().catch(() => false).then(async (joined) => {
      setMember(joined);
      if (!joined) return spaceList(undefined, `Projects/${id}/files`).then((r) => r.entries);
      const r = await callT<{ files?: { name: string }[] }>("files.list", { project: id });
      if (r.error) { setProblem(r.error.message); return []; }
      setProblem("");
      return (r.data?.files ?? []).map((f) => ({ name: f.name, path: `Projects/${id}/files/${f.name}` }));
    }).then(setRows).catch(() => setRows([]));
  }, [id, n]);
  const open = async (name: string) => {
    setProblem(""); setBusy(true);
    const r = await callT<{ name: string; size?: number; data?: string }>("files.read", { project: id, name });
    setBusy(false);
    if (r.error) { setProblem(r.error.message); return; }
    setOpened(openedView(r.data as { name: string; data?: string }));
  };
  const add = async () => {
    setProblem(""); setBusy(true);
    try {
      const picked = await pickFiles(false);
      for (const f of picked) {
        const ok = checkUpload(f);
        if ("error" in ok) { setProblem(String(ok.error)); break; }
        const r = await callT("files.upload", { project: id, name: ok.name, data: ok.data });
        if (r.error) { setProblem(r.error.message); break; }
      }
      setN((x) => x + 1);
    } catch (e) { setProblem(e instanceof Error ? e.message : "That file could not be added."); }
    setBusy(false);
  };
  if (rows === null) return <LoadingState rows={3} />;
  return (
    <View className="gap-s3">
      <View className="flex-row flex-wrap items-center gap-s2">
        {member ? <Button size="sm" label={busy ? "Working" : "Add a file"} disabled={busy} onPress={() => void add()} /> : null}
        <Button kind="ghost" size="sm" label="Open in Drive" onPress={() => router.push("/u/drive" as never)} />
      </View>
      {member ? <Text size="caption" tone="label">{`${ADD_WORDS} ${OPEN_WORDS}`}</Text> : null}
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      {rows.length === 0 ? <EmptyState title="No files yet" body="Files kept here are encrypted and open only to this project's members and the agents working on it." /> : (
        <Card flush>{rows.map((f, i) => (<View key={f.path || i}>{i ? <Divider /> : null}<Row title={String(f.name || (f.path || "").split("/").pop() || "file")} end={fileTag ? <SpaceTag text={fileTag} /> : undefined} onPress={member && f.name ? () => void open(String(f.name)) : undefined} /></View>))}</Card>
      )}
      {opened ? (
        <Card>
          <View className="gap-s2">
            <Text strong>{opened.name}</Text>
            {opened.text !== undefined ? <Text mono>{opened.text}</Text> : <Text tone="muted">{opened.words}</Text>}
            <View className="flex-row"><Button kind="ghost" size="sm" label="Close" onPress={() => setOpened(null)} /></View>
          </View>
        </Card>
      ) : null}
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

/** The project's story, newest first and grouped by day (work.timeline): stages it moved through, tasks done, messages sent, files shared, chats and Flow runs, each a type mark and one plain line. */
export function TimelinePane({ slug }: { slug: string }) {
  const [rows, setRows] = useState<Entry[] | null>(null);
  useEffect(() => { void callT<{ entries?: Entry[] }>("work.timeline", { project: slug, limit: 200 }).then((r) => setRows(r.error ? [] : r.data?.entries ?? [])); }, [slug]);
  if (rows === null) return <LoadingState rows={3} />;
  if (!rows.length) return <EmptyState title="Nothing on the timeline yet" body="Stages, tasks, messages, files and shared chats linked to this project show here, newest first." />;
  return <TimelineEntries rows={rows} />;
}
