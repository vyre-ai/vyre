import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "expo-router";
import { create } from "zustand";
import { ConversationHeader, ConversationList, IconButton, Menu, convoChips, convosShown, showToast } from "@vyre/ui";
import type { Convo } from "@vyre/ui";
import { useChatMenu } from "./useChatMenu";
import { useChatPrefs } from "../../src/state/chat-prefs";
import { useChats } from "../../src/state/chats";
import { refresh } from "../../src/state/live";
import { ageOf } from "./chat-model.js";
import { useConvos } from "./useConvos";
import { startChat } from "../../src/state/start-chat";
import { byTag, chatsOrdered, chatsShown } from "./chats-model.js";
import { ensurePersistent } from "../../src/state/persistent-chat";
import { NewAgentFlow } from "./NewAgentFlow";
import { Text } from "@vyre/ui";

/** The id of the chat the path shows (/u/chats/<id> or /session/<id>), or "". */
export const openChatOf = (path: string) => /^\/(?:u\/chats|session)\/([^/]+)$/.exec(path)?.[1] ?? "";

/** What the header and the list share: the search, the project and the tag (the header sets them, the list reads them), and what the list found for the filter menu. */
const useChatsFilter = create<{ q: string; project: string; tag: string; all: Convo[]; tags: string[]; newAgent: boolean; set: (p: Partial<{ q: string; project: string; tag: string; all: Convo[]; tags: string[]; newAgent: boolean }>) => void }>((set) => ({
  q: "", project: "all", tag: "", all: [], tags: [], newAgent: false, set: (p) => set(p),
}));

const useAdd = () => {
  const router = useRouter();
  const go = (p: string) => router.push(p as never);
  return [
    { label: "New chat", onPress: () => go("/u/chats/new") },
    { label: "New group chat", onPress: () => go("/u/chats/new?group=1") },
    { label: "New agent", onPress: () => useChatsFilter.getState().set({ newAgent: true }) },
    { label: "New email", onPress: () => go("/u/mail/compose") },
  ];
};

/** The section's + (New chat, New group chat, New agent, New email): the sidebar's top bar. */
export function ChatsPlusButton() {
  const add = useAdd();
  return <Menu align="end" trigger={<IconButton icon="plus" label="New" kind="ghost" />} items={add} />;
}

/** The filter control inside the search's right end: All, each project, No project, tags and Flows. */
export function ChatsFilterButton() {
  const router = useRouter();
  const f = useChatsFilter();
  const items = [
    ...convoChips(f.all).map((k) => ({ label: k.label, selected: f.project === k.id, onPress: () => f.set({ project: k.id }) })),
    ...f.tags.map((t) => ({ label: `#${t}`, selected: f.tag === t, onPress: () => f.set({ tag: f.tag === t ? "" : t }) })),
    { label: "Flows", onPress: () => router.push("/u/flows" as never) },
  ];
  const narrowed = f.project !== "all" || Boolean(f.tag);
  return <Menu align="end" trigger={<IconButton icon="filter" label={narrowed ? "Filter, on" : "Filter"} kind={narrowed ? "secondary" : "ghost"} />} items={items} />;
}

/** The search, filter and + as one row: the top of a phone's Chat page (the sidebar spreads the same three pieces over its search and top bar). */
export function ChatsSidebarHeader() {
  const f = useChatsFilter();
  const add = useAdd();
  return (
    <ConversationHeader all={f.all} query={f.q} onQuery={(q) => f.set({ q })} project={f.project} onProject={(project) => f.set({ project })} tags={f.tags} tag={f.tag} onTag={(tag) => f.set({ tag })} add={add} />
  );
}

/** What the sidebar's search reads and writes. */
export function useChatsSearch() {
  const q = useChatsFilter((s) => s.q);
  const set = useChatsFilter((s) => s.set);
  return { q, set };
}

/**
 * THE list of chats, the rows only: the sidebar draws it inside the Chat place under ChatsSidebarHeader, and a phone's Chat page is both. Chats, group chats, agents and teammates in one list. A row opens
 * its chat; an agent or teammate with no chat yet starts one first.
 */
export function ChatsSidebar() {
  const router = useRouter();
  const path = usePathname();
  const chats = useChats();
  const prefs = useChatPrefs();
  const f = useChatsFilter();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  // your assistant has one chat, pinned at the top: it is started the first time you are here
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || chats.from === "none" || chats.from === "unsupported" || chats.rows.some((c) => c.pinned === "assistant")) return;
    asked.current = true;
    void ensurePersistent("assistant").then((r) => { if ("chat" in r) void refresh(); }).catch(() => { asked.current = false; });
  }, [chats.from, chats.rows]);
  const { menu, sheets } = useChatMenu(chats.rows);
  const tagged = useMemo(() => byTag(chatsOrdered(chatsShown(chats.rows)), f.tag), [chats.rows, f.tag]);
  const convos = useConvos(tagged.rows);
  const tagNames = tagged.tags.slice(0, 12).map((t) => t.tag).join(",");
  // the header's filter menu lists what is here
  useEffect(() => { f.set({ all: convos, tags: tagNames ? tagNames.split(",") : [] }); }, [convos, tagNames]);
  // Your own pins go first, after your assistant's chat; the order inside each part is the list's.
  const pinnedFirst = (c: Convo) => (c.pinned ? 0 : c.chat && prefs.pinned.includes(c.chat) ? 1 : 2);
  const found = [...convosShown(convos, { project: f.project, query: f.q })].sort((a, b) => pinnedFirst(a) - pinnedFirst(b));
  const open = (c: Convo) => {
    if (c.chat) { router.push({ pathname: "/u/chats/[id]", params: { id: c.chat } }); return; }
    void startChat({ people: c.person ? [c.person] : [], agents: c.agent ? [c.agent] : [] }).then((x) => { if ("chat" in x) { void refresh(); router.push({ pathname: "/u/chats/[id]", params: { id: x.chat } }); } else showToast(x.say); }).catch(() => showToast("That did not go through."));
  };
  return (
    <>
      {sheets}
      <NewAgentFlow open={f.newAgent} onClose={() => f.set({ newAgent: false })} />
      {!found.length ? <Text tone="label" style={{ paddingHorizontal: 16, paddingTop: 8 }}>{f.q.trim() || f.project !== "all" || f.tag ? "Nothing matches." : "No chats yet. Tap + to start one."}</Text> : null}
      <ConversationList items={found} onOpen={open} whenOf={(c) => (c.last ? ageOf(c.last, now) : "")} menuOf={(c) => (c.chat ? menu(c.chat) : [])} currentChat={openChatOf(path)} />
    </>
  );
}
