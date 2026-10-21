import { useEffect, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { Icon } from "../components/Icon";
import { GroupedList } from "../components/GroupedList";
import { Menu } from "../components/Menu";
import { Row } from "../components/Row";
import { Sheet } from "../components/Sheet";
import { Text } from "../components/Text";
import { editField, renderField } from "../fields/registry";
import { isEmpty } from "../fields/logic.js";
import type { FieldEnv } from "../fields/types";
import { isTemplateField, templateLabel } from "../records/template-names.js";
import { isRecordIdField } from "../records/record-id.js";
import { copyValue } from "../records/copy-value.js";
import { copyAndTell } from "../records/clipboard";
import { isInternalField, isLockedField } from "../records/logic.js";
import { px } from "../lib/measure";
import { useUiTheme } from "../theme";
import { useStore } from "../store";
import { showToast } from "../components/Toast";
import { useShowEmpty } from "../../src/state/record-prefs";
import { plainError } from "../../src/real/error-note.js";
import { canSealField, fieldStates, isSealedField, newFieldSpec, sealSpec, stageField, val, viewDefOf } from "./logic.js";
import { AddFieldSheet } from "./AddFieldSheet";
import { QuietIcon } from "./QuietIcon";

const errText = (e: unknown) => plainError(e, "That did not save.");

/**
 * The record's properties: one list, a muted label and the value. Empty ones hide. Hover a row to edit or copy.
 * The record's ID is not a row here. It lives in the header.
 */
export function RecordProperties({ def, rec, env, ai, pool, canCustomize = true, canSeal = true }: {
  def: any; rec: any; env: FieldEnv; /** The agent preview is on: values are what the agent sees, and nothing here edits. */ ai: boolean;
  /** Every record of this type, so "Seal this field" can say how many have a value. */ pool: any[];
  canCustomize?: boolean; canSeal?: boolean;
}) {
  const store = useStore();
  const { phone, color, map } = useUiTheme();
  const vd = viewDefOf(def);
  const [seen, setSeen] = useState<Record<string, any> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>(undefined);
  const [confirm, setConfirm] = useState<{ f: any } | null>(null);
  const [adding, setAdding] = useState(false);
  const [showEmpty] = useShowEmpty();
  const [hover, setHover] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<any>(null);

  useEffect(() => { setEditing(null); setDraft(undefined); }, [rec.urn]);
  useEffect(() => { if (ai) { setEditing(null); setDraft(undefined); } }, [ai]);
  useEffect(() => {
    let live = true;
    if (!ai) { setSeen(null); return; }
    store.seesAs(rec.urn, "assistant").then((s) => { if (live) setSeen(s); }).catch((e) => showToast(errText(e)));
    return () => { live = false; };
  }, [ai, rec.urn, rec.version, store]);

  const valueFor = (f: any) => (ai ? seen?.[f.name] : val(rec, f.name));
  // No proof of its own: the server holds the call for the owner's yes.
  const revealFor = (f: any) => (purpose: string) => store.reveal(rec.urn, f.name, purpose, undefined as never).then((r: any) => r.value as string);
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
    try { await store.sealField?.(def.name, confirm.f.name, String(rec.urn).split("/")[2] || undefined); setConfirm(null); showToast(`${confirm.f.label} is sealed for all ${vd.plural.toLowerCase()}.`); } catch (e) { showToast(errText(e)); }
  };
  const sf = stageField(def);
  // The stage strip is the stage field. The ID is in the header. Empty fields wait in Add a property, except the one being edited and a required one.
  const listed = def.fields.filter((f: any) => !isRecordIdField(f) && (!sf || f.name !== sf.name) && !isInternalField(f, def.name) && states[f.name]?.visible !== false);
  const isBlank = (f: any) => !showEmpty && f.kind !== "sealed" && isEmpty(val(rec, f.name)) && editing !== f.name && !states[f.name]?.required;
  const filled = listed.filter((f: any) => !isBlank(f));
  const empty = listed.filter((f: any) => isBlank(f) && !isLockedField(f));
  const radius = px(map, "--r-row");

  const startEdit = (f: any) => { setEditing(f.name); setDraft(undefined); };
  const fieldRow = (f: any) => {
    const isEditing = editing === f.name && !ai;
    const value = valueFor(f);
    const sealed = isSealedField(f);
    const locked = isLockedField(f);
    const plainEditable = !ai && !locked && f.kind !== "sealed" && f.kind !== "link" && f.kind !== "ref" && f.kind !== "file";
    const shown = renderField({ kind: f.kind, definition: f, value: isTemplateField(rec, f) ? templateLabel(value) : value, mode: "view", read_only: true, reveal: ai ? undefined : revealFor(f) }, env);
    const editItem = { label: "Edit", onPress: () => startEdit(f) };
    const sealItem = sealed || !canSeal || !canSealField(f) ? null : { label: `Seal this field for all ${vd.plural.toLowerCase()}`, onPress: () => setConfirm({ f }) };
    const allItems = ai || locked ? [] : [editItem, ...(sealItem ? [sealItem] : [])];
    // The pencil and a press on the value edit a plain field. The menu keeps Edit for a link, a file or a sealed field, and the seal action.
    const desktopItems = plainEditable ? allItems.filter((i) => i.label !== "Edit") : allItems;
    const hot = hover === f.name;
    const copied = !ai && !isEditing ? copyValue(f, value) : "";
    return (
      <Pressable key={f.name} onHoverIn={() => setHover(f.name)} onHoverOut={() => setHover((h) => (h === f.name ? null : h))}
        onPress={phone && plainEditable && !isEditing ? () => startEdit(f) : undefined}
        onLongPress={phone && allItems.length ? () => setRowMenu({ f, items: allItems }) : undefined}
        style={{ backgroundColor: hot ? color.hover : "transparent", borderRadius: radius }}
        className="flex-row items-center gap-s2 py-s2">
        <View className="gap-s1" style={{ width: "32%" }}>
          <Text size="secondary" tone="label">{f.label}</Text>
          {sealed ? <Chip tone="sealed" icon="vault">Sealed</Chip> : null}
          {states[f.name]?.required && isEmpty(val(rec, f.name)) ? <Chip>Required</Chip> : null}
        </View>
        <View className="min-w-0 flex-1" style={phone && copied ? { paddingRight: px(map, "--touch") } : undefined} {...(Platform.OS === "web" && typeof value === "string" && value.length > 24 ? ({ title: value } as object) : {})}>
          {isEditing ? (
            <View className="gap-s2">
              {editField({ kind: f.kind, definition: f, value, mode: "edit", onChange: setDraft }, env)}
              <View className="flex-row gap-s2">
                <Button kind="primary" size="sm" label="Save" onPress={() => { if (draft === undefined) { setEditing(null); return; } change(f, draft); }} />
                <Button kind="ghost" size="sm" label="Cancel" onPress={() => { setEditing(null); setDraft(undefined); }} />
              </View>
            </View>
          ) : plainEditable ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${f.label}`} onPress={() => startEdit(f)} className="self-start">{shown}</Pressable>
          ) : sealed && !ai && !locked ? (
            <View className="gap-s2">
              {shown}
              <View className="flex-row flex-wrap items-center gap-s2">
                <Button size="sm" kind="ghost" icon="key" label={isEmpty(val(rec, f.name)) ? "Fill" : "Replace"} onPress={() => startEdit(f)} />
                <Text size="caption" tone="label">Hidden from AI; your agent sees a placeholder</Text>
              </View>
            </View>
          ) : shown}
        </View>
        {!isEditing && (copied || (!phone && (plainEditable || desktopItems.length > 0))) ? (
          <View pointerEvents="box-none" style={{ position: "absolute", right: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "center" }}>
            {copied ? <QuietIcon icon="copy" label={`Copy ${String(f.label).toLowerCase()}`} visible={phone || hot} onPress={() => void copyAndTell(copied)} /> : null}
            {!phone && plainEditable ? <QuietIcon icon="edit" label={`Edit ${f.label}`} visible={hot} onPress={() => startEdit(f)} /> : null}
            {!phone && desktopItems.length ? (
              <View style={{ opacity: hot ? 1 : 0 }} pointerEvents={hot ? "auto" : "none"}>
                <Menu align="end" trigger={<Pressable accessibilityRole="button" accessibilityLabel={`${f.label}, more`} style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center" }}><Icon name="more" size={16} tone="label" /></Pressable>} items={desktopItems} />
              </View>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    );
  };

  const addItems = [
    ...empty.map((f: any) => ({ id: f.name, label: String(f.label), onPress: () => startEdit(f) })),
    ...(canCustomize ? [{ id: "new", label: "New property", divider: empty.length > 0, onPress: () => setAdding(true) }] : []),
  ];
  const rows = def.groups?.length
    ? <GroupedList groups={def.groups} items={filled} itemNoun="fields" renderItems={(items) => <View>{items.map((f) => fieldRow(f))}</View>} />
    : <View>{filled.map((f: any) => fieldRow(f))}</View>;
  return (
    <View className="gap-s1">
      {rows}
      {ai || !addItems.length ? null : (
        <Menu align="start" trigger={
          <Pressable accessibilityRole="button" accessibilityLabel="Add a property" className="self-start justify-center" style={{ minHeight: px(map, phone ? "--touch" : "--control-sm") }}>
            <Text size="secondary" tone="faint">+ Add a property</Text>
          </Pressable>
        } items={addItems} />
      )}
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
