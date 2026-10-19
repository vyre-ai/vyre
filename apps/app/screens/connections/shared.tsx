// Small parts the Connections sections share: a poll that runs only while a sign-in is open, who-can-use-it, and the vault-item pick.
import { useEffect, useRef } from "react";
import { Linking } from "react-native";
import { View } from "react-native";
import { Button, Chip, Segmented, Text } from "@vyre/ui";
import { WHO, whoHelp, type Guide, type Who } from "./model";

/** Runs `fn` every `ms` while `on`. Nothing runs otherwise: Connections never polls on its own. */
export function usePoll(on: boolean, fn: () => void, ms = 3000) {
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => f.current(), ms);
    return () => clearInterval(t);
  }, [on, ms]);
}

/** Open a page on the device. The link is checked to be https by the caller. */
export const openUrl = (url: string) => { void Linking.openURL(url).catch(() => {}); };

/** "Who can use it": just me, everyone, or the projects picked. */
export function WhoControl({ who, projects, onChange }: { who: Who; projects: { slug: string; name: string }[] | null; onChange: (w: Who) => void }) {
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">Who can use it</Text>
      <Segmented label="Who can use it" value={who.mode} onChange={(mode) => onChange({ ...who, mode })} options={WHO} />
      {who.mode === "some" ? (
        projects && projects.length
          ? <View className="flex-row flex-wrap gap-s2">{projects.map((p) => <Chip key={p.slug} selected={who.projects.includes(p.slug)} onPress={() => onChange({ ...who, projects: who.projects.includes(p.slug) ? who.projects.filter((x) => x !== p.slug) : [...who.projects, p.slug] })}>{p.name}</Chip>)}</View>
          : <Text tone="muted" size="secondary">{projects ? "No projects yet." : "Loading projects."}</Text>
      ) : null}
      <Text size="caption" tone="label">{whoHelp(who.mode)}</Text>
    </View>
  );
}

/** A vault item pick: its names as chips (a value is never shown). */
export function ItemPick({ items, value, onChange, empty }: { items: { name: string }[]; value: string; onChange: (v: string) => void; empty: string }) {
  return items.length
    ? <View className="flex-row flex-wrap gap-s2">{items.map((i) => <Chip key={i.name} selected={value === i.name} onPress={() => onChange(value === i.name ? "" : i.name)}>{i.name}</Chip>)}</View>
    : <Text tone="muted" size="secondary">{empty}</Text>;
}

/** A vendor's own steps for making an app or a token, with its links (https only, checked by the model). */
export function GuideView({ guide }: { guide: Guide | null }) {
  if (!guide) return null;
  return (
    <View className="gap-s1">
      {guide.steps.map((t, i) => <Text key={i} size="secondary">{`${i + 1}. ${t}`}</Text>)}
      {guide.links.map((l) => <View key={l.url} className="self-start"><Button size="sm" kind="ghost" label={l.label} onPress={() => openUrl(l.url)} /></View>)}
    </View>
  );
}
