import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "expo-router";
import { ConversationList, convosShown, showToast } from "@vyre/ui";
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

/** The id of the chat the path shows (/u/chats/<id> or /session/<id>), or "". */
export const openChatOf = (path: string) => /^\/(?:u\/chats|session)\/([^/]+)$/.exec(path)?.[1] ?? "";

/**
 * THE list of chats: the sidebar draws it inside the Chat place, and a phone's Chat page is this alone. Chats, group chats, agents and teammates in one list with a search, one filter control
 * (projects, tags, Flows) and the + menu. A row opens its chat; an agent or teammate with no chat yet starts one first.
 */
export function ChatsSidebar() {
  const router = useRouter();
  const path = usePathname();
  const chats = useChats();
  const prefs = useChatPrefs();
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
  const { menu, sheets } = useChatMenu(chats.rows);
  const [q, setQ] = useState("");
  const [project, setProject] = useState("all");
  const [tag, setTag] = useState("");
  const [newAgent, setNewAgent] = useState(false);
  const ordered = chatsOrdered(chatsShown(chats.rows));
  const tagged = byTag(ordered, tag);
  const convos = useConvos(tagged.rows);
  // Your own pins go first, after your assistant's chat; the order inside each part is the list's.
  const pinnedFirst = (c: Convo) => (c.pinned ? 0 : c.chat && prefs.pinned.includes(c.chat) ? 1 : 2);
  const found = [...convosShown(convos, { project, query: q })].sort((a, b) => pinnedFirst(a) - pinnedFirst(b));
  const open = (c: Convo) => {
    if (c.chat) { router.push({ pathname: "/u/chats/[id]", params: { id: c.chat } }); return; }
    void startChat({ people: c.person ? [c.person] : [], agents: c.agent ? [c.agent] : [] }).then((x) => { if ("chat" in x) { void refresh(); router.push({ pathname: "/u/chats/[id]", params: { id: x.chat } }); } else showToast(x.say); }).catch(() => showToast("That did not go through."));
  };
  const add = [
    { label: "New chat", onPress: () => go("/u/chats/new") },
    { label: "New group chat", onPress: () => go("/u/chats/new?group=1") },
    { label: "New agent", onPress: () => setNewAgent(true) },
    { label: "New email", onPress: () => go("/u/mail/compose") },
  ];
  return (
    <>
      {sheets}
      <NewAgentFlow open={newAgent} onClose={() => setNewAgent(false)} />
      <ConversationList items={found} all={convos} query={q} onQuery={setQ} project={project} onProject={setProject} tags={tagged.tags.slice(0, 12).map((t) => t.tag)} tag={tag} onTag={setTag}
        extraFilters={[{ label: "Flows", onPress: () => go("/u/flows") }]} onOpen={open} add={add} whenOf={(c) => (c.last ? ageOf(c.last, now) : "")} menuOf={(c) => (c.chat ? menu(c.chat) : [])} currentChat={openChatOf(path)} />
    </>
  );
}
