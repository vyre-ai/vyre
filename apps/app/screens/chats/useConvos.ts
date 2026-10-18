import { useEffect, useMemo, useState } from "react";
import { convosFrom, rememberLook, useStore } from "@vyre/ui";
import type { Convo } from "@vyre/ui";
import { agentsList } from "../settings/real";
import { agentRow, visibleAgents } from "../agents/home-model.js";
import { callT } from "../../src/real/call-tool";
import { summaryByAgent } from "./summary-model.js";
import { teammates } from "../teammates/teammates";
import type { ChatRow } from "./chats-model.js";
import { useFlowChats } from "./FlowChatsList";
import { flowChatSub } from "./flow-chat-model.ts";

type AgentItem = { name: string; role: string; projects: string[]; status: string; look: string; summary?: { count: number; latest?: string; at?: number; live?: string; needs?: boolean } };
type Person = { id: string; name: string; role?: string };

/** The Chat screen's one list: the chats you can see, plus the agents and teammates you can start one with. If the box does not answer for agents or teammates, the chats still show. */
export function useConvos(chats: readonly ChatRow[]): Convo[] {
  const st = useStore();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const { chats: flowChats } = useFlowChats();
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const me = String((await (st.me?.() as Promise<string> | undefined)?.catch(() => "")) ?? "");
        const list: any[] = await agentsList().catch(() => []);
        for (const x of list) rememberLook(String(x.name), x.look ? String(x.look) : "");
        const rows = visibleAgents(list.map((x) => agentRow(x, me)), me).filter((r) => r.kind !== "assistant");
        const ids = (name: string): string[] => { const a = list.find((x) => String(x.name) === name); return Array.isArray(a?.projects) ? a.projects.map(String) : []; };
        const slugs = [...new Set(rows.flatMap((r) => ids(r.name)))];
        const names = slugs.length ? await teammates.names(slugs).catch(() => ({} as Record<string, string>)) : {};
        const who: any[] = await Promise.resolve(st.actors()).catch(() => []);
        // how many threads each agent has, its latest and its live one (acct6's work.chat.summary); a box without it leaves the rows as they were
        const sum = await callT("work.chat.summary", {}).then((r) => (r.error ? null : r.data)).catch(() => null);
        const bySummary = summaryByAgent(sum);
        if (!live) return;
        setAgents(rows.map((r) => ({ name: r.name, role: r.role, status: r.status, look: String(list.find((x) => String(x.name) === r.name)?.look ?? ""), summary: bySummary.get(r.name), projects: ids(r.name).map((s) => names[s] || s) })));
        setPeople(who.filter((w) => w.family === "person" && w.name && String(w.id) !== me).map((w) => ({ id: String(w.id), name: String(w.name), role: w.role ? String(w.role) : undefined })));
      } catch { /* the chats still show */ }
    })();
    return () => { live = false; };
  }, [st]);
  const flows = useMemo(() => (flowChats ?? []).map((c) => ({ id: c.id, title: c.title, line: flowChatSub(c, Date.now()), last: c.last, runs: c.runs, needs: c.needsYou })), [flowChats]);
  return useMemo(() => convosFrom({ chats, agents, people, flows }), [chats, agents, people, flows]);
}
