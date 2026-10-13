import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Chip } from "./components/Chip";
import { Field } from "./components/Field";
import { Icon } from "./components/Icon";
import { Text } from "./components/Text";
import { useUiTheme } from "./theme";
import { dayText, keyDay, monthCells, parseDay, parseTime, quickDays, shiftMonth, stepTime, timeWords, zoneName } from "./datetime.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const words = (v: string) => { const d = parseDay(v); return d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : ""; };

/**
 * The one date (and time) picker. The value is a day, 2026-10-28, or with `withTime` a day and time, 2026-10-28T14:15, or "". Quick chips (Today, Tomorrow, Next week), a month grid with month buttons and
 * arrow keys, a typed time that steps by 15 minutes (the up and down arrows or the buttons) and the zone it is read in. It works the same on a phone and on the web.
 */
export function DateTimePicker({ label, value, onChange, now, withTime = false, zone, closeOnPick = true }: {
  label: string; value: string; onChange: (v: string) => void; now: number; withTime?: boolean; /** The Space's time zone name; the device's when not given. */ zone?: string; closeOnPick?: boolean;
}) {
  const { color } = useUiTheme();
  const [dayPart, timePart] = value.split("T");
  const picked = parseDay(dayPart);
  const time = parseTime(timePart ?? "") ?? "";
  const start = picked ? new Date(`${picked}T12:00:00`) : new Date(now);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState({ y: start.getFullYear(), m: start.getMonth() });
  const [typed, setTyped] = useState<string | null>(null);
  const today = dayText(new Date(now));
  const cells = useMemo(() => monthCells(shown.y, shown.m), [shown.y, shown.m]);
  const join = (d: string, t: string) => (withTime ? `${d}T${t || "09:00"}` : d);
  const choose = (d: string) => { onChange(join(d, time)); const x = new Date(`${d}T12:00:00`); setShown({ y: x.getFullYear(), m: x.getMonth() }); if (closeOnPick && !withTime) setOpen(false); };
  const setTime = (t: string) => { setTyped(null); onChange(join(picked ?? today, t)); };
  return (
    <View className="min-w-0 gap-s2">
      <Text size="caption" strong tone="label">{label}</Text>
      <View className="flex-row flex-wrap items-center gap-s2">
        {quickDays(now).map((q) => <Chip key={q.label} selected={picked === q.value} onPress={() => choose(q.value)}>{q.label}</Chip>)}
        <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${picked ? words(picked) : "choose a date"}`} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: open ? color.primary : color.edge, backgroundColor: color["surface-3"] }}>
          <Icon name="cal" size={16} tone="muted" />
          <Text>{picked ? `${words(picked)}${withTime && time ? `, ${timeWords(time)}` : ""}` : "Pick a date"}</Text>
        </Pressable>
      </View>
      {open ? (
        <View style={{ borderWidth: 1, borderColor: color.edge, borderRadius: 12, padding: 10, gap: 6, backgroundColor: color["surface-3"], alignSelf: "flex-start", width: 7 * 40 + 24, maxWidth: "100%" }}
          onKeyPress={(e: any) => { const n = keyDay(picked ?? today, String(e?.nativeEvent?.key)); if (n) { e.preventDefault?.(); choose(n); } }}>
          <View className="flex-row items-center justify-between">
            <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => setShown(shiftMonth(shown, -1))} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}><Icon name="chevron-left" size={16} tone="muted" /></Pressable>
            <Text strong>{MONTHS[shown.m]} {shown.y}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => setShown(shiftMonth(shown, 1))} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}><Icon name="chevron" size={16} tone="muted" /></Pressable>
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
      {withTime ? (
        <View className="flex-row items-end gap-s2">
          <View className="w-28"><Field label="Time" name={`${label} time`} value={typed ?? timeWords(time)} placeholder="2:15 pm" onChangeText={setTyped}
            onSubmit={() => { const t = parseTime(typed ?? ""); if (t) setTime(t); else setTyped(null); }}
            onKey={(k, e) => { if (k === "ArrowUp" || k === "ArrowDown") { e?.preventDefault?.(); setTime(stepTime(time, k === "ArrowUp" ? 1 : -1)); } else if (k === "Enter") { const t = parseTime(typed ?? ""); if (t) setTime(t); } }} /></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Later by 15 minutes" onPress={() => setTime(stepTime(time, 1))} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}><Icon name="chevron-up" size={16} tone="muted" /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Earlier by 15 minutes" onPress={() => setTime(stepTime(time, -1))} style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}><Icon name="chevron-down" size={16} tone="muted" /></Pressable>
          <Text size="caption" tone="label" className="flex-1 pb-s2">{`Time zone: ${zoneName(zone)}`}</Text>
        </View>
      ) : null}
    </View>
  );
}
