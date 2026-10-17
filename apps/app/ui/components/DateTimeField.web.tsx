import { createElement, useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "./Text";
import { cn } from "../lib/cn";
import { facesFor } from "../../src/theme/fonts";
import { useUiTheme } from "../theme";
import { joinParts, partsOf, partsProblem } from "./datetime.js";
import { viewerZone } from "../../src/time/show.js";
import type { DateTimeFieldProps } from "./DateTimeField";

/** The web build: each part is the browser's own date or time input, so a person gets a calendar and a clock, dressed in the app's tokens. The value, the zone and the checks are the shared ones (datetime.js). */
export function DateTimeField({ label, value, onChange, zone, dateOnly, disabled, help, error, name }: DateTimeFieldProps) {
  const z = zone || viewerZone();
  const { color, resolved } = useUiTheme();
  const faces = facesFor(resolved.font);
  const [parts, setParts] = useState(() => partsOf(value, z));
  useEffect(() => { if ((value ?? "") !== (joinParts(parts.date, parts.time, z, { dateOnly }) ?? "")) setParts(partsOf(value, z)); }, [value, z]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (next: { date: string; time: string }) => {
    setParts(next);
    if (!next.date.trim() && !next.time.trim()) { onChange(null); return; }
    const iso = joinParts(next.date, next.time, z, { dateOnly });
    if (iso) onChange(iso);
  };
  const problem = error || partsProblem(parts.date, parts.time);
  const input = (type: "date" | "time", v: string, on: (s: string) => void, what: string, width: string) =>
    createElement("input", {
      type, value: v, disabled, "aria-label": `${name ?? label ?? "Date"}, ${what}`, onChange: (e: { target: { value: string } }) => on(e.target.value),
      className: cn("h-control min-w-0 rounded-field border bg-surface-3 px-s3 text-body text-text", problem ? "border-err" : "border-edge", disabled && "opacity-60", width),
      style: { ...(faces.regular as object), color: color.text, backgroundColor: color["surface-3"], colorScheme: "light dark", outlineStyle: "none" },
    });
  return (
    <View className="min-w-0 gap-s1">
      {label ? <Text size="caption" strong tone="label">{label}</Text> : null}
      <View className="flex-row gap-s2">
        {input("date", parts.date, (date) => set({ ...parts, date }), "day", "flex-1")}
        {dateOnly ? null : input("time", parts.time, (time) => set({ ...parts, time }), "time", "w-32")}
      </View>
      {problem ? <Text size="caption" tone="err">{problem}</Text> : help ? <Text size="caption" tone="label">{help}</Text> : null}
    </View>
  );
}
