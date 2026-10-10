// "Run on this computer" in Settings (R031-95 UX): one switch, plugged in only, a processor and a memory limit, and the sessions running here with Pause all. A box without the runner shows
// nothing. The limits are whole numbers in a range, checked before they are sent; the box refuses what is outside again.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, Field, Row, Switch, Text, showToast, useUiTheme } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { runner } from "./runner";
import { DEFAULT_SETTINGS, hereLine, parseLimit, switchNote, type MacSettings } from "./runner-model.js";

export type Here = { thread: string; title: string; state: "running" | "waiting" | "paused"; cpuPercent: number; memoryMb: number; line?: string; cpu?: string };

export function RunHere() {
  const [s, setS] = useState<MacSettings | null>(null);
  const [here, setHere] = useState<Here[]>([]);
  const [cpu, setCpu] = useState("");
  const [mem, setMem] = useState("");
  const [problem, setProblem] = useState("");
  const [shared, setShared] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    runner.settings().then((x: MacSettings | null) => { setS(x); if (x) { setCpu(String(x.cpuPercent)); setMem(String(x.memoryMb)); } }).catch(() => setS(null));
    runner.here().then((h: Here[]) => setHere(h)).catch(() => setHere([]));
    runner.sharedWith().then(setShared).catch(() => setShared([]));
  }, []);
  useEffect(load, [load]);
  if (!s) return null;
  const save = (next: MacSettings) => runner.setSettings(next).then((x) => { setS(x); setProblem(""); }).catch((e) => setProblem(e instanceof Error ? e.message : "That did not go through."));
  // The switch is the one yes: on lends this computer to its spaces (the box asks the person once) and then lets sessions run here; off stops it, then ends the lending, and never asks.
  const flip = (on: boolean) => {
    if (busy) return;
    setBusy(true); setProblem("");
    const done = on
      ? runner.turnOn().then((r) => { setS(r.settings); setShared(r.lentTo); showToast("Sessions can run on this Mac."); })
      : runner.turnOff().then((r) => { setS(r.settings); setShared([]); showToast(r.failed ? "Turned off. Sharing could not be ended for every space; try again from Devices." : "Turned off. Sessions here go back to the server."); });
    void done.catch((e) => setProblem(e instanceof Error ? e.message : "That did not go through.")).finally(() => { setBusy(false); load(); });
  };
  const saveLimits = () => {
    const c = parseLimit("cpuPercent", cpu), m = parseLimit("memoryMb", mem);
    const bad = c.error ?? m.error;
    if (bad) { setProblem(bad); return; }
    void save({ ...s, cpuPercent: Number(c.value), memoryMb: Number(m.value) }).then(() => showToast("Saved."));
  };
  return <RunHereView s={s} here={here} shared={shared} busy={busy} onSwitch={flip} cpu={cpu} mem={mem} problem={problem} setCpu={setCpu} setMem={setMem} onSave={(n) => void save(n)} onSaveLimits={saveLimits}
    onPause={() => runner.pauseAll().then(() => { showToast("Paused. They stay on this Mac until you resume."); load(); }).catch(() => showToast("That did not go through."))}
    onResume={() => runner.resumeAll().then(() => { showToast("Resumed."); load(); }).catch(() => showToast("That did not go through."))} />;
}

/** The section, from what it is given: the container above reads the box, the gallery gives it a sample. */
export function RunHereView({ s, here, shared = [], busy = false, onSwitch, cpu, mem, problem, setCpu, setMem, onSave, onSaveLimits, onPause, onResume }: { s: MacSettings; here: Here[]; shared?: string[]; busy?: boolean; onSwitch?: (on: boolean) => void; cpu: string; mem: string; problem: string; setCpu: (v: string) => void; setMem: (v: string) => void;
  onSave: (n: MacSettings) => void; onSaveLimits: () => void; onPause: () => void; onResume: () => void }) {
  const phone = useUiTheme().phone;
  return (
    <Sec title="Run on this computer">
      <Card>
        <View className="gap-s3">
          <View className="flex-row items-center gap-s3">
            <View className="min-w-0 flex-1"><Text strong>Let sessions run on this Mac</Text><Text size="secondary" tone="label">{switchNote(s, shared)}</Text></View>
            <Switch on={s.enabled} disabled={busy} onChange={(enabled: boolean) => (onSwitch ? onSwitch(enabled) : onSave({ ...s, enabled }))} label="Let sessions run on this Mac" />
          </View>
          {s.enabled ? (
            <>
              <View className="flex-row items-center gap-s3">
                <View className="min-w-0 flex-1"><Text>Only while plugged in</Text><Text size="secondary" tone="label">On battery, a session moves to the server.</Text></View>
                <Switch on={s.pluggedInOnly} onChange={(pluggedInOnly: boolean) => onSave({ ...s, pluggedInOnly })} label="Only while plugged in" />
              </View>
              <Field label="Processor limit (percent)" value={cpu} onChangeText={setCpu} kind="number" />
              <Field label="Memory limit (megabytes)" value={mem} onChangeText={setMem} kind="number" />
              {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
              <View className="flex-row gap-s2"><Button kind="primary" label="Save limits" onPress={onSaveLimits} /><Button kind="ghost" label="Use the defaults" onPress={() => { setCpu(String(DEFAULT_SETTINGS.cpuPercent)); setMem(String(DEFAULT_SETTINGS.memoryMb)); }} /></View>
            </>
          ) : problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        </View>
      </Card>
      {s.enabled ? (
        <View className="gap-s2 pt-s3">
          <Text strong size="secondary">Running here</Text>
          {here.length ? <Card flush>{here.map((x, i) => { const l = hereLine(x); return <View key={x.thread}>{i ? <Divider /> : null}<Row dense title={l.title} sub={l.sub} /></View>; })}</Card> : <Text size="secondary" tone="label">Nothing is running on this Mac right now.</Text>}
          {here.length ? <View className="flex-row gap-s2 self-start"><Button size={phone ? "md" : "sm"} label="Pause all" onPress={onPause} /><Button kind="ghost" size={phone ? "md" : "sm"} label="Resume all" onPress={onResume} /></View> : null}
        </View>
      ) : null}
    </Sec>
  );
}
