import { useEffect, useMemo, useState } from "react";
import { convosFrom, useStore } from "@vyre/ui";
import type { Convo } from "@vyre/ui";
import { agentsList } from "../settings/real";
import { agentRow, visibleAgents } from "../agents/home-model.js";
import { teammates } from "../teammates/teammates";
import type { ChatRow } from "./chats-model.js";

type AgentItem = { name: string; role: string; projects: string[]; status: string };
type Person = { id: string; name: string; role?: string };

/** The Chat screen's one list: the chats you can see, plus the agents and teammates you can start one with. If the box does not answer for agents or teammates, the chats still show. */
export function useConvos(chats: readonly ChatRow[]): Convo[] {
  const st = useStore();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const me = String((await (st.me?.() as Promise<string> | undefined)?.catch(() => "")) ?? "");
        const list: any[] = await agentsList().catch(() => []);
        const rows = visibleAgents(list.map((x) => agentRow(x, me)), me).filter((r) => r.kind !== "assistant");
        const ids = (name: string): string[] => { const a = list.find((x) => String(x.name) === name); return Array.isArray(a?.projects) ? a.projects.map(String) : []; };
        const slugs = [...new Set(rows.flatMap((r) => ids(r.name)))];
        const names = slugs.length ? await teammates.names(slugs).catch(() => ({} as Record<string, string>)) : {};
        const who: any[] = await Promise.resolve(st.actors()).catch(() => []);
        if (!live) return;
        setAgents(rows.map((r) => ({ name: r.name, role: r.role, status: r.status, projects: ids(r.name).map((s) => names[s] || s) })));
        setPeople(who.filter((w) => w.family === "person" && w.name && String(w.id) !== me).map((w) => ({ id: String(w.id), name: String(w.name), role: w.role ? String(w.role) : undefined })));
      } catch { /* the chats still show */ }
    })();
    return () => { live = false; };
  }, [st]);
  return useMemo(() => convosFrom({ chats, agents, people }), [chats, agents, people]);
}
