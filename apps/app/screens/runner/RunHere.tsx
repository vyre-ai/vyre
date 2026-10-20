// Settings, This computer: this computer's name, ONE switch, "Run my chats on this computer", and one plain status line. No limits to manage: the box keeps its defaults.
// On is the existing runner switch with Always allow (`runner.settings.set` enabled plus `runner.mode`); off is Never. The switch is offered only where a Space allows members to run sessions on their own
// computers; where none does, the page says to ask the Space's admin. In the owner's own desktop app it is on by default, once, where allowed; a choice the person made is never overridden.
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Field, Switch, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { runner } from "./runner";
import { system } from "../settings/system";
import { nameOf } from "../settings/system-model.ts";
import { memberLine } from "../spaces/computers-model.js";
import { useMembers } from "../spaces/state";
import { shellKind } from "../../src/shell/shell";
import { kvGet, kvSet } from "../../src/state/kv";
import { RUN_SWITCH_TITLE, choiceOf, statusLine, turnOnByDefault, type MacSettings } from "./runner-model.js";

type Choice = "always" | "ask" | "never";

/** Set once the person has turned the switch on or off themself (or the default was applied): the default never runs again on this computer. */
const CHOSEN = "vyre.runner.chosen";

export function RunHere() {
  const [s, setS] = useState<MacSettings | null>(null);
  const [mode, setMode] = useState<"always" | "ask">("always");
  const [running, setRunning] = useState(0);
  const [shared, setShared] = useState<string[]>([]);
  const [rules, setRules] = useState<{ title: string; allowed: boolean }[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = useMembers((m) => m.spaces.some((x) => x.role === "owner"));
  const load = useCallback(() => {
    runner.settings().then((x: MacSettings | null) => setS(x)).catch(() => setS(null));
    runner.mode().then(setMode).catch(() => {});
    runner.here().then((h: unknown[]) => setRunning(h.length)).catch(() => setRunning(0));
    runner.sharedWith().then(setShared).catch(() => setShared([]));
    runner.spaceRules().then(setRules).catch(() => setRules([]));
    system.info().then((i: unknown) => setName(nameOf(i))).catch(() => setName(null));
  }, []);
  useEffect(load, [load]);
  // Never is the switch off (sessions here go back to the server, and the lending ends; it never asks). On turns the switch on first, which is the one yes the box asks for once.
  const choose = useCallback((c: Choice, o?: { quiet?: boolean }) => {
    if (busy || !s) return;
    setBusy(true); setProblem("");
    void kvSet(CHOSEN, "1");
    const done = c === "never"
      ? runner.turnOff().then((r) => { setS(r.settings); setShared([]); if (r.failed) showToast("Turned off. Some Spaces still list this computer: try again from Devices."); })
      : (s.enabled ? Promise.resolve() : runner.turnOn().then((r) => { setS(r.settings); setShared(r.lentTo); })).then(() => runner.setMode(c)).then(setMode);
    void done.catch((e) => { if (!o?.quiet) setProblem(e instanceof Error ? e.message : "That did not go through."); }).finally(() => { setBusy(false); load(); });
  }, [busy, s, load]);
  // On by default in the owner's own desktop app (the Mac app lends itself; the Windows app cannot yet), where a Space allows it, once.
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || !s || rules === null) return;
    tried.current = true;
    void kvGet(CHOSEN).then((chosen) => {
      if (turnOnByDefault({ desktop: shellKind() === "mac", owner, allowed: rules.some((r) => r.allowed), enabled: s.enabled, chosen: chosen === "1" })) choose("always", { quiet: true });
    });
  }, [s, rules, owner, choose]);
  if (!s) return null;
  const rename = (typed: string) => system.rename(typed).then(() => { showToast("Renamed."); load(); }).catch((e: unknown) => showToast(e instanceof Error && e.message ? e.message : "That did not go through."));
  return <RunHereView name={name} onRename={rename} choice={choiceOf(s, mode)} onChoose={(c) => choose(c)} running={running} shared={shared} rules={rules ?? []} busy={busy} problem={problem} />;
}

/** The section, from what it is given: the container above reads the box, the gallery gives it a sample. */
export function RunHereView({ name, onRename, choice, onChoose, running = 0, shared = [], rules = [], busy = false, problem = "" }: { name: string | null; onRename?: (name: string) => void; choice: Choice; onChoose?: (c: Choice) => void; running?: number; shared?: string[];
  rules?: { title: string; allowed: boolean }[]; busy?: boolean; problem?: string }) {
  const [typed, setTyped] = useState(name || "");
  useEffect(() => { setTyped(name || ""); }, [name]);
  // Where no space allows it, and this computer is not already running sessions, there is nothing to switch: say who decides.
  const offered = choice !== "never" || rules.length === 0 || rules.some((r) => r.allowed);
  const on = choice !== "never";
  return (
    <Sec title="Computer">
      {name !== null ? (
        <Card className="gap-s2">
          <Field label="Name" value={typed} onChangeText={setTyped} help="Leave it empty for the default name." />
          <View className="flex-row"><Button size="sm" label="Save name" disabled={typed.trim() === name} onPress={() => onRename?.(typed)} /></View>
        </Card>
      ) : null}
      <Card className="gap-s3">
        <View className="flex-row items-center gap-s3">
          <View className="min-w-0 flex-1"><Text strong>{RUN_SWITCH_TITLE}</Text></View>
          {offered ? <Switch label={RUN_SWITCH_TITLE} on={on} disabled={busy} onChange={(next) => { if (!busy) onChoose?.(next ? (choice === "ask" ? "ask" : "always") : "never"); }} /> : null}
        </View>
        <Text size="secondary" tone="label">{offered ? statusLine(choice, { running, spaces: shared }) : "Your Spaces keep chats on their servers. Ask your Space's admin to allow this."}</Text>
        {rules.map((r) => <Text key={r.title} size="secondary" tone="label">{memberLine(r.title, r.allowed)}</Text>)}
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      </Card>
    </Sec>
  );
}
