import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../components/Text";
import { Card, Divider } from "../components/Card";
import { Row } from "../components/Row";
import { Button, IconButton } from "../components/Button";
import { Segmented } from "../components/Segmented";
import { EmptyState } from "../components/States";
import { cn } from "../lib/cn";
import { useUiTheme } from "../theme";
import { fmtDate, fmtTime, isoDay, sortRows } from "../fields/logic.js";
import type { FieldEnv } from "../fields/types";
import { MONTHS, WEEKDAYS, dayKey, fieldOf, monthWeeks, rowsByDay, rowsInDays, startMonth, stepMonth, stepWeek, titleOf, val, viewDefOf, viewRows, weekDays, weekTitle } from "./logic.js";

/** The calendar: a month grid or a week on a date field on a wide screen (a week is seven day columns, each in time order); a dot per day and an agenda below on a phone. */
export function CalendarView({ def, rows, env, onOpen, view, noFilter }: { def: any; view?: string; noFilter?: boolean; rows: any[]; env: FieldEnv; onOpen?: (rec: any) => void }) {
  const { phone } = useUiTheme();
  const vd = viewDefOf(def, undefined, view);
  const calFilter = noFilter ? undefined : vd.calendar?.filter;
  const allRows = rows;
  rows = useMemo(() => viewRows(allRows, calFilter), [allRows, calFilter]);
  const f = vd.calendar && fieldOf(def, vd.calendar.date);
  const now = env.now ?? Date.now();
  const [ym, setYm] = useState(() => startMonth(rows, f?.name ?? "", now));
  const [day, setDay] = useState<string | null>(null);
  const [mode, setMode] = useState<"month" | "week">("month");
  const [anchor, setAnchor] = useState(() => isoDay(now));
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const byWeek = useMemo(() => (f ? rowsInDays(rows, f.name, days) : {}), [rows, f, days]);
  const by = useMemo(() => (f ? rowsByDay(rows, f.name, ym) : {}), [rows, f, ym]);
  if (!f) return <EmptyState title="No calendar for this type" body="Its definition has no date to place rows on." />;
  const agenda = mode === "week" ? days.flatMap((k) => byWeek[k] || []) : sortRows(day ? by[day] || [] : Object.values(by).flat(), (r: any) => val(r, f.name), f.kind, { def: f });
  const go = (n: number) => { if (mode === "week") { setAnchor(stepWeek(anchor, n)); return; } setYm(stepMonth(ym, n)); setDay(null); };
  const swap = (m: "month" | "week") => { if (m === "week") setAnchor(day ?? (ym.y === new Date(now).getFullYear() && ym.m === new Date(now).getMonth() ? isoDay(now) : dayKey(ym, 1))); else { const d = new Date(anchor + "T00:00"); setYm({ y: d.getFullYear(), m: d.getMonth() }); } setMode(m); };
  const weeks = monthWeeks(ym.y, ym.m);
  return (
    <View className="gap-s3">
      <View className="flex-row items-center gap-s2">
        <IconButton kind="secondary" icon="chevron-left" label={mode === "week" ? "Previous week" : "Previous month"} onPress={() => go(-1)} />
        <Text strong className="min-w-menu text-center">{mode === "week" ? weekTitle(days) : `${MONTHS[ym.m]} ${ym.y}`}</Text>
        <IconButton kind="secondary" icon="chevron" label={mode === "week" ? "Next week" : "Next month"} onPress={() => go(1)} />
        <View className="flex-1 items-end"><Segmented<"month" | "week"> label="Calendar range" value={mode} onChange={swap} options={[["month", "Month"], ["week", "Week"]]} /></View>
      </View>
      {mode === "week" ? (
        <View accessibilityRole={"grid" as any} className={cn("overflow-hidden rounded-card border border-edge bg-surface-2", phone ? "" : "flex-row")}>
          {days.map((k, i) => {
            const ev = byWeek[k] || [];
            const today = k === isoDay(now);
            return (
              <View key={k} className={cn("min-w-0 gap-s1 p-s2", phone ? (i > 0 ? "border-t border-edge" : "") : cn("min-h-cell flex-1", i > 0 && "border-l border-edge"), today && "bg-selected")}>
                <Text size="caption" strong tone={today ? "accent" : "label"}>{`${WEEKDAYS[i]} ${Number(k.slice(8))}`}</Text>
                {ev.map((r: any) => (
                  <Pressable key={r.urn} accessibilityRole="button" accessibilityLabel={`${titleOf(def, r, vd)}, ${fmtTime(val(r, f.name))}`} onPress={() => onOpen?.(r)} className="min-w-0 self-stretch rounded-chip bg-accent-wash px-s2 py-s1">
                    <Text size="caption" tone="label" numberOfLines={1}>{fmtTime(val(r, f.name))}</Text>
                    <Text size="caption" strong tone="accent" numberOfLines={2}>{titleOf(def, r, vd)}</Text>
                  </Pressable>
                ))}
                {!ev.length && phone ? <Text size="caption" tone="label">Nothing</Text> : null}
              </View>
            );
          })}
        </View>
      ) : null}
      {mode === "month" ? <View accessibilityRole={"grid" as any} className="overflow-hidden rounded-card border border-edge bg-surface-2">
        <View className="flex-row border-b border-edge">
          {WEEKDAYS.map((d) => <View key={d} className="min-w-0 flex-1 items-center py-s2"><Text size="caption" strong tone="label">{d}</Text></View>)}
        </View>
        {weeks.map((w, wi) => (
          <View key={wi} className={cn("flex-row", wi > 0 && "border-t border-edge")}>
            {w.map((d, di) => {
              const key = d ? dayKey(ym, d) : "";
              const ev = d ? by[key] || [] : [];
              const picked = !!d && day === key;
              return (
                <View key={di} className={cn("min-h-touch min-w-0 flex-1 gap-s1 p-s1", phone ? "items-center" : "min-h-cell", di > 0 && "border-l border-edge", picked && "bg-selected")}>
                  {d ? (
                    <Pressable accessibilityRole="button" accessibilityLabel={`${MONTHS[ym.m]} ${d}${ev.length ? `, ${ev.length} ${vd.plural.toLowerCase()}` : ""}`} disabled={!ev.length} onPress={() => setDay(picked ? null : key)} className="min-w-0 gap-s1 self-stretch items-center">
                      <Text size="caption" tone={ev.length ? "default" : "label"} strong={!!ev.length}>{String(d)}</Text>
                      {phone && ev.length ? <View className="h-s2 w-s2 rounded-full bg-accent" /> : null}
                    </Pressable>
                  ) : null}
                  {!phone ? ev.map((r: any) => (
                    <Pressable key={r.urn} accessibilityRole="button" accessibilityLabel={titleOf(def, r, vd)} onPress={() => onOpen?.(r)} className="min-w-0 self-stretch rounded-chip bg-accent-wash px-s2 py-s1">
                      <Text size="caption" strong tone="accent" numberOfLines={1}>{titleOf(def, r, vd)}</Text>
                    </Pressable>
                  )) : null}
                </View>
              );
            })}
          </View>
        ))}
      </View> : null}
      <Card title={mode === "week" ? "This week" : day ? `Agenda, ${fmtDate(day, now)}` : "Agenda"} flush actions={mode === "month" && day ? <Button size="sm" kind="ghost" label="Whole month" onPress={() => setDay(null)} /> : undefined}>
        {agenda.length ? agenda.map((r: any, i: number) => (
          <View key={r.urn}>
            {i > 0 ? <Divider /> : null}
            <Row title={titleOf(def, r, vd)} end={<Text size="caption" tone="label">{fmtDate(val(r, f.name), now)}</Text>} onPress={onOpen ? () => onOpen(r) : undefined} />
          </View>
        )) : <View className="p-s4"><Text tone="label">{`No ${vd.plural.toLowerCase()} ${mode === "week" ? "this week" : day ? "that day" : "this month"}.`}</Text></View>}
      </Card>
    </View>
  );
}
