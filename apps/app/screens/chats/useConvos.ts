import { useEffect, useMemo, useRef, useState } from "react";
import { convosFrom, rememberLook, useStore } from "@vyre/ui";
import type { Convo } from "@vyre/ui";
import { agentsList } from "../settings/real";
import { agentRow, visibleAgents } from "../agents/home-model.js";
import { callT } from "../../src/real/call-tool";
import { summaryByAgent } from "./summary-model.js";
import { teammates } from "../teammates/teammates";
import type { ChatRow } from "./chats-model.js";
import { viewCache } from "../../src/state/cache";
import { useSpaces } from "../shell/state";
import { AUX_BUDGET_MS, auxKey, packAux, unpackAux } from "./chats-cache.js";

type AgentItem = { name: string; role: string; projects: string[]; status: string; look: string; summary?: { count: number; latest?: string; at?: number; live?: string; needs?: boolean } };
type Person = { id: string; name: string; role?: string };

/** The Chat screen's one list: the chats you can see, plus the agents and teammates you can start one with. If the box does not answer for agents or teammates, the chats still show. */
export function useConvos(chats: readonly ChatRow[]): Convo[] & { ready?: boolean } {
  const st = useStore();
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [assistantName, setAssistantName] = useState("");
  const [assistantAgent, setAssistantAgent] = useState("");
  const space = useSpaces((x) => x.space);
  const key = auxKey(space);
  // `ready` is the key whose agents and teammates are known (kept or fresh), or whose wait ran out: the list draws once, not once per answer
  const [ready, setReady] = useState<string | null>(null);
  const freshFor = useRef("");
  useEffect(() => {
    let live = true;
    const wait = setTimeout(() => { if (live) setReady(key); }, AUX_BUDGET_MS);
    void viewCache.get(key).then((raw) => {
      const a = unpackAux(raw);
      if (!live || !a || freshFor.current === key) return;
      setAgents(a.agents); setPeople(a.people); setAssistantName(a.assistantName); setAssistantAgent(a.assistantAgent); setReady(key);
    }).catch(() => {});
    return () => { live = false; clearTimeout(wait); };
  }, [key]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const me = String((await (st.me?.() as Promise<string> | undefined)?.catch(() => "")) ?? "");
        const list: any[] = await agentsList().catch(() => []);
        for (const x of list) rememberLook(String(x.name), x.look ? String(x.look) : "");
        const mineAsst = visibleAgents(list.map((x) => agentRow(x, me)), me).find((r) => r.kind === "assistant");
        const rows = visibleAgents(list.map((x) => agentRow(x, me)), me).filter((r) => r.kind !== "assistant");
        const ids = (name: string): string[] => { const a = list.find((x) => String(x.name) === name); return Array.isArray(a?.projects) ? a.projects.map(String) : []; };
        const slugs = [...new Set(rows.flatMap((r) => ids(r.name)))];
        const names = slugs.length ? await teammates.names(slugs).catch(() => ({} as Record<string, string>)) : {};
        const who: any[] = await Promise.resolve(st.actors()).catch(() => []);
        // how many threads each agent has, its latest and its live one (acct6's work.chat.summary); a box without it leaves the rows as they were
        const sum = await callT("work.chat.summary", {}).then((r) => (r.error ? null : r.data)).catch(() => null);
        const bySummary = summaryByAgent(sum);
        if (!live) return;
        const nextAsst = mineAsst ? mineAsst.title : "", nextAsstAgent = mineAsst ? mineAsst.name : "";
        const nextAgents = rows.map((r) => ({ name: r.name, title: r.title, role: r.role, status: r.status, look: String(list.find((x) => String(x.name) === r.name)?.look ?? ""), summary: bySummary.get(r.name), projects: ids(r.name).map((s) => names[s] || s) }));
        const nextPeople = who.filter((w) => w.family === "person" && w.name && String(w.id) !== me).map((w) => ({ id: String(w.id), name: String(w.name), role: w.role ? String(w.role) : undefined }));
        freshFor.current = key;
        setAssistantName(nextAsst); setAssistantAgent(nextAsstAgent); setAgents(nextAgents); setPeople(nextPeople); setReady(key);
        void viewCache.set(key, packAux({ agents: nextAgents, people: nextPeople, assistantName: nextAsst, assistantAgent: nextAsstAgent }));
      } catch { /* the chats still show */ }
    })();
    return () => { live = false; };
  }, [st, key]);
  // Chats lists only the chats the person started with people and agents: the Engineer's chats (a new site, a new flow) are reached from where they were made, and Flows from Projects (owner, 22 Oct).
  const mine = useMemo(() => chats.filter((c) => c.engineer !== true && c.pinned !== "engineer" && !c.agents.some((a) => a.toLowerCase() === "engineer")), [chats]);
  const ownAgents = useMemo(() => agents.filter((a) => a.name.toLowerCase() !== "engineer"), [agents]);
  const convos = useMemo(() => convosFrom({ chats: mine, agents: ownAgents, people, flows: [], assistantName, assistantAgent }), [mine, ownAgents, people, assistantName, assistantAgent]);
  return useMemo(() => Object.assign([...convos], { ready: ready === key }), [convos, ready, key]);
}
