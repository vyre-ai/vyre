import { View } from "react-native";
import { Field } from "../components/Field";
import { Select } from "../components/Select";
import { Text } from "../components/Text";
import { FormulaBox } from "./FormulaBox";
import { EVERY_CHOICES, eventChoices, stageChoices, stagesOf, TIMED, TRIGGERS, isRecordTrigger } from "./logic.js";
import type { Options } from "./logic.js";

const pick = (list: { name: string; label: string }[]): [string, string][] => list.map((x) => [x.name, x.label]);

/** The settings of one trigger: what starts the Flow, its object, field, stage, form, time, event or watcher, and the optional "only when" filter on what started it. */
export function TriggerFields({ t, setTrig, options }: { t: any; setTrig: (patch: Record<string, unknown>) => void; options: Options }) {
  return (
    <View className="gap-s3">
          {t.kind === "advanced" ? <Text tone="muted">This Flow starts in a way the builder cannot show yet. It is kept as it is.</Text> : null}
          {t.kind === "advanced" ? null : <Select label="What starts the Flow" value={t.kind} options={TRIGGERS.map((x) => [x.id, x.label] as [string, string])} onChange={(kind) => setTrig({ kind })} />}
          {isRecordTrigger(t) || t.kind === "removed" ? <Select label="Object" value={t.type ?? ""} options={pick(options.types)} placeholder="Choose an object" onChange={(type) => setTrig({ type })} /> : null}
          {t.kind === "changed" && t.type ? <Select label="Only when this field changes" value={t.field ?? ""} options={[["", "Any field"], ...((options.types.find((x) => x.name === t.type)?.fields ?? []).map((f) => [f.name, f.label] as [string, string]))]} onChange={(field) => setTrig({ field })} /> : null}
          {t.kind === "changed" ? <Select label="If the record changes again" value={t.again ?? "replace"} options={[["replace", "Start over"], ["keep", "Keep both"]]} onChange={(again) => setTrig({ again })} /> : null}
          {t.kind === "stage" ? (stagesOf(options, t.type).length ? <Select label="Stage" value={t.stage ?? ""} options={stageChoices(options, t.type, t.stage)} placeholder="Choose a stage" onChange={(stage) => setTrig({ stage })} /> : <Field label="Stage" value={t.stage ?? ""} onChangeText={(stage) => setTrig({ stage })} placeholder="For example Drafting" />) : null}
          {t.kind === "form" ? <Field label="Form name" value={t.path ?? ""} onChangeText={(path) => setTrig({ path })} placeholder="For example contact" help="Your site's form posts to this name." /> : null}
          {t.kind === "schedule" ? <Select label="How often" value={t.every ?? ""} options={EVERY_CHOICES.map((x) => [x, x] as [string, string])} placeholder="Choose" onChange={(every) => setTrig({ every })} /> : null}
          {t.kind === "schedule" && TIMED.has(t.every ?? "") ? <Field label="At what time" value={t.at ?? "09:00"} onChangeText={(at) => setTrig({ at })} placeholder="09:00" help="24-hour time in your space's time zone, such as 09:00 or 17:30." /> : null}
          {t.kind === "event" ? <Select label="What happens" value={t.event ?? ""} options={eventChoices(options, t.event)} placeholder="Choose" onChange={(event) => setTrig({ event })} /> : null}
          {t.kind === "watcher" ? <Field label="Watcher name" value={t.watcher ?? ""} onChangeText={(watcher) => setTrig({ watcher })} placeholder="For example new-mail" help="The name of a watcher in your space: a mailbox or a folder it watches. The steps start with the new item." /> : null}
          {["created", "changed", "removed", "event", "watcher"].includes(t.kind) ? <FormulaBox label="Only when (optional, a formula)" value={t.where ?? ""} onChange={(where) => setTrig({ where })} placeholder="For example trigger.after.amount > 500" /> : null}
          {t.kind === "signup" ? <Text tone="muted">Runs when someone signs up through your sign-up form. The person's name and email are what the steps start with.</Text> : null}
    </View>
  );
}
