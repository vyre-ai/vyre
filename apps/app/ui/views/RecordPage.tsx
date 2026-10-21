import { useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Row } from "../components/Row";
import { StageSteps } from "../components/StageSteps";
import { Text } from "../components/Text";
import { TimelineItem } from "../components/TimelineItem";
import { showToast } from "../components/Toast";
import { isEmpty } from "../fields/logic.js";
import type { FieldEnv } from "../fields/types";
import { groupRelated, viaOf } from "../records/logic.js";
import { cn } from "../lib/cn";
import { px } from "../lib/measure";
import { useUiTheme } from "../theme";
import { useStore } from "../store";
import { theirTimeOf } from "../../src/time/show.js";
import { ASSISTANT_MARK } from "../../src/store-core/kernel-view.js";
import { plainError } from "../../src/real/error-note.js";
import { actorWords, ago, assistantNote, eventWhat, fieldStates, filesOf, isSealedField, relatedRecords, stageField, timelineLine, val, viewDefOf } from "./logic.js";
import type { RecordsWorld } from "./shared";
import { RecordProperties } from "./RecordProperties";
import { RecordSection } from "./RecordSection";

const errText = (e: unknown) => plainError(e, "That did not save.");

/**
 * The record page: the stage steps, the properties, and the sections under them (connections and history when the screen gives them, otherwise the change list, then linked records and files).
 * Who is looking is the screen's More menu. While the agent preview is on, a slim line offers the way back.
 */
export function RecordPage({ def, rec, world, events, env, onOpen, story, onNew, onStage, canCustomize = true, canSeal = true, who: whoProp, onWho }: {
  def: any; rec: any; world: RecordsWorld; events: any[]; env: FieldEnv; onOpen: (urn: string) => void; story?: ReactNode;
  /** Given, each type that links here gets "Add a <type>" under its list: the type, and the field of it that links to this record. */ onNew?: (type: string, via: string) => void;
  /** Given, a tap on the stage strip goes through it (the move rule: a stage that needs fields asks for them) instead of writing the stage field directly. */ onStage?: (stage: string) => void;
  /** An owner or an admin: New property shows (the server refuses anyone else). */ canCustomize?: boolean;
  /** An owner or an admin on their own server: "Seal this field" shows. */ canSeal?: boolean;
  /** "person" or "assistant". The screen owns it when the More menu does; omitted, the page keeps its own. */ who?: "person" | "assistant";
  onWho?: (who: "person" | "assistant") => void;
}) {
  const store = useStore();
  const { phone, color, map } = useUiTheme();
  const [ownWho, setOwnWho] = useState<"person" | "assistant">("person");
  const who = whoProp ?? ownWho;
  const setWho = (next: "person" | "assistant") => (onWho ? onWho(next) : setOwnWho(next));
  const ai = who === "assistant";
  const [pageW, setPageW] = useState(0);
  const sideBySide = !phone && (pageW === 0 || pageW >= 760);
  const sf = stageField(def);
  const stages: string[] = sf ? [...(sf.options || [])] : [];
  const states = fieldStates(def, rec.data || {});
  const pickStage = (s: string) => {
    if (!sf || ai) return;
    if (onStage) { onStage(s); return; }
    if (isEmpty(s) && states[sf.name]?.required) { showToast(`${sf.label} is required`); return; }
    void store.update(rec.urn, { [sf.name]: s }, rec.version).catch((e) => showToast(errText(e)));
  };
  const sealedNow = def.fields.filter((f: any) => isSealedField(f) && !isEmpty(val(rec, f.name)));
  const related = relatedRecords(world.types, world.byType, def, rec);
  const files = filesOf(def, rec);
  const theirs = def.name === "contact" ? theirTimeOf(Date.now(), rec.data?.time_zone) : null;
  const changes = (
    <RecordSection title="Changes" action={<Text size="caption" tone="label">Every field change, who and why</Text>}>
      {events.length ? events.map((e) => {
        const l = timelineLine(e);
        return <TimelineItem key={l.id} actor={actorWords(l.actor, world, (world as { me?: string }).me)} what={eventWhat(l.what)} mark={l.via ? ASSISTANT_MARK : undefined} at={ago(l.at, env.now ?? Date.now())} why={l.why} />;
      }) : <Text tone="label">Nothing has happened yet.</Text>}
    </RecordSection>
  );
  const main = (
    <View className={cn("min-w-0", sideBySide && "flex-[2]")}>
      {theirs ? <View className="pb-s2"><Text size="caption" tone="label">{`It is ${theirs} where they are`}</Text></View> : null}
      <RecordProperties def={def} rec={rec} env={env} ai={ai} pool={world.byType[def.name] || [rec]} canCustomize={canCustomize} canSeal={canSeal} />
      {story ?? changes}
    </View>
  );
  const side = (
    <View className={cn("min-w-0", sideBySide && "flex-1")}>
      {related.length ? groupRelated(related, Object.fromEntries(world.types.map((t: any) => [t.name, { label: t.label, plural: viewDefOf(t).plural }]))).map((g) => {
        const via = onNew ? viaOf(world.types, g.type, def.name) : undefined;
        return (
          <RecordSection key={g.type} title={g.plural} action={via ? <Button kind="ghost" size="sm" icon="plus" label={`Add ${g.label.toLowerCase()}`} onPress={() => onNew?.(g.type, via)} /> : undefined}>
            {g.rows.map((l) => <Row key={l.urn} className="px-0" title={l.title} sub={g.label} onPress={() => onOpen(l.urn)} />)}
          </RecordSection>
        );
      }) : <RecordSection title="Linked records"><Text tone="label">Nothing linked.</Text></RecordSection>}
      <RecordSection title="Files">
        {files.length ? files.map((x: any) => <Row key={x.field} className="px-0" lead={<Icon name="file" size={20} />} title={x.name} sub={x.field} />) : <Text tone="label">No files.</Text>}
      </RecordSection>
    </View>
  );
  return (
    <View className="gap-s4" onLayout={(e) => { const w = Math.round(e.nativeEvent.layout.width); setPageW((p) => (Math.abs(p - w) > 8 ? w : p)); }}>
      {sf ? <StageSteps strip={phone} stages={stages} current={stages.indexOf(String(val(rec, sf.name) ?? ""))} onSelect={ai ? undefined : pickStage} /> : null}
      {ai ? (
        <View className="gap-s2">
          <View className="flex-row flex-wrap items-center gap-s2 px-s3 py-s2" style={{ backgroundColor: color.hover, borderRadius: px(map, "--r-row") }}>
            <Icon name="eye" size={16} />
            <Text size="secondary">Showing what your agent sees</Text>
            <Button kind="ghost" size="sm" label="Back to yours" onPress={() => setWho("person")} />
          </View>
          {sealedNow.length ? <Text size="caption" tone="label">{assistantNote(sealedNow)}</Text> : null}
        </View>
      ) : null}
      <View className={cn(sideBySide && "flex-row items-start gap-s6")}>{main}{side}</View>
    </View>
  );
}
