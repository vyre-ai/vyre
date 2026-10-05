import { useEffect, useState } from "react";
import { Card, Select, Text, showToast } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { spaceName } from "../../src/state/space-name.js";
import { hostChoices } from "../shell/basic.js";

/** Where a Personal space keeps its reminders, notes and to-dos (encrypted): one of the Cloud spaces the person is in. The box answers the choices and the current one (spaces.tier); the choice is spaces.personal-host.set. */
export function PersonalHost() {
  const [t, setT] = useState<{ cloud?: unknown; personal_host?: string | null } | null>(null);
  const [problem, setProblem] = useState("");
  const load = () => { tool("spaces.tier", {}).then((d) => setT(d as never)).catch(() => setT(null)); };
  useEffect(load, []);
  const { options, current } = hostChoices(t);
  if (options.length < 2) return null;
  const set = async (space: string) => {
    setProblem("");
    try { await tool("spaces.personal-host.set", { space }); showToast("Your personal items are kept there now."); load(); }
    catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That did not save."); }
  };
  return (
    <Card className="gap-s2">
      <Text strong>Where your personal items are kept</Text>
      <Select label="Kept on" value={current ?? ""} options={options} onChange={(v) => void set(v)} />
      {problem ? <Text tone="err">{problem}</Text> : null}
    </Card>
  );
}
