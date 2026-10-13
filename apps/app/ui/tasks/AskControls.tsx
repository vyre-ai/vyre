import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Icon } from "../components/Icon";
import { Menu } from "../components/Menu";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
import { pickFiles, type Picked } from "../../src/chat/attach-pick";
import { useVyreFiles } from "../../src/chat/useVyreFiles";
import { dayText, laterChoices, parseDay, quickDays } from "./ask-model.js";

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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** "Wed 28 Oct 2026" for 2026-10-28. */
const words = (v: string) => { const d = parseDay(v); return d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : ""; };

/** A real date picker: Today, Tomorrow and In a week, then a month grid. The value is 2026-10-28 or "". It works the same on a phone and on the web. */
export function DatePick({ label, value, onChange, now }: { label: string; value: string; onChange: (v: string) => void; now: number }) {
  const { color } = useUiTheme();
  const picked = parseDay(value);
  const start = picked ? new Date(`${picked}T12:00:00`) : new Date(now);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState({ y: start.getFullYear(), m: start.getMonth() });
  const today = dayText(new Date(now));
  const cells = useMemo(() => {
    const first = new Date(shown.y, shown.m, 1);
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(shown.y, shown.m + 1, 0).getDate();
    return [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => dayText(new Date(shown.y, shown.m, i + 1)))] as (string | null)[];
  }, [shown.y, shown.m]);
  const step = (n: number) => setShown((s) => { const d = new Date(s.y, s.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const choose = (v: string) => { onChange(v); setOpen(false); };
  return (
    <View className="min-w-0 gap-s2">
      <Text size="caption" strong tone="label">{label}</Text>
      <View className="flex-row flex-wrap items-center gap-s2">
        {quickDays(now).map((q) => <Chip key={q.label} selected={picked === q.value} onPress={() => choose(q.value)}>{q.label}</Chip>)}
        <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${picked ? words(picked) : "choose a date"}`} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: open ? color.primary : color.edge, backgroundColor: color["surface-3"] }}>
          <Icon name="cal" size={16} tone="muted" />
          <Text>{picked ? words(picked) : "Pick a date"}</Text>
        </Pressable>
      </View>
      {open ? (
        <View style={{ borderWidth: 1, borderColor: color.edge, borderRadius: 12, padding: 10, gap: 6, backgroundColor: color["surface-3"], alignSelf: "flex-start", width: 7 * 40 + 20, maxWidth: "100%" }}>
          <View className="flex-row items-center justify-between">
            <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => step(-1)} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}><Icon name="chev-l" size={16} tone="muted" /></Pressable>
            <Text strong>{MONTHS[shown.m]} {shown.y}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => step(1)} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}><Icon name="chev-r" size={16} tone="muted" /></Pressable>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {DOW.map((d) => <View key={d} style={{ width: 40, alignItems: "center", paddingVertical: 2 }}><Text size="caption" tone="label">{d}</Text></View>)}
            {cells.map((c, i) => c === null ? <View key={`b${i}`} style={{ width: 40, height: 36 }} /> : (
              <Pressable key={c} accessibilityRole="button" accessibilityLabel={words(c)} accessibilityState={{ selected: c === picked }} onPress={() => choose(c)}
                style={{ width: 40, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: c === picked ? color.primary : "transparent", borderWidth: c === today && c !== picked ? 1 : 0, borderColor: color["edge-strong"] }}>
                <Text tone={c === picked ? "inverse" : "default"}>{Number(c.slice(8))}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** "Later": put the card away until a time the person picks. One menu, four times (an hour, this evening, tomorrow morning, next Monday). */
export function LaterMenu({ now, onLater }: { now: number; onLater: (until: number, label: string) => void }) {
  return (
    <Menu align="start" trigger={<Button size="sm" kind="ghost" icon="clock" label="Later" />}
      items={laterChoices(now).map((c) => ({ label: c.label, onPress: () => onLater(c.until, c.label) }))} />
  );
}
