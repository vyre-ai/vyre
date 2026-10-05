import { useEffect, useState } from "react";
import { Card, Select, Text, showToast } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { spaceName } from "../../src/state/space-name.js";
import { capChoices, hostChoices, storageLine } from "../shell/basic.js";
import { useMembers } from "../spaces/state";
import { KeepRunning } from "./KeepRunning";

/** Where a Personal space keeps its reminders, notes and to-dos (encrypted): one of the Cloud spaces the person is in. The box answers the choices and the current one (spaces.tier); the choice is spaces.personal-host.set. */
export function PersonalHost() {
  const [t, setT] = useState<{ cloud?: unknown; personal_host?: string | null } | null>(null);
  const [problem, setProblem] = useState("");
  const [usage, setUsage] = useState<unknown>(null);
  const load = () => { tool("spaces.tier", {}).then((d) => setT(d as never)).catch(() => setT(null)); };
  useEffect(load, []);
  const { options, current } = hostChoices(t);
  // Only an owner of the hosting space sets what each member may keep there.
  const owner = useMembers((m) => m.spaces.find((x) => x.id === current)?.role === "owner");
  useEffect(() => { if (current) tool("spaces.storage.usage", { space: current }).then(setUsage).catch(() => setUsage(null)); }, [current]);
  const line = current ? storageLine(usage, options.find(([id]) => id === current)?.[1] ?? "your team") : null;
  if (!options.length) return null;
  if (options.length < 2) return line || current ? <Card className="gap-s2">{line ? <Text tone="muted">{line}</Text> : null}{current ? <KeepRunning space={current} name={options[0]?.[1] ?? "Your team"} /> : null}</Card> : null;
  const set = async (space: string) => {
    setProblem("");
    try { await tool("spaces.personal-host.set", { space }); showToast("Your personal items are kept there now."); load(); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That did not save."); }
  };
  return (
    <Card className="gap-s2">
      <Text strong>Where your personal items are kept</Text>
      <Select label="Kept on" value={current ?? ""} options={options} onChange={(v) => void set(v)} />
      {line ? <Text tone="muted">{line}</Text> : null}
      {owner && current ? <CapSetter space={current} usage={usage} /> : null}
      {current ? <KeepRunning space={current} name={options.find(([id]) => id === current)?.[1] ?? "Your team"} /> : null}
      {problem ? <Text tone="err">{problem}</Text> : null}
    </Card>
  );
}

/** For an owner: the most each member may keep on the space (spaces.storage.set-cap { space, person: "*", bytes }; 0 is no cap). */
function CapSetter({ space, usage }: { space: string; usage: unknown }) {
  const [problem, setProblem] = useState("");
  const [cap, setCap] = useState<number | null>(null);
  const now = cap ?? ((usage as { cap?: number } | null)?.cap ?? 0);
  const set = async (v: string) => {
    setProblem("");
    try { await tool("spaces.storage.set-cap", { space, person: "*", bytes: Number(v) }); setCap(Number(v)); showToast("The cap is saved."); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That did not save."); }
  };
  return (
    <>
      <Select label="Most each member may keep here" value={String(now)} options={capChoices(now)} onChange={(v) => void set(v)} />
      {problem ? <Text tone="err">{problem}</Text> : null}
    </>
  );
}
