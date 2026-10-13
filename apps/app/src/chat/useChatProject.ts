// The project a chat is in, and moving it: work.chat.list says which project the chat's record is filed under, projects.list names the projects, work.chat.move files the chat under another (its record and
// Drive folders follow). One mechanism for the chat panel and the chat list. The sample world keeps the choice in memory.
import { useCallback, useEffect, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { callT } from "../real/call-tool";

export type ProjectRef = { slug: string; name: string };
const SAMPLE: ProjectRef[] = [{ slug: "northwind", name: "Northwind Bakery" }, { slug: "juniper", name: "Juniper Studio intake" }, { slug: "okafor", name: "Okafor estate" }, { slug: "general", name: "General" }];

/** The projects the person can file a chat under. */
export async function listProjects(): Promise<ProjectRef[]> {
  const r = await callT<{ projects?: { slug?: string; name?: string }[] }>("projects.list", {});
  return (r.data?.projects ?? []).filter((x) => x.slug).map((x) => ({ slug: String(x.slug), name: String(x.name || x.slug) }));
}

/** Move a chat under a project (work.chat.move). Answers an error in words, or null. */
export async function moveChat(chat: string, project: string): Promise<string | null> {
  const r = await callT("work.chat.move", { chat, project });
  return r.error ? r.error.message || "That did not go through." : null;
}

export function useChatProject(chat: string | undefined, startIn?: string | null) {
  const mock = allowsMock();
  const [projects, setProjects] = useState<ProjectRef[]>(mock ? SAMPLE : []);
  const [name, setName] = useState<string | null>(mock ? startIn ?? null : null);
  const [problem, setProblem] = useState("");
  const load = useCallback(async () => {
    if (mock || !chat) return;
    setProjects(await listProjects());
    const l = await callT<{ chats?: { chat?: string; id?: string; project_name?: string }[] } | { chat?: string; id?: string; project_name?: string }[]>("work.chat.list", {});
    const rows = Array.isArray(l.data) ? l.data : (l.data as { chats?: { chat?: string; id?: string; project_name?: string }[] } | undefined)?.chats ?? [];
    setName(rows.find((x) => (x.chat ?? x.id) === chat)?.project_name ?? null);
  }, [mock, chat]);
  useEffect(() => { void load(); }, [load]);
  /** Move the chat to a project (a slug). Answers an error in words, or null. */
  const move = useCallback(async (to: string | null): Promise<string | null> => {
    setProblem("");
    if (!to) return "No project to move to.";
    if (!mock) {
      if (!chat) return "Start the chat with a message first.";
      const why = await moveChat(chat, to);
      if (why) { setProblem(why); return why; }
    }
    setName(projects.find((x) => x.slug === to)?.name ?? null);
    return null;
  }, [mock, chat, projects]);
  const current = projects.find((x) => x.name === name) ?? null;
  return { projects, current, move, problem, reload: load };
}
