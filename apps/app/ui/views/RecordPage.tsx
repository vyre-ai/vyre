import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../components/Text";
import { Card, Divider } from "../components/Card";
import { Row } from "../components/Row";
import { Chip } from "../components/Chip";
import { Banner } from "../components/Banner";
import { Button, IconButton } from "../components/Button";
import { Segmented } from "../components/Segmented";
import { Menu } from "../components/Menu";
import { Sheet } from "../components/Sheet";
import { Field } from "../components/Field";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { StageSteps } from "../components/StageSteps";
import { TimelineItem } from "../components/TimelineItem";
import { showToast } from "../components/Toast";
import { cn } from "../lib/cn";
import { useUiTheme } from "../theme";
import { useStore } from "../store";
import { editField, renderField, KINDS } from "../fields/registry";
import { isEmpty, isSealedValue, sampleFor } from "../fields/logic.js";
import type { FieldEnv } from "../fields/types";
import { theirTimeOf } from "../../src/time/show.js";
import { ASSISTANT_MARK } from "../../src/store-core/kernel-view.js";
import { actorWords, ago, assistantNote, eventWhat, fieldStates, filesOf, isSealedField, newFieldSpec, relatedRecords, sealSpec, stageField, timelineLine, titleOf, val, viewDefOf } from "./logic.js";
import type { RecordsWorld } from "./shared";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The record page: all the fields in order (press one to change it), the stage steps, You or Your assistant sees, Add a field, the timeline from the Event log,
 * linked records and files. Every value goes through the field renderers, so a field added to the type shows here with no new code. Writes go to the Store
 * and the page redraws from it; a sealed value goes through putSealed and reveals through reveal, which the box holds for the owner's yes on their phone.
 */
