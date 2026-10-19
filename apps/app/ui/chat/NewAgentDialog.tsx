// The New agent dialog: a large face that changes as you choose, a name, a grid of agent shapes and a row of colours. The job, the projects it works in and what it runs on sit under "More options" in
// the same dialog. It draws the form and calls nothing; the screen owns the values and what Create does.

import { useState } from "react";
import { Pressable, View } from "react-native";
import { Avatar } from "../components/Avatar";
import { markRef } from "../marks/useMark";
import { Banner } from "../components/Banner";
import { Button, IconButton } from "../components/Button";
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
import { PARTS, SHAPES, lookSeed } from "./agent-look.js";

/** What each of the sixteen colours is called, for a screen reader (the order of AGENT_COLORS). */
const COLOUR_NAMES = ["Peach", "Sun", "Seafoam", "Amber", "Rose", "Sand", "Salmon", "Sage", "Blue", "Indigo", "Violet", "Teal", "Coral", "Mint", "Sky", "Graphite"];

export type NewAgentValues = { name: string; shape: number; color: number; job: string; projects: string[]; runsOn: "subscription" | "key"; budget: string; model: string; effort: string; computer: boolean; personal: boolean };

/** The effort choices: the box's own default, then four levels. */
const EFFORTS: [string, string][] = [["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["max", "Max"]];

/**
 * The grid of eight shapes and the sixteen colours that make an agent's look, and, when the caller can change a part (`parts` and `onPart`), a "Customize" icon button that opens the character's parts as rows of
 * little faces (eyes, mouth, top, blush, charm): each face is the look as it would be with that option. One component for first run's Assistant step, an agent's Details, the New agent dialog and Settings.
 */
export function AgentLookPicker({ shape, color: col, parts, onChange, onPart }: { shape: number; color: number; onChange: (p: { shape?: number; color?: number }) => void; /** The character's parts now, by key (e, m, t, b, h): with onPart the picker also lets the person change them. */ parts?: Record<string, number>; onPart?: (key: string, value: number) => void }) {
  const { color } = useUiTheme();
  const values = { shape, color: col };
  const [open, setOpen] = useState(false);
  const base = lookSeed(shape, col);
  /** The look with one part set to one option, the other parts as they are now: what that option's little face is drawn from. */
  const withOne = (key: string, value: number) => base + PARTS.map((q) => `~${q.key}${q.key === key ? value : parts?.[q.key] ?? 0}`).join("");
  return (
    <View style={{ gap: 20 }}>
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
            <Pressable key={c} accessibilityRole="radio" accessibilityLabel={`${COLOUR_NAMES[i] ?? `Colour ${i + 1}`}`} accessibilityState={{ selected: values.color === i }} onPress={() => onChange({ color: i })}
              style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c, alignItems: "center", justifyContent: "center", borderWidth: values.color === i ? 3 : 0, borderColor: color.primary }}>
              {values.color === i ? <Icon name="check" size={16} tone="text" /> : null}
            </Pressable>
          ))}
        </View>
        {parts && onPart ? (
          <View style={{ gap: 12 }}>
            <View style={{ alignItems: "center" }}>
              <IconButton icon="face" label="Customize" kind={open ? "secondary" : "ghost"} onPress={() => setOpen((v) => !v)} />
            </View>
            {open ? PARTS.map((p) => (
              <View key={p.key} accessibilityLabel={p.label} style={{ gap: 6 }}>
                <Text size="caption" tone="label">{p.label}</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {p.words.map((w, i) => (
                    <Pressable key={w} accessibilityRole="radio" accessibilityLabel={`${p.label}: ${w}`} accessibilityState={{ selected: parts[p.key] === i }} onPress={() => onPart(p.key, i)}
                      style={{ width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: parts[p.key] === i ? color.selected : color["surface-3"], borderWidth: parts[p.key] === i ? 2 : 0, borderColor: color.primary }}>
                      <Avatar of={markRef("agent", `${p.key}${i}`, undefined, withOne(p.key, i))} size={34} />
                    </Pressable>
                  ))}
                </View>
              </View>
            )) : null}
          </View>
        ) : null}
    </View>
  );
}

export function NewAgentDialog({ open, onClose, values, onChange, projects, models, owner, busy, problem, onCreate }: {
  open: boolean; onClose: () => void; values: NewAgentValues; onChange: (v: Partial<NewAgentValues>) => void;
  /** The projects it could work in; null while they load. */ projects: readonly { slug: string; name: string }[] | null;
  /** The box's model choices (sessions.models.get); null while they load, empty when it lists none. */ models?: readonly { id: string; name: string }[] | null;
  /** The person may give an agent a computer and let it use their personal memory: owner only. */ owner?: boolean;
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
        <AgentLookPicker shape={values.shape} color={values.color} onChange={(p) => onChange(p)} />
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(!more)} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36 }}>
          <Text medium tone="muted">More options</Text>
          <Icon name={more ? "chevron-up" : "chevron-down"} size={16} tone="label" />
        </Pressable>
        {more ? (
          <View style={{ gap: 16 }}>
            <Field label="Job" value={values.job} onChangeText={(job) => onChange({ job })} multiline lines={3} placeholder="What it does, and what it must ask you before doing." />
            <View style={{ gap: 4 }}>
              <Text medium>Works in</Text>
              {projects === null ? <Text tone="muted">Looking.</Text> : !projects.length ? <Text tone="muted">No projects yet. It will see none until you add some.</Text>
                : projects.map((p) => <Row key={p.slug} dense title={p.name} end={<Switch label={p.name} on={values.projects.includes(p.slug)} onChange={() => toggle(p.slug)} />} />)}
            </View>
            <View style={{ gap: 8 }}>
              <Text medium>Model</Text>
              {models === undefined || models === null ? <Text tone="muted">Looking.</Text> : models.length ? <Segmented label="Model" value={values.model} onChange={(model) => onChange({ model })} options={[["", "Default"], ...models.slice(0, 4).map((m) => [m.id, m.name] as [string, string])]} /> : <Text tone="muted">The box picks the model.</Text>}
              <Text medium>Effort</Text>
              <Segmented label="Effort" value={values.effort} onChange={(effort) => onChange({ effort })} options={EFFORTS} />
            </View>
            {owner ? (
              <View style={{ gap: 4 }}>
                <Row dense title="Give it a computer" sub="Its own Chrome, terminal and files in Space's Cloud" end={<Switch label="Give it a computer" on={values.computer} onChange={(computer) => onChange({ computer })} />} />
                <Row dense title="Let it use your personal memory" sub="What you have told your own assistant" end={<Switch label="Let it use your personal memory" on={values.personal} onChange={(personal) => onChange({ personal })} />} />
              </View>
            ) : null}
            <View style={{ gap: 8 }}>
              <Text medium>Runs on</Text>
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
