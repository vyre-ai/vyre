import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { create } from "zustand";
import { allowsMock, ConversationList, ConversationTypes, IconButton, NewPopover, convosShown, newMenuAgents, showToast } from "@vyre/ui";
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
import { openEngineer } from "../engineer/openEngineer";
import { agentThreads } from "../../src/chat/threads-source";
import { ensureEngineerChat } from "../../src/chat/engineer-chat";
import { Text } from "@vyre/ui";

/** The id of the chat the path shows (/u/chats/<id> or /session/<id>), or "". */
export const openChatOf = (path: string) => /^\/(?:u\/chats|session)\/([^/]+)$/.exec(path)?.[1] ?? "";

/** What the header and the list share: the search, the project and the tag (the header sets them, the list reads them), and what the list found for the filter menu. */
const useChatsFilter = create<{ q: string; type: string; project: string; tag: string; all: Convo[]; tags: string[]; newAgent: boolean; compose: boolean; set: (p: Partial<{ q: string; type: string; project: string; tag: string; all: Convo[]; tags: string[]; newAgent: boolean; compose: boolean }>) => void }>((set) => ({
  q: "", type: "all", project: "all", tag: "", all: [], tags: [], compose: false, newAgent: allowsMock() && typeof location !== "undefined" && /[?&]newagent=1/.test(location.search), set: (p) => set(p),
}));

/** New agent: the Engineer drafts it in a thread (the "From Agents" handoff), and the person says yes to create it. The sample preview (?newagent=1) keeps the form. */
export const openNewAgent = (router: { push: (to: never) => void }) => {
  if (allowsMock() && typeof location !== "undefined" && /[?&]newagent=1/.test(location.search)) { useChatsFilter.getState().set({ newAgent: true }); return; }
  openEngineer(router, { source: "agent", intent: "create" });
};

/** The compose button: opens and closes the New menu (also Cmd N). */
const toggleCompose = () => { const st = useChatsFilter.getState(); st.set({ compose: !st.compose }); };

/** The + that opens the New menu: a press on it toggles the menu, so the menu does not count it as a press outside. */
const plusAnchor: { current: unknown } = { current: null };

/** The section's + : the New menu, a compact popover (To:, agents, people, New group, New agent, New Flow). */
export function ChatsPlusButton() {
  return <View ref={(n) => { plusAnchor.current = n; }}><IconButton icon="plus" label="New" kind="ghost" onPress={toggleCompose} /></View>;
}

/** The top of a phone's Chats page: the name and the compose button. There is no search here: the one search is the main one. */
export function ChatsSidebarHeader() {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 }}>
      <View />
      <ChatsPlusButton />
    </View>
  );
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
  // the Engineer's Space chat is made or mended on the first open by someone who may use it, then shows pinned in Space chats
  useEffect(() => { if (allowsMock()) return; void ensureEngineerChat().then((r) => { if (r.state === "ready") refresh(); }); }, []);
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
  // a chat you pinned sits under Pinned with your assistant
  const marked = convos.map((c) => (c.chat && prefs.pinned.includes(c.chat) && c.section !== "pinned" ? { ...c, section: "pinned" as const } : c));
  const found = [...convosShown(marked, { project: f.project, query: f.q, type: f.type })].sort((a, b) => pinnedFirst(a) - pinnedFirst(b));
  const open = (c: Convo) => {
    if (c.id === "assistant:new") { router.push("/u/chats/new-thread" as never); return; }
    if (c.kind === "flow") { router.push(`/u/chats/flow/${encodeURIComponent(c.chat)}` as never); return; }
    if (c.chat) { router.push({ pathname: "/u/chats/[id]", params: { id: c.chat } }); return; }
    void startChat({ people: c.person ? [c.person] : [], agents: c.agent ? [c.agent] : [] }).then((x) => { if ("chat" in x) { void refresh(); router.push({ pathname: "/u/chats/[id]", params: { id: x.chat } }); } else showToast(x.say); }).catch(() => showToast("That did not go through."));
  };
  // The New menu: To:, agents (each starts a thread), people, New group, New agent, New Flow. Cmd N opens it.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => { if ((e.key === "n" || e.key === "N") && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) { e.preventDefault(); toggleCompose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const byId = new Map(convos.map((c) => [c.id, c]));
  // every agent you can start a thread with, by its display name: your assistant first (its own chat), then the Space's agents
  const agentRows = newMenuAgents(convos);
  const personRows = convos.filter((c) => c.lone === "person").map((c) => ({ id: c.id, name: c.title }));
  const pickNew = (r: { kind: string; id: string; label: string }) => {
    if (r.kind === "group") router.push("/u/chats/new?group=1" as never);
    else if (r.kind === "new-agent") openNewAgent(router);
    else if (r.kind === "flow") router.push("/u/flows" as never);
    else if (r.kind === "person") { const c = byId.get(r.id); if (c) open(c); }
    else if (r.kind === "agent") {
      const c = byId.get(r.id);
      // your assistant has one chat: picking it opens that chat. Any other agent starts a new thread, by its id (the label is its display name).
      if (c && (c.id === "assistant:new" || (c.section === "pinned" && c.chat))) { open(c); return; }
      void agentThreads.start(c?.agent || c?.names[0] || r.label).then((x) => {
        if ("problem" in x) showToast(x.problem);
        else if (allowsMock()) showToast("A new thread opens as its own chat in a real Space.");
        else { void refresh(); router.push({ pathname: "/u/chats/[id]", params: { id: x.thread } }); }
      });
    }
  };
  return (
    // one View, so the closed sheets are not seven children of a parent that spaces its children
    <View>
      {sheets}
      <ConversationTypes type={f.type} onType={(type: string) => f.set({ type })} />
      {/* The New menu opens under the type chips, over the list, so the filters stay in sight. */}
      <View style={{ zIndex: 30 }}><NewPopover open={f.compose} onClose={() => f.set({ compose: false })} agents={agentRows} people={personRows} onPick={pickNew} anchor={plusAnchor} /></View>
      <NewAgentFlow open={f.newAgent} onClose={() => f.set({ newAgent: false })} />
      {/* Quiet, never a skeleton: the last list with a line when the box did not refresh it, a line when nothing came, and nothing at all while the first read is inside its budget. */}
      {chats.note ? <Text size="caption" tone="label" style={{ paddingHorizontal: 16, paddingTop: 4 }}>This is the last list. It did not refresh.</Text> : null}
      {!found.length && chats.from === "failed" ? <Text tone="label" style={{ paddingHorizontal: 16, paddingTop: 8 }} accessibilityRole="button" onPress={chats.retry}>Your chats did not load. Tap to try again.</Text>
        : !found.length && chats.from !== "none" ? <Text tone="label" style={{ paddingHorizontal: 16, paddingTop: 8 }}>{f.q.trim() || f.type !== "all" || f.project !== "all" || f.tag ? "Nothing matches." : "No chats yet. Tap + to start one."}</Text> : null}
      <ConversationList items={found} onOpen={open} whenOf={(c) => (c.last ? ageOf(c.last, now) : "")} menuOf={(c) => (c.chat && c.kind !== "flow" ? menu(c.chat) : [])} currentChat={openChatOf(path)} />
    </View>
  );
}
