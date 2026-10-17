// The New agent dialog: a large face that changes as you choose, a name, a grid of agent shapes and a row of colours. The job, the projects it works in and what it runs on sit under "More options" in
// the same dialog. It draws the form and calls nothing; the screen owns the values and what Create does.

import { useState } from "react";
import { Pressable, View } from "react-native";
import { Avatar } from "../components/Avatar";
import { markRef } from "../marks/useMark";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { Segmented } from "../components/Segmented";
import { Sheet } from "../components/Sheet";
import { Switch } from "../components/Switch";
import { Text } from "../components/Text";
import { useUiTheme } from "../theme";
// @ts-ignore the agent family's renderer is plain JavaScript
import { AGENT_COLORS } from "../../../../lib/wink-code/agent2.js";
import { SHAPES, lookSeed } from "./agent-look.js";

export type NewAgentValues = { name: string; shape: number; color: number; job: string; projects: string[]; runsOn: "subscription" | "key"; budget: string };

export function NewAgentDialog({ open, onClose, values, onChange, projects, busy, problem, onCreate }: {
  open: boolean; onClose: () => void; values: NewAgentValues; onChange: (v: Partial<NewAgentValues>) => void;
  /** The projects it could work in; null while they load. */ projects: readonly { slug: string; name: string }[] | null;
  busy?: boolean; problem?: string; onCreate: () => void;
}) {
  const { color } = useUiTheme();
  const [more, setMore] = useState(false);
  const seed = lookSeed(values.shape, values.color);
  const toggle = (slug: string) => onChange({ projects: values.projects.includes(slug) ? values.projects.filter((s) => s !== slug) : [...values.projects, slug] });
  return (
    <Sheet open={open} onClose={onClose} title="New agent">
      <View style={{ gap: 20 }}>
        <View style={{ alignItems: "center", paddingTop: 4 }}><Avatar of={markRef("agent", values.name || "agent", undefined, seed)} size={56} /></View>
        <Field label="Name your agent" value={values.name} onChangeText={(name) => onChange({ name })} placeholder="for example rex" help="Lowercase, one word. It signs its chats with it." />
        <View accessibilityLabel="Shape" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
          {SHAPES.map((_, i) => (
            <Pressable key={i} accessibilityRole="radio" accessibilityLabel={`Shape ${i + 1}`} accessibilityState={{ selected: values.shape === i }} onPress={() => onChange({ shape: i })}
              style={{ width: 60, height: 60, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: values.shape === i ? color.selected : color["surface-3"], borderWidth: values.shape === i ? 2 : 0, borderColor: color.primary }}>
              <Avatar of={markRef("agent", `shape ${i}`, undefined, lookSeed(i, values.color))} size={40} />
            </Pressable>
          ))}
        </View>
        <View accessibilityLabel="Colour" style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, justifyContent: "center" }}>
          {(AGENT_COLORS as string[]).map((c, i) => (
            <Pressable key={c} accessibilityRole="radio" accessibilityLabel={`Colour ${i + 1}`} accessibilityState={{ selected: values.color === i }} onPress={() => onChange({ color: i })}
              style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c, alignItems: "center", justifyContent: "center", borderWidth: values.color === i ? 3 : 0, borderColor: color.primary }}>
              {values.color === i ? <Icon name="check" size={16} tone="text" /> : null}
            </Pressable>
          ))}
        </View>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(!more)} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36 }}>
          <Text strong tone="muted">More options</Text>
          <Icon name={more ? "chevron-up" : "chevron-down"} size={16} tone="label" />
        </Pressable>
        {more ? (
          <View style={{ gap: 16 }}>
            <Field label="Job" value={values.job} onChangeText={(job) => onChange({ job })} multiline lines={3} placeholder="What it does, and what it must ask you before doing." />
            <View style={{ gap: 4 }}>
              <Text strong>Works in</Text>
              {projects === null ? <Text tone="muted">Looking.</Text> : !projects.length ? <Text tone="muted">No projects yet. It will see none until you add some.</Text>
                : projects.map((p) => <Row key={p.slug} dense title={p.name} end={<Switch label={p.name} on={values.projects.includes(p.slug)} onChange={() => toggle(p.slug)} />} />)}
            </View>
            <View style={{ gap: 8 }}>
              <Text strong>Runs on</Text>
              <Segmented label="Runs on" value={values.runsOn} onChange={(runsOn) => onChange({ runsOn })} options={[["subscription", "Your Claude plan"], ["key", "An API key with a budget"]]} />
              {values.runsOn === "key" ? <Field label="Monthly budget in dollars" kind="number" value={values.budget} onChangeText={(budget) => onChange({ budget })} help="It stops when the budget is spent." /> : <Text size="caption" tone="label">Uses your plan's allowance.</Text>}
            </View>
          </View>
        ) : null}
        {problem ? <Banner tone="warn">{problem}</Banner> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Button kind="ghost" label="Cancel" onPress={onClose} />
          <Button kind="primary" label={busy ? "Creating" : "Create"} disabled={busy} onPress={onCreate} />
        </View>
      </View>
    </Sheet>
  );
}
