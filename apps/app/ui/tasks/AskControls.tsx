import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Menu } from "../components/Menu";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { pickFiles, type Picked } from "../../src/chat/attach-pick";
import { useVyreFiles } from "../../src/chat/useVyreFiles";
import { laterChoices } from "./ask-model.js";
import { DateTimePicker } from "../DateTimePicker";

/** A dropped file read once into base64 (the web only; a phone has no drop). */
const readDropped = (f: File): Promise<Picked> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => { const t = String(r.result ?? ""); resolve({ name: f.name || "file", mime: f.type || "application/octet-stream", bytes: f.size, base64: t.slice(t.indexOf(",") + 1) }); };
  r.onerror = () => reject(new Error("The file could not be read."));
  r.readAsDataURL(f);
});

/** What a file ask hands back: the file's bytes (a pick or a drop), or a path already in Vyre Files. */
export type AskFile = Picked & { fromVyre?: boolean };

/**
 * Drop a file, pick one from the computer, or pick one from Vyre Files: the three ways the chat composer adds a file (src/chat), reused for a file ask. It says
 * where the file will land. `onFile` gets the file; the card does the upload and the answer.
 */
export function FilePick({ lands, busy, onFile }: { lands: string; busy?: boolean; onFile: (f: AskFile) => void }) {
  const { color } = useUiTheme();
  const box = useRef<View>(null);
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const take = async (files: Picked[]) => { setProblem(null); if (files[0]) onFile(files[0]); };
  const vyre = useVyreFiles(take, (f) => onFile({ ...f, base64: "", fromVyre: true }));
  // A drop on this card only (not the page): the chat listens on the whole page, a card must not take what is dropped on its neighbour.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = box.current as unknown as HTMLElement | null;
    if (!el || !el.addEventListener) return;
    const stop = (e: Event) => { e.preventDefault(); };
    const enter = (e: Event) => { stop(e); setOver(true); };
    const leave = () => setOver(false);
    const drop = (e: Event) => {
      stop(e); setOver(false);
      const list = Array.from((e as DragEvent).dataTransfer?.files ?? []);
      if (list.length) void readDropped(list[0]).then((f) => take([f]), () => setProblem("The file could not be read."));
    };
    el.addEventListener("dragenter", enter); el.addEventListener("dragover", enter); el.addEventListener("dragleave", leave); el.addEventListener("drop", drop);
    return () => { el.removeEventListener("dragenter", enter); el.removeEventListener("dragover", enter); el.removeEventListener("dragleave", leave); el.removeEventListener("drop", drop); };
  }, []);
  const recent = vyre.files.slice(0, 12);
  return (
    <View ref={box} style={{ borderWidth: 1, borderStyle: "dashed", borderColor: over ? color.primary : color["edge-strong"], borderRadius: 12, padding: 14, gap: 10, backgroundColor: over ? color["surface-2"] : "transparent" }}>
      <View className="flex-row items-center gap-s2">
        <Icon name="upload" size={18} tone="muted" />
        <Text className="flex-1" tone="label">{busy ? "Adding the file" : Platform.OS === "web" ? "Drop a file here, or choose one." : "Choose a file."}</Text>
      </View>
      <View className="flex-row flex-wrap gap-s2">
        <Button size="sm" kind="secondary" icon="upload" label="From your computer" disabled={busy} onPress={() => { void pickFiles(false).then(take, () => setProblem("The file could not be read.")); }} />
        {recent.length ? (
          <Menu align="start" trigger={<Button size="sm" kind="secondary" icon="drive" label="From Vyre Files" disabled={busy} />} items={recent.map((f) => ({ label: f.name, onPress: () => { void vyre.pick(f.id).catch(() => setProblem("That file could not be read.")); } }))} />
        ) : null}
      </View>
      <Text size="caption" tone="label">{lands}</Text>
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
    </View>
  );
}

/** The date picker of a card: the shared DateTimePicker, day only. The value is 2026-10-28 or "". */
export function DatePick({ label, value, onChange, now }: { label: string; value: string; onChange: (v: string) => void; now: number }) {
  return <DateTimePicker label={label} value={value} onChange={onChange} now={now} />;
}

/** "Later": put the card away until a time the person picks. One menu, four times (an hour, this evening, tomorrow morning, next Monday). */
export function LaterMenu({ now, onLater }: { now: number; onLater: (until: number, label: string) => void }) {
  return (
    <Menu align="start" trigger={<Button size="sm" kind="ghost" icon="clock" label="Later" />}
      items={laterChoices(now).map((c) => ({ label: c.label, onPress: () => onLater(c.until, c.label) }))} />
  );
}
