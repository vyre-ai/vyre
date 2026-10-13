import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { AvatarStack, Banner, Button, Card, Chip, Divider, EmptyState, Field, LoadingState, Row, Sheet, Text, markRef, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { ProjectPicker } from "../../src/chat/ProjectPicker";
import { listProjects, moveChat, type ProjectRef } from "../../src/chat/useChatProject";
import { chatPrefs, useChatPrefs } from "../../src/state/chat-prefs";
import { Page } from "../places/Frame";
import { useChats } from "../../src/state/chats";
import { useGap } from "../../src/state/setup-gap";
import { useConnection } from "../../src/state/connection";
import { refresh } from "../../src/state/live";
import { ageOf } from "./chat-model.js";
import { tool } from "../../src/real/box";
import { ChatsList } from "./ChatsList";
import { UNSUPPORTED, chatState, computerOf, chatSub, chatsOrdered, chatsShown, chatsView } from "./chats-model.js";
import { ensurePersistent } from "../../src/state/persistent-chat";
import { ProviderBadge } from "@vyre/ui";
import { PlaceTag, usePlaceText } from "../../src/real/PlaceTag";

/** /u/chats: every chat you can see, the ones that need you first. One row type for solo, group and people-only chats; a row for a chat you are not in is greyed and does not open. */
export default function ChatsScreen() {
  const chatsTag = usePlaceText("showing");
  const router = useRouter();
  const chats = useChats();
  const gap = useGap();
  const status = useConnection();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  // Which chats run on one of your own computers (runner.places): a box without it answers nothing and the list says nothing about places.
  const [places, setPlaces] = useState<unknown>(null);
  useEffect(() => { let live = true; tool("runner.places", {}).then((x) => { if (live) setPlaces(x); }).catch(() => {}); return () => { live = false; }; }, [chats.rows.length]);
  const go = (p: string) => router.push(p as never);
  // your assistant has one chat, pinned at the top: it is started the first time you are here
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || chats.from === "none" || chats.from === "unsupported" || chats.rows.some((c) => c.pinned === "assistant")) return;
    asked.current = true;
    void ensurePersistent("assistant").then((r) => { if ("chat" in r) void refresh(); }).catch(() => { asked.current = false; });
  }, [chats.from, chats.rows]);
  const prefs = useChatPrefs();
  // Your own pins go first (after your assistant's chat), in the order the list already has.
  const ordered = chatsOrdered(chatsShown(chats.rows));
  const rows = [...ordered.filter((c) => c.pinned === "assistant"), ...ordered.filter((c) => c.pinned !== "assistant" && prefs.pinned.includes(c.id)), ...ordered.filter((c) => c.pinned !== "assistant" && !prefs.pinned.includes(c.id))];
  // The row menu: Move to a project, Rename (the box's work.chat.move and work.chat.rename), and your own Pin and Mute.
  const [moving, setMoving] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  useEffect(() => { if (moving) void listProjects().then(setProjects); }, [moving]);
  const menu = (id: string) => [
    { label: "Open", onPress: () => router.push({ pathname: "/u/chats/[id]", params: { id } }) },
    { label: "Move to a project", onPress: () => setMoving(id) },
    { label: "Rename", onPress: () => setRenaming({ id, title: chats.rows.find((c) => c.id === id)?.title ?? "" }) },
    { label: prefs.pinned.includes(id) ? "Unpin" : "Pin", onPress: () => chatPrefs.setPinned(id, !prefs.pinned.includes(id)) },
    { label: prefs.muted.includes(id) ? "Unmute" : "Mute", onPress: () => chatPrefs.setMuted(id, !prefs.muted.includes(id)) },
  ];
  const done = async (r: { error?: { message: string } }, ok: string) => { if (r.error) showToast(r.error.message || "That did not go through."); else { showToast(ok); void refresh(); } };
  const view = chatsView({ from: chats.from, gap, rows, live: status === "live" });
  return (
    <Page top title="Chat" actions={<Button kind="primary" size="sm" icon="plus" label="New chat" onPress={() => go("/u/chats/new")} />}>
      <PlaceTag of="showing" />
      <Sheet open={!!moving} onClose={() => setMoving(null)} title="Move to a project">
        <ProjectPicker projects={projects} current={projects.find((x) => x.name === chats.rows.find((c) => c.id === moving)?.project) ?? null} onBack={() => setMoving(null)}
          onPick={async (slug) => { const id = moving as string; setMoving(null); if (!slug) return; const why = await moveChat(id, slug); await done(why ? { error: { message: why } } : {}, "Moved to the project."); }} />
      </Sheet>
      <Sheet open={!!renaming} onClose={() => setRenaming(null)} title="Rename chat">
        {renaming ? (
          <View className="gap-s3">
            <Field name="Chat name" value={renaming.title} onChangeText={(t) => setRenaming({ ...renaming, title: t })} />
            <View className="self-start"><Button kind="primary" size="sm" label="Save" onPress={async () => { const r0 = renaming; setRenaming(null); if (r0.title.trim()) await done(await callT("work.chat.rename", { chat: r0.id, title: r0.title.trim() }), "Renamed."); }} /></View>
          </View>
        ) : null}
      </Sheet>
      {view.banner && gap ? (
        <Banner icon="info">
          <View className="gap-s2">
            <Text strong>{gap.title}</Text>
            <Text size="caption" tone="muted">{gap.line}</Text>
            <View className="self-start"><Button size="sm" label={gap.action} onPress={() => go(gap.route)} /></View>
          </View>
        </Banner>
      ) : null}
      {view.body === "unsupported" ? <Card><EmptyState title={UNSUPPORTED} body="This app and your server ship together. Update the server, then come back." /></Card>
        : view.body === "gap" && gap ? <Card><EmptyState title={gap.title} body={gap.line} action={{ label: gap.action, onPress: () => go(gap.route) }} /></Card>
        : view.body === "loading" ? <LoadingState rows={4} />
        : view.body === "offline" ? <Card><EmptyState title="Your Vyre has not answered yet" body="Check that it is on and online. Nothing was lost." action={{ label: "Try again", onPress: () => refresh() }} /></Card>
        : view.body === "empty" ? <Card><EmptyState title="No chats yet" body="Start one with your assistant or an agent." action={{ label: "New chat", onPress: () => go("/u/chats/new") }} /></Card>
        : (
          <ChatsList menu={menu} tag={chatsTag} rows={rows} now={now} places={places} onOpen={(id) => router.push({ pathname: "/u/chats/[id]", params: { id } })} />
        )}
    </Page>
  );
}
