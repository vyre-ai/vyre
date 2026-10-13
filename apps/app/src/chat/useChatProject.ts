// The project a chat is in, and moving it: projects.list says which projects hold the thread (their picks), projects.add-threads files it into one, projects.remove-threads takes it out of the others.
// A thread can be in several projects at the box; here a move leaves it in exactly one (moveProject). The sample world keeps the choice in memory.
import { useCallback, useEffect, useState } from "react";
import { allowsMock } from "@vyre/ui";
import { callT } from "../real/call-tool";
import { moveProject } from "@vyre/ui/lib/picker-model.js";

export type ProjectRef = { slug: string; name: string };
const SAMPLE: ProjectRef[] = [{ slug: "northwind", name: "Northwind Bakery" }, { slug: "juniper", name: "Juniper Studio intake" }, { slug: "okafor", name: "Okafor estate" }];

export function useChatProject(thread: string | undefined, startIn?: string | null) {
  const mock = allowsMock();
  const [projects, setProjects] = useState<ProjectRef[]>(mock ? SAMPLE : []);
  const [holding, setHolding] = useState<string[]>(mock && startIn ? SAMPLE.filter((s) => s.name === startIn).map((s) => s.slug) : []);
  const [problem, setProblem] = useState("");
  const load = useCallback(async () => {
    if (mock || !thread) return;
    const r = await callT<{ projects?: { slug?: string; name?: string; picks?: string[]; threads?: string[] }[] }>("projects.list", {});
    const rows = r.data?.projects ?? [];
    setProjects(rows.filter((x) => x.slug).map((x) => ({ slug: String(x.slug), name: String(x.name || x.slug) })));
    setHolding(rows.filter((x) => x.slug && (x.picks ?? x.threads ?? []).includes(thread)).map((x) => String(x.slug)));
  }, [mock, thread]);
  useEffect(() => { void load(); }, [load]);
  /** Move the chat to a project, or out of its projects with null. Answers an error in words, or null. */
  const move = useCallback(async (to: string | null): Promise<string | null> => {
    setProblem("");
    const plan = moveProject(holding, to);
    if (!mock) {
      if (!thread) return "Start the chat with a message first.";
      if (plan.add) { const r = await callT("projects.add-threads", { project: plan.add, threads: [thread] }); if (r.error) { setProblem(r.error.message || "That did not go through."); return r.error.message || "That did not go through."; } }
      for (const slug of plan.remove) { const r = await callT("projects.remove-threads", { project: slug, threads: [thread] }); if (r.error) { setProblem(r.error.message || "That did not go through."); return r.error.message || "That did not go through."; } }
    }
    setHolding(to ? [to] : []);
    return null;
  }, [holding, mock, thread]);
  const current = projects.find((x) => holding.includes(x.slug)) ?? null;
  return { projects, current, move, problem, reload: load };
}
