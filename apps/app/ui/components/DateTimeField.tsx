import { useEffect, useState } from "react";
import { View } from "react-native";
import { Field } from "./Field";
import { Text } from "./Text";
import { joinParts, partsOf, partsProblem } from "./datetime.js";
import { viewerZone } from "../../src/time/show.js";

export type DateTimeFieldProps = {
  label?: string;
  /** An ISO instant (or, with `dateOnly`, a day as 2026-10-28), or empty. */
  value: string | null | undefined;
  /** Gets the ISO instant, or null when the field is cleared. Nothing is sent while a part is not a real date or time. */
  onChange: (iso: string | null) => void;
  /** The zone the day and the time are read in. The viewer's own unless the caller names one (a Space's). */
  zone?: string;
  /** A day with no time of day. */
  dateOnly?: boolean;
  disabled?: boolean;
  help?: string;
  error?: string;
  /** The accessible name when there is no visible label. */
  name?: string;
};

/**
 * A day and a time of day, in a zone. Here, off the web, it is two boxes with the same checks as the web build; on the web (DateTimeField.web.tsx) each part is the browser's own date or time input, which brings a
 * calendar and a clock. One component for every date a person picks (Flows, records), so there are not two kinds of date input. The value is an ISO instant; the zone is named, never guessed.
 */
export function DateTimeField({ label, value, onChange, zone, dateOnly, disabled, help, error, name }: DateTimeFieldProps) {
  const z = zone || viewerZone();
  const [parts, setParts] = useState(() => partsOf(value, z));
  // a value that changed from outside (another box, a reset) replaces what is shown, unless it is what the parts already say
  useEffect(() => { if ((value ?? "") !== (joinParts(parts.date, parts.time, z, { dateOnly }) ?? "")) setParts(partsOf(value, z)); }, [value, z]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (next: { date: string; time: string }) => {
    setParts(next);
    if (!next.date.trim() && !next.time.trim()) { onChange(null); return; }
    const iso = joinParts(next.date, next.time, z, { dateOnly });
    if (iso) onChange(iso);
  };
  const problem = error || partsProblem(parts.date, parts.time);
  return (
    <View className="min-w-0 gap-s1">
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      <View className="flex-row gap-s2">
        <View className="min-w-0 flex-1"><Field kind="date" name={`${name ?? label ?? "Date"}, day`} value={parts.date} placeholder="2026-10-28" disabled={disabled} onChangeText={(date) => set({ ...parts, date })} /></View>
        {dateOnly ? null : <View className="w-28"><Field name={`${name ?? label ?? "Date"}, time`} value={parts.time} placeholder="14:30" disabled={disabled} onChangeText={(time) => set({ ...parts, time })} /></View>}
      </View>
      {problem ? <Text size="caption" tone="err">{problem}</Text> : help ? <Text size="caption" tone="label">{help}</Text> : null}
    </View>
  );
}
