import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../components/Text";
import { Card, Divider } from "../components/Card";
import { Row } from "../components/Row";
import { Button, IconButton } from "../components/Button";
import { EmptyState } from "../components/States";
import { cn } from "../lib/cn";
import { useUiTheme } from "../theme";
import { fmtDate, sortRows } from "../fields/logic.js";
import type { FieldEnv } from "../fields/types";
import { MONTHS, WEEKDAYS, dayKey, fieldOf, monthWeeks, rowsByDay, startMonth, stepMonth, titleOf, val, viewDefOf, viewRows } from "./logic.js";

/** The calendar: a month grid on a date field on a wide screen; a dot per day and an agenda below on a phone. */
export function CalendarView({ def, rows, env, onOpen, view }: { def: any; view?: string; rows: any[]; env: FieldEnv; onOpen?: (rec: any) => void }) {
  const { phone } = useUiTheme();
  const vd = viewDefOf(def, undefined, view);
  const calFilter = vd.calendar?.filter;
  const allRows = rows;
  rows = useMemo(() => viewRows(allRows, calFilter), [allRows, calFilter]);
  const f = vd.calendar && fieldOf(def, vd.calendar.date);
  const now = env.now ?? Date.now();
  const [ym, setYm] = useState(() => startMonth(rows, f?.name ?? "", now));
  const [day, setDay] = useState<string | null>(null);
  const by = useMemo(() => (f ? rowsByDay(rows, f.name, ym) : {}), [rows, f, ym]);
  if (!f) return <EmptyState title="No calendar for this type" body="Its definition has no date to place rows on." />;
  const agenda = sortRows(day ? by[day] || [] : Object.values(by).flat(), (r: any) => val(r, f.name), f.kind, { def: f });
  const go = (n: number) => { setYm(stepMonth(ym, n)); setDay(null); };
  const weeks = monthWeeks(ym.y, ym.m);
  return (
    <View className="gap-s3">
      <View className="flex-row items-center gap-s2">
        <IconButton kind="secondary" icon="chevron-left" label="Previous month" onPress={() => go(-1)} />
        <Text strong className="min-w-menu text-center">{`${MONTHS[ym.m]} ${ym.y}`}</Text>
        <IconButton kind="secondary" icon="chevron" label="Next month" onPress={() => go(1)} />
        <Text size="caption" tone="label" className="flex-1 text-right">{`by ${f.label.toLowerCase()} date`}</Text>
      </View>
      <View accessibilityRole={"grid" as any} className="overflow-hidden rounded-card border border-edge bg-surface-2">
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
      </View>
      <Card title={day ? `Agenda, ${fmtDate(day, now)}` : "Agenda"} flush actions={day ? <Button size="sm" kind="ghost" label="Whole month" onPress={() => setDay(null)} /> : undefined}>
        {agenda.length ? agenda.map((r: any, i: number) => (
          <View key={r.urn}>
            {i > 0 ? <Divider /> : null}
            <Row title={titleOf(def, r, vd)} end={<Text size="caption" tone="label">{fmtDate(val(r, f.name), now)}</Text>} onPress={onOpen ? () => onOpen(r) : undefined} />
          </View>
        )) : <View className="p-s4"><Text tone="label">{`No ${vd.plural.toLowerCase()} ${day ? "that day" : "this month"}.`}</Text></View>}
      </Card>
    </View>
  );
}
