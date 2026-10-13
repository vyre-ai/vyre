import { useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, EmptyState, LoadingState, Text, useUiTheme } from "@vyre/ui";
import { useChatMenu } from "./useChatMenu";
import { useChatPrefs } from "../../src/state/chat-prefs";
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
  const { color } = useUiTheme();
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
  const { menu, sheets } = useChatMenu(chats.rows);
  // The list's own search ("/" focuses it): the title, the last line, who is in it and its project.
  const [q, setQ] = useState("");
  const search = useRef<TextInput>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const on = (e: KeyboardEvent) => { const el = document.activeElement as HTMLElement | null; if (e.key === "/" && !(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); search.current?.focus(); } };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);
  const word = q.trim().toLowerCase();
  const found = word ? rows.filter((c) => [c.title, c.line, c.project, ...c.people, ...c.agents].join(" ").toLowerCase().includes(word)) : rows;
  const view = chatsView({ from: chats.from, gap, rows, live: status === "live" });
  return (
    <Page top title="Chat" actions={<Button kind="primary" size="sm" icon="plus" label="New chat" onPress={() => go("/u/chats/new")} />}>
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
            <TextInput ref={search} value={q} onChangeText={setQ} placeholder="Search chats  /" placeholderTextColor={color.label} accessibilityLabel="Search chats"
              onKeyPress={(e: any) => { if (e.nativeEvent.key === "Escape" && q) { e.preventDefault?.(); setQ(""); } }}
              style={{ minHeight: 36, borderWidth: 1, borderColor: color.edge, borderRadius: 8, paddingHorizontal: 12, color: color.text, fontSize: 15, outlineStyle: "none" } as any} />
            {word && !found.length ? <Card><EmptyState title="No chat matches" body="Try a name, a project or a word from the last message." /></Card> : null}
            <ChatsList menu={menu} tag={chatsTag} rows={found} now={now} places={places} onOpen={(id) => router.push({ pathname: "/u/chats/[id]", params: { id } })} />
          </View>
        )}
    </Page>
  );
}
