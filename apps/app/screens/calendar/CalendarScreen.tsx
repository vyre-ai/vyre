// The space calendar: every record with a date on it, by day, week or month. Read from the Store (records.list per type on a real vyred), so an Event, a
// matter's closing date and a task's due date sit in one place. A tap opens the record. Nothing here knows a type; logic.js reads the definitions.
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { Card, Divider, EmptyState, ErrorState, IconButton, LoadingState, Row, Segmented, Text, Button, useRecordsWorld, useUiTheme } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { byDay, collect, dayHeading, heading, monthGrid, rangeOf, step, subLine, VIEWS, type Item } from "./logic.js";

type Mode = (typeof VIEWS)[number];
const LABEL: Record<Mode, string> = { day: "Day", week: "Week", month: "Month" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function CalendarScreen() {
  const router = useRouter();
  const { phone } = useUiTheme();
  const { data: world, loading, error, reload } = useRecordsWorld();
  const [view, setView] = useState<Mode>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [picked, setPicked] = useState<string | null>(null);

  const items: Item[] = useMemo(() => (world ? collect(world.types, world.byType) : []), [world]);
  const { from, to } = rangeOf(view, anchor);
  const days = useMemo(() => byDay(items, from, to), [items, from.getTime(), to.getTime()]);
  const onDay = (k: string) => days.find((d) => d.day === k)?.items ?? [];
  const open = (i: Item) => router.push(`/u/record/${i.id}` as never);
  const go = (n: number) => { setAnchor(step(view, anchor, n)); setPicked(null); };

  if (error && !world) return <Frame title="Calendar"><ErrorState title="Could not load the calendar" reason={error.message} retry={reload} /></Frame>;
  if (loading && !world) return <Frame title="Calendar"><LoadingState rows={5} /></Frame>;

  const line = (i: Item) => (
    <Row key={`${i.urn}/${i.field}`} dense title={i.title} sub={subLine(i)} chevron onPress={() => open(i)} />
  );
  const agenda = (list: { day: string; items: Item[] }[], heads: boolean) => (
    list.length ? list.map((d) => (
      <View key={d.day} className="gap-s1 pt-s2">
        {heads ? <Text strong size="secondary">{dayHeading(d.day)}</Text> : null}
        <Card flush>{d.items.map((i, n) => <View key={`${i.urn}/${i.field}`}>{n ? <Divider /> : null}{line(i)}</View>)}</Card>
      </View>
    )) : <Card><EmptyState title={items.length ? "Nothing in this period" : "Nothing dated yet"} body={items.length ? "No record has a date here." : "Events and any record with a date appear here."} /></Card>
  );

  const shownDay = picked ?? key(new Date());
  const grid = view === "month" ? monthGrid(anchor) : null;

  return (
    <Frame title="Calendar" sub="Every date in this space, in one place.">
      <View className="flex-row flex-wrap items-center gap-s2">
        <IconButton kind="secondary" icon="chevron-left" label={`Previous ${view}`} onPress={() => go(-1)} />
        <Text strong className="min-w-0 flex-1 text-center">{heading(view, anchor)}</Text>
        <IconButton kind="secondary" icon="chevron" label={`Next ${view}`} onPress={() => go(1)} />
        <Button kind="ghost" size="sm" label="Today" onPress={() => { setAnchor(new Date()); setPicked(null); }} />
      </View>
      <Segmented<Mode> label="View" value={view} onChange={(v) => { setView(v); setPicked(null); }} options={VIEWS.map((v) => [v, LABEL[v]] as [Mode, string])} />

      {grid ? (
        <>
          <View accessibilityRole={"grid" as never} className="overflow-hidden rounded-card border border-edge bg-surface-2">
            <View className="flex-row border-b border-edge">{WEEKDAYS.map((d) => <View key={d} className="min-w-0 flex-1 items-center py-s2"><Text size="caption" strong tone="label">{d}</Text></View>)}</View>
            {grid.map((w, wi) => (
              <View key={wi} className={wi ? "flex-row border-t border-edge" : "flex-row"}>
                {w.map((d, di) => {
                  const k = d ? key(d) : "";
                  const list = d ? onDay(k) : [];
                  const on = !!d && shownDay === k;
                  return (
                    <View key={di} className={`min-h-touch min-w-0 flex-1 p-s1 ${phone ? "items-center" : "min-h-cell gap-s1"} ${di ? "border-l border-edge" : ""} ${on ? "bg-selected" : ""}`}>
                      {d ? (
                        <Pressable accessibilityRole="button" accessibilityLabel={`${dayHeading(k)}${list.length ? `, ${list.length} on it` : ""}`} onPress={() => setPicked(on ? null : k)} className="items-center">
                          <Text size="caption" strong={!!list.length} tone={list.length ? "default" : "label"}>{String(d.getDate())}</Text>
                          {phone && list.length ? <View className="h-s2 w-s2 rounded-full bg-accent" /> : null}
                        </Pressable>
                      ) : null}
                      {!phone ? list.slice(0, 3).map((i) => (
                        <Pressable key={`${i.urn}/${i.field}`} accessibilityRole="button" accessibilityLabel={i.title} onPress={() => open(i)} className="min-w-0 self-stretch rounded-chip bg-accent-wash px-s2 py-s1">
                          <Text size="caption" strong tone="accent" numberOfLines={1}>{i.title}</Text>
                        </Pressable>
                      )) : null}
                      {!phone && list.length > 3 ? <Text size="caption" tone="label">{`+${list.length - 3} more`}</Text> : null}
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
          {agenda(days.filter((d) => d.day === shownDay), true)}
        </>
      ) : agenda(days, view === "week")}
    </Frame>
  );
}