export function RecordPage({ def, rec, world, events, env, onOpen, story }: { def: any; rec: any; world: RecordsWorld; events: any[]; env: FieldEnv; onOpen: (urn: string) => void; story?: React.ReactNode }) {
  const store = useStore();
  const { phone } = useUiTheme();
  const vd = viewDefOf(def);
  const [who, setWho] = useState<"person" | "assistant">("person");
  const [seen, setSeen] = useState<Record<string, any> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>(undefined);
  const [confirm, setConfirm] = useState<{ f: any } | null>(null);
  const [adding, setAdding] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<any>(null);
  const ai = who === "assistant";

  useEffect(() => {
    let live = true;
    if (!ai) { setSeen(null); return; }
    store.seesAs(rec.urn, "assistant").then((s) => { if (live) setSeen(s); }).catch((e) => showToast(errText(e)));
    return () => { live = false; };
  }, [ai, rec.urn, rec.version, store]);

  const valueFor = (f: any) => (ai ? seen?.[f.name] : val(rec, f.name));
  const revealFor = (f: any) => (purpose: string) => store.reveal(rec.urn, f.name, purpose, undefined as never /* no proof of its own: the box holds the call for the owner's yes */).then((r: any) => r.value as string);
  // Conditional fields (visible_if, required_if): judged on the record as it is now, the same way the gateway judges a write.
  const states = fieldStates(def, rec.data || {});
  const change = async (f: any, v: any) => {
    if (f.kind !== "sealed" && isEmpty(v) && states[f.name]?.required) { showToast(`${f.label} is required`); return; }
    try {
      if (f.kind === "sealed") { if (v !== undefined) await store.putSealed(rec.urn, f.name, String(v)); }
      else await store.update(rec.urn, { [f.name]: v }, rec.version);
      setEditing(null); setDraft(undefined);
    } catch (e) { showToast(errText(e)); }
  };
  const sealAll = async () => {
    if (!confirm) return;
    try { await store.sealField?.(def.name, confirm.f.name); setConfirm(null); } catch (e) { showToast(errText(e)); }
  };
  const sf = stageField(def);
  const stages: string[] = sf ? [...(sf.options || [])] : [];
  const sealedNow = def.fields.filter((f: any) => isSealedField(f) && !isEmpty(val(rec, f.name)));
  const related = relatedRecords(world.types, world.byType, def, rec);
  const files = filesOf(def, rec);
  const pool = world.byType[def.name] || [rec];
  // The stage strip above is the stage field's renderer, so the list leaves it out; empty fields wait behind one line, except the one being edited.
  const listed = def.fields.filter((f: any) => (!sf || f.name !== sf.name) && states[f.name]?.visible !== false);
  const isBlank = (f: any) => f.kind !== "sealed" && isEmpty(val(rec, f.name)) && editing !== f.name && !states[f.name]?.required;
  const filled = listed.filter((f: any) => !isBlank(f));
  const empty = listed.filter(isBlank);

  const fieldRow = (f: any) => {
    const isEditing = editing === f.name && !ai;
    const value = valueFor(f);
    const sealed = isSealedField(f);
    const plainEditable = !ai && f.kind !== "sealed" && f.kind !== "link" && f.kind !== "ref" && f.kind !== "file";
    const shown = renderField({ kind: f.kind, definition: f, value, mode: "view", read_only: true, reveal: ai ? undefined : revealFor(f) }, env);
    const items = [
      { label: "Edit", onPress: () => { setEditing(f.name); setDraft(undefined); } },
      ...(sealed ? [] : [{ label: `Seal this field for all ${vd.plural.toLowerCase()}`, onPress: () => setConfirm({ f }) }]),
    ];
    // Desktop: the menu shows on hover (or while the row is being edited). Phone: tap the row to edit, long-press for the menu.
    const menuNode = !ai && !phone ? (
      <View className="flex-none" style={{ opacity: hover === f.name || isEditing ? 1 : 0 }}>
        <Menu trigger={<IconButton icon="more" label={`${f.label}, more`} />} items={items} />
      </View>
    ) : null;
    return (
      <Pressable key={f.name} disabled={ai || !phone || isEditing} onPress={plainEditable ? () => { setEditing(f.name); setDraft(undefined); } : undefined} onLongPress={() => setRowMenu({ f, items })}
        onHoverIn={() => setHover(f.name)} onHoverOut={() => setHover((h) => (h === f.name ? null : h))}
        className={cn("gap-s1 px-s4 py-s3", !phone && "flex-row items-center gap-s3")}>
        <View className={cn("flex-row flex-wrap items-center gap-s2", !phone && "flex-1")}>
          <Text tone="label">{f.label}</Text>
          {sealed ? <Chip tone="sealed" icon="vault">Sealed</Chip> : null}
          {states[f.name]?.required && isEmpty(val(rec, f.name)) ? <Chip>Required</Chip> : null}
        </View>
        <View className={cn("min-w-0", !phone && "flex-[3]")}>
          {isEditing ? (
            <View className="gap-s2">
              {editField({ kind: f.kind, definition: f, value, mode: "edit", onChange: setDraft }, env)}
              <View className="flex-row gap-s2">
                <Button kind="primary" size="sm" label="Save" onPress={() => { if (draft === undefined) { setEditing(null); return; } change(f, draft); }} />
                <Button kind="ghost" size="sm" label="Cancel" onPress={() => { setEditing(null); setDraft(undefined); }} />
              </View>
            </View>
          ) : plainEditable ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${f.label}`} onPress={() => { setEditing(f.name); setDraft(undefined); }} className="self-start">{shown}</Pressable>
          ) : sealed && !ai ? (
            <View className="gap-s2">
              {shown}
              <View className="flex-row flex-wrap items-center gap-s2">
                <Button size="sm" kind="ghost" icon="key" label={isEmpty(val(rec, f.name)) ? "Fill" : "Replace"} onPress={() => { setEditing(f.name); setDraft(undefined); }} />
                <Text size="caption" tone="label">Hidden from AI; your assistant sees a placeholder</Text>
              </View>
            </View>
          ) : shown}
        </View>
        {menuNode}
      </Pressable>
    );
  };

  // A contact's local time, from the Contact's time_zone (lib/time reads it).
  const theirs = def.name === "contact" ? theirTimeOf(Date.now(), rec.data?.time_zone) : null;
  const main = (
    <View className={cn("min-w-0 gap-s4", !phone && "flex-[2]")}>
      {theirs ? <Text size="caption" tone="label">{`It is ${theirs} where they are`}</Text> : null}
      <Card flush>
        {filled.map((f: any, i: number) => <View key={f.name}>{i > 0 ? <Divider /> : null}{fieldRow(f)}</View>)}
        {empty.length ? (
          <View>
            {filled.length ? <Divider /> : null}
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showEmpty }} onPress={() => setShowEmpty(!showEmpty)} className="min-h-control flex-row items-center justify-between px-s4 py-s3">
              <Text tone="label">{`${empty.length} empty ${empty.length === 1 ? "field" : "fields"}`}</Text>
              <Icon name={showEmpty ? "chevron-up" : "chevron-down"} size={16} tone="label" />
            </Pressable>
            {showEmpty ? empty.map((f: any) => <View key={f.name}><Divider />{fieldRow(f)}</View>) : null}
          </View>
        ) : null}
      </Card>
      {story}
      <Card title="Changes" actions={<Text size="caption" tone="label">Every field change, who and why</Text>}>
        {events.length ? events.map((e) => {
          const l = timelineLine(e);
          return <TimelineItem key={l.id} actor={actorWords(l.actor, world, (world as { me?: string }).me)} what={eventWhat(l.what)} mark={l.via ? ASSISTANT_MARK : undefined} at={ago(l.at, env.now ?? Date.now())} why={l.why} />;
        }) : <Text tone="label">Nothing has happened yet.</Text>}
      </Card>
    </View>
  );
  const side = (
    <View className={cn("min-w-0 gap-s4", !phone && "flex-1")}>
      <Card title="Linked records" flush>
        {related.length ? related.map((l, i) => (
          <View key={l.urn}>
            {i > 0 ? <Divider /> : null}
            <Row lead={<Avatar of={{ kind: l.type === "contact" ? "person" : "project", id: l.urn, name: l.title }} />} title={l.title} sub={l.type[0].toUpperCase() + l.type.slice(1)} onPress={() => onOpen(l.urn)} />
          </View>
        )) : <View className="px-s4 pb-s4"><Text tone="label">Nothing linked.</Text></View>}
      </Card>
      <Card title="Files" flush>
        {files.length ? files.map((x: any, i: number) => (
          <View key={x.field}>
            {i > 0 ? <Divider /> : null}
            <Row lead={<Icon name="file" size={20} />} title={x.name} sub={x.field} />
          </View>
        )) : <View className="px-s4 pb-s4"><Text tone="label">No files.</Text></View>}
      </Card>
    </View>
  );

  return (
    <View className="gap-s4">
      {sf ? <StageSteps strip={phone} stages={stages} current={stages.indexOf(String(val(rec, sf.name) ?? ""))} onSelect={ai ? undefined : (s) => change(sf, s)} /> : null}
      <View className="flex-row flex-wrap items-center gap-s3">
        <Segmented<"person" | "assistant"> label="Who is looking" value={who} onChange={(v) => { setWho(v); setEditing(null); }} options={[["person", "You"], ["assistant", "Your assistant sees"]]} />
        <View className="flex-1" />
        {ai ? null : phone ? <IconButton icon="plus" label="Add a field" kind="secondary" onPress={() => setAdding(true)} /> : <Button size="sm" icon="plus" label="Add a field" onPress={() => setAdding(true)} />}
      </View>
      {ai ? (
        <Banner tone="warn">
          <Text strong>This is what an assistant sees.</Text>
          <Text size="caption" tone="muted">{assistantNote(sealedNow)}</Text>
        </Banner>
      ) : null}
      <View className={cn("gap-s4", !phone && "flex-row items-start")}>{main}{side}</View>

      <Sheet open={!!rowMenu} onClose={() => setRowMenu(null)} title={rowMenu?.f.label}>
        <View>{(rowMenu?.items ?? []).map((it: any) => <Row key={it.label} title={it.label} onPress={() => { setRowMenu(null); it.onPress(); }} />)}</View>
      </Sheet>
      <Sheet open={!!confirm} onClose={() => setConfirm(null)} title={confirm ? sealSpec(def, confirm.f, pool, vd).title : undefined}>
        <Text tone="muted">{confirm ? sealSpec(def, confirm.f, pool, vd).body : ""}</Text>
        <View className="flex-row gap-s2">
          <Button kind="primary" label={confirm ? sealSpec(def, confirm.f, pool, vd).action : "Seal"} onPress={sealAll} />
          <Button kind="ghost" label="Cancel" onPress={() => setConfirm(null)} />
        </View>
      </Sheet>
      <AddFieldSheet open={adding} onClose={() => setAdding(false)} def={def} env={env} onAdd={async (draftSpec) => { try { await store.addField?.(def.name, newFieldSpec(draftSpec, def) as any); setAdding(false); } catch (e) { showToast(errText(e)); } }} />
    </View>
  );
}

/** Add a field: a name, one of the fifteen kinds, and both renderers drawn live from a sample so the person sees how it shows and how it is edited. */
function AddFieldSheet({ open, onClose, def, env, onAdd }: { open: boolean; onClose: () => void; def: any; env: FieldEnv; onAdd: (d: { label: string; kind: string }) => void }) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState("text");
  const vd = viewDefOf(def);
  const draft = { name: "new", label: label.trim() || "New field", kind, options: ["Option A", "Option B"], to: def.name };
  const sample = sampleFor(draft, env);
  return (
    <Sheet open={open} onClose={onClose} title={`Add a field to ${vd.plural}`}>
      <Text tone="muted">{`Every ${def.label.toLowerCase()} gets it. The list, board, record page and the assistant's view pick it up with no new screen.`}</Text>
      <Field label="Name" value={label} placeholder="For example Preferred contact time" onChangeText={setLabel} />
      <View className="gap-s1">
        <Text size="caption" strong tone="label">Kind</Text>
        <View accessibilityRole="menu" className="flex-row flex-wrap gap-s1">{KINDS.map(([k, l]) => <Chip key={k} selected={k === kind} onPress={() => setKind(k)}>{l}</Chip>)}</View>
      </View>
      <View className="gap-s2">
        <Text size="caption" strong tone="label">How it shows</Text>
        {renderField({ kind, definition: draft as any, value: sample, mode: "view", read_only: true }, env)}
        <Text size="caption" strong tone="label">How it is edited</Text>
        <View key={kind}>{editField({ kind, definition: draft as any, value: isSealedValue(sample) ? null : sample, mode: "edit" }, env)}</View>
      </View>
      <View className="flex-row gap-s2">
        <Button kind="primary" label={`Add to ${vd.plural}`} disabled={!label.trim()} onPress={() => { onAdd({ label, kind }); setLabel(""); setKind("text"); }} />
        <Button kind="ghost" label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}
