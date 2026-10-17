import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, ConversationList, EmptyState, LoadingState, Text, convosShown, showToast } from "@vyre/ui";
import type { Convo } from "@vyre/ui";
import { useChatMenu } from "./useChatMenu";
import { useChatPrefs } from "../../src/state/chat-prefs";
import { Page } from "../places/Frame";
import { useChats } from "../../src/state/chats";
import { useGap } from "../../src/state/setup-gap";
import { useConnection } from "../../src/state/connection";
import { refresh } from "../../src/state/live";
import { ageOf } from "./chat-model.js";
import { useConvos } from "./useConvos";
import { startChat } from "../../src/state/start-chat";
import FlowChatsList from "./FlowChatsList";
import { UNSUPPORTED, byTag, chatsOrdered, chatsShown, chatsView } from "./chats-model.js";
import { ensurePersistent } from "../../src/state/persistent-chat";
import { PlaceTag } from "../../src/real/PlaceTag";

/** /u/chats: every chat you can see, the ones that need you first. One row type for solo, group and people-only chats; a row for a chat you are not in is greyed and does not open. */
export default function ChatsScreen() {
  const router = useRouter();
  const chats = useChats();
  const gap = useGap();
  const status = useConnection();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
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
  const { menu, sheets } = useChatMenu(chats.rows);
  // The list's own search (title, last line and project) and the project chip.
  const [q, setQ] = useState("");
  // Flow chats are hidden until asked for: one tap shows them, one tap on Chats goes back.
  const [flows, setFlows] = useState(false);
  const [project, setProject] = useState("all");
  const [tag, setTag] = useState("");
  const tagged = byTag(rows, tag);
  const convos = useConvos(tagged.rows);
  const shown = convosShown(convos, { project, query: q });
  // Your own pins go first, after your assistant's chat; the order inside each part is the list's.
  const pinnedFirst = (c: Convo) => (c.pinned ? 0 : c.chat && prefs.pinned.includes(c.chat) ? 1 : 2);
  const found = [...shown].sort((a, b) => pinnedFirst(a) - pinnedFirst(b));
  // A row opens its chat. An agent or a teammate with no chat yet starts one first.
  const open = (c: Convo) => {
    if (c.chat) { router.push({ pathname: "/u/chats/[id]", params: { id: c.chat } }); return; }
    void startChat({ people: c.person ? [c.person] : [], agents: c.agent ? [c.agent] : [] }).then((x) => { if ("chat" in x) { void refresh(); router.push({ pathname: "/u/chats/[id]", params: { id: x.chat } }); } else showToast(x.say); }).catch(() => showToast("That did not go through."));
  };
  const add = [
    { label: "New chat", onPress: () => go("/u/chats/new") },
    { label: "New group chat", onPress: () => go("/u/chats/new?group=1") },
    { label: "New agent", onPress: () => go("/u/settings/assistants/new") },
    { label: "New email", onPress: () => go("/u/mail/compose") },
  ];
  const view = chatsView({ from: chats.from, gap, rows, live: status === "live" });
  return (
    <Page top title="Chat">
      <PlaceTag of="showing" />
      {sheets}
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
        : view.body === "empty" ? <Card><EmptyState title="No chats yet" body="Start one with an agent." action={{ label: "New chat", onPress: () => go("/u/chats/new") }} /></Card>
        : (
          <View className="gap-s3">
            <View className="flex-row gap-s2"><Button size="sm" kind={flows ? "ghost" : "secondary"} label="Chats" onPress={() => setFlows(false)} /><Button size="sm" kind={flows ? "secondary" : "ghost"} label="Flows" onPress={() => setFlows(true)} /></View>
            {flows ? null : tagged.tags.length ? <View accessibilityLabel="Filter by tag" className="flex-row flex-wrap gap-s1">{tagged.tags.slice(0, 12).map((t) => <Chip key={t.tag} selected={tag === t.tag} onPress={() => setTag(tag === t.tag ? "" : t.tag)}>{`#${t.tag}`}</Chip>)}</View> : null}
            {flows ? <FlowChatsList now={now} /> : null}
            {flows ? null : <ConversationList items={found} query={q} onQuery={setQ} project={project} onProject={setProject} onOpen={open} add={add} whenOf={(c) => (c.last ? ageOf(c.last, now) : "")} menuOf={(c) => menu(c.chat)} />}
            {flows ? null : q.trim() && !found.length ? <Card><EmptyState title="Nothing matches" body="Try a name, a project or a word from the last message." /></Card> : null}
          </View>
        )}
    </Page>
  );
}
