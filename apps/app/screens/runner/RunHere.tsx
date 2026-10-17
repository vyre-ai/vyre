// Settings, Computer: this computer's name, one choice (Always allow, Ask or Never) for running a space's sessions here, and one plain status line. No limits to manage: the box keeps its defaults.
// The choice is offered only where a space allows members to run sessions on their own computers; Never is the existing switch, Always allow and Ask are `runner.mode`.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Field, Segmented, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { runner } from "./runner";
import { system } from "../settings/system";
import { nameOf } from "../settings/system-model.ts";
import { memberLine } from "../spaces/computers-model.js";
import { CHOICES, choiceOf, statusLine, type MacSettings } from "./runner-model.js";

type Choice = "always" | "ask" | "never";

export function RunHere() {
  const [s, setS] = useState<MacSettings | null>(null);
  const [mode, setMode] = useState<"always" | "ask">("always");
  const [running, setRunning] = useState(0);
  const [shared, setShared] = useState<string[]>([]);
  const [rules, setRules] = useState<{ title: string; allowed: boolean }[]>([]);
  const [name, setName] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    runner.settings().then((x: MacSettings | null) => setS(x)).catch(() => setS(null));
    runner.mode().then(setMode).catch(() => {});
    runner.here().then((h: unknown[]) => setRunning(h.length)).catch(() => setRunning(0));
    runner.sharedWith().then(setShared).catch(() => setShared([]));
    runner.spaceRules().then(setRules).catch(() => setRules([]));
    system.info().then((i: unknown) => setName(nameOf(i))).catch(() => setName(null));
  }, []);
  useEffect(load, [load]);
  if (!s) return null;
  // Never is the switch off (sessions here go back to the server, and the lending ends; it never asks). Always allow and Ask turn the switch on first, which is the one yes the box asks for once.
  const choose = (c: Choice) => {
    if (busy) return;
    setBusy(true); setProblem("");
    const done = c === "never"
      ? runner.turnOff().then((r) => { setS(r.settings); setShared([]); if (r.failed) showToast("Turned off. Sharing could not be ended for every space; try again from Devices."); })
      : (s.enabled ? Promise.resolve() : runner.turnOn().then((r) => { setS(r.settings); setShared(r.lentTo); })).then(() => runner.setMode(c)).then(setMode);
    void done.catch((e) => setProblem(e instanceof Error ? e.message : "That did not go through.")).finally(() => { setBusy(false); load(); });
  };
  const rename = (typed: string) => system.rename(typed).then(() => { showToast("Renamed."); load(); }).catch((e: unknown) => showToast(e instanceof Error && e.message ? e.message : "That did not go through."));
  return <RunHereView name={name} onRename={rename} choice={choiceOf(s, mode)} onChoose={choose} running={running} shared={shared} rules={rules} busy={busy} problem={problem} />;
}

/** The section, from what it is given: the container above reads the box, the gallery gives it a sample. */
export function RunHereView({ name, onRename, choice, onChoose, running = 0, shared = [], rules = [], busy = false, problem = "" }: { name: string | null; onRename?: (name: string) => void; choice: Choice; onChoose?: (c: Choice) => void; running?: number; shared?: string[];
  rules?: { title: string; allowed: boolean }[]; busy?: boolean; problem?: string }) {
  const [typed, setTyped] = useState(name || "");
  useEffect(() => { setTyped(name || ""); }, [name]);
  // Where no space allows it, and this computer is not already running sessions, there is nothing to choose: say so.
  const offered = choice !== "never" || rules.length === 0 || rules.some((r) => r.allowed);
  return (
    <Sec title="Computer">
      {name !== null ? (
        <Card className="gap-s2">
          <Field label="Name" value={typed} onChangeText={setTyped} help="Leave it empty for the default name." />
          <View className="flex-row"><Button size="sm" label="Save name" disabled={typed.trim() === name} onPress={() => onRename?.(typed)} /></View>
        </Card>
      ) : null}
      <Card className="gap-s3">
        <Text strong>Run on this computer</Text>
        {offered ? <Segmented label="Run on this computer" value={choice} options={CHOICES} onChange={(c) => { if (!busy) onChoose?.(c); }} /> : null}
        <Text size="secondary" tone="label">{offered ? statusLine(choice, { running, spaces: shared }) : "None of your spaces lets members run sessions on their own computers. Ask an owner to allow it."}</Text>
        {rules.map((r) => <Text key={r.title} size="secondary" tone="label">{memberLine(r.title, r.allowed)}</Text>)}
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      </Card>
    </Sec>
  );
}
