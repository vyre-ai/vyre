import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { NewAgentDialog, lookSeed, showToast } from "@vyre/ui";
import type { NewAgentValues } from "@vyre/ui";
import { agent } from "../assistants/agent";
import { NEW_FORM, createInput } from "../assistants/agent-model.ts";
import { startChat } from "../../src/state/start-chat";
import { useMembers } from "../spaces/state";
import { useSpaces } from "../shell/state";
import { useMyModels } from "../../src/models/useMyModels";
import { refresh } from "../../src/state/live";

const START: NewAgentValues = { name: "", shape: 0, color: 0, job: "", projects: [], runsOn: "subscription", budget: "", model: "", effort: "", computer: false, personal: false };

/** New agent, opened from the + menu: a dialog over the Chat list. Create makes the agent and opens a chat with it. The look (shape and colour) goes with it as `look`, which the agents module keeps. */
export function NewAgentFlow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [v, setV] = useState<NewAgentValues>(START);
  const [projects, setProjects] = useState<{ slug: string; name: string }[] | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const { groups } = useMyModels();
  const members = useMembers();
  const showing = useSpaces((s) => s.space);
  const owner = members.spaces.find((x) => x.id === showing)?.role === "owner";
  useEffect(() => { if (open && projects === null) agent.projects().then(setProjects).catch(() => setProjects([])); }, [open, projects]);
  const create = () => {
    const r = createInput({ ...NEW_FORM, name: v.name, instructions: v.job, projects: v.projects, runsOn: v.runsOn, budget: v.budget, hasProjects: (projects ?? []).length > 0, computer: owner && v.computer });
    if ("problem" in r) { setProblem(r.problem); return; }
    setBusy(true); setProblem("");
    agent.create({ ...(r.input as Record<string, unknown> & { name: string }), look: lookSeed(v.shape, v.color), ...(v.model ? { model: v.model, ...(v.provider ? { model_provider: v.provider } : {}) } : {}), ...(v.effort ? { effort: v.effort } : {}), ...(owner && v.personal ? { personal: true } : {}) }).then(async ({ made }) => {
      onClose(); setV(START);
      const c = await startChat({ people: [], agents: [made.name] });
      void refresh();
      if ("chat" in c) router.push({ pathname: "/u/chats/[id]", params: { id: c.chat } }); else showToast(`${made.name} is made. ${c.say}`);
    }).catch((e) => setProblem(e instanceof Error ? e.message : "That did not go through.")).finally(() => setBusy(false));
  };
  return <NewAgentDialog open={open} onClose={onClose} values={v} onChange={(p) => setV((x) => ({ ...x, ...p }))} projects={projects} groups={groups} owner={owner} busy={busy} problem={problem} onCreate={create} />;
}
