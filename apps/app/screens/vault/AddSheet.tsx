// The Vault's Add sheet: one sheet, three ways in. "Paste from .env" (lines or a dropped .env file become items grouped by prefix, to rename, regroup, untick and mark plain or
// secret), "Blank item" (a name and fields), and "Pick an app" (what Vyre's modules need, the catalog's apps, this Space's templates, or any other app by name, whose fields the
// person's own AI account suggests). AI accounts and app sign-ins are not added here: one line links to where they live. Rules in add-model.js and env-model.js.
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Field, IconTile, Menu, Row, Select, Sheet, Switch, Text, type IconName } from "@vyre/ui";
import { usePhone } from "../places/Page";
import { DropZone } from "./DropZone";
import { FieldsEditor } from "./FieldsEditor";
import { blankDraft, draftOf, kindCall, loginDraft, newField, noteDraft, saveCall, searchTemplates, suggestionDraft, suggestionNote, templates, type Need, type Saved, type Template } from "./add-model.js";
import { slugOf, liveName, moveField, pasteDrafts, secretHint, setField, valueWarning, withoutEnds, itemCall, type Draft } from "./env-model.js";
import type { Suggestion } from "./redesign-data";
import { openExternal } from "../../src/shell/open-external";

export type Call = { tool: string; input: Record<string, unknown>; /** The fields to save as plain (vault.use.set). */ plain?: string[] };
type Scope = "mine" | "shared";
type Step = { kind: "start" } | { kind: "paste" } | { kind: "pick" } | { kind: "form"; how: "blank" | "template" | "login" | "note"; template: Template | null; note?: string };

const ICON: Record<string, IconName> = { need: "bolt", app: "key", space: "vault" };

type Props = Parameters<typeof AddBody>[0];

/** The Add sheet: the body below in the one Sheet. */
export function AddSheet(p: Props) {
  return <Sheet open={p.open} onClose={p.onClose} title={p.scope === "shared" && !p.member ? "Add to Shared" : "Add to Mine"}><AddBody {...p} /></Sheet>;
}

/** What the sheet shows, apart from the sheet itself, so the gallery can draw it in place. */
export function AddBody({ open, scope, member, busy, problem, onClose, onSave, needs, saved, suggest, want, folders, initialPaste }: {
  open: boolean; scope: Scope; /** A member adds to her own vault only, and fills no module's need. */ member: boolean; busy: boolean; /** What the box said to the last Save. */ problem: string;
  onClose: () => void; onSave: (calls: Call[], label: string, folder: string | null) => void;
  needs: Need[]; saved: Saved[]; suggest?: (app: string) => Promise<Suggestion>;
  /** Opened from a need ("This needs a key"): the template to open on; or "login:<name>" or "blank:<name>" for an item a task or a Flow step asked for. */ want?: string | null;
  /** Shared only: the folders an item can go in. */ folders: { id: string; name: string }[];
  /** The gallery's picture of the preview: lines to open on, already read. */ initialPaste?: string;
}) {
  const phone = usePhone();
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "start" });
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>(blankDraft());
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [asking, setAsking] = useState(false);
  const [folder, setFolder] = useState<string>("");
  const list = useMemo(() => templates({ needs: member ? [] : needs, saved }), [needs, saved, member]);
  const found = useMemo(() => searchTemplates(list, q), [list, q]);

  const openOn = (t: Template) => { setDraft(draftOf(t)); setErr(""); setStep({ kind: "form", how: "template", template: t }); };
  useEffect(() => {
    if (!open) return;
    setText(""); setDrafts([]); setSkipped([]); setQ(""); setErr(""); setFolder(folders[0]?.id ?? "");
    const t = want ? list.find((x) => x.id === want) : null;
    const named = want ? /^(login|blank):(.*)$/.exec(want) : null;
    if (t) openOn(t);
    else if (named) { setDraft({ ...(named[1] === "login" ? loginDraft() : blankDraft()), name: named[2] }); setStep({ kind: "form", how: named[1] === "login" ? "login" : "blank", template: null }); }
    else if (initialPaste) { const r = pasteDrafts(initialPaste); setText(initialPaste); setDrafts(r.drafts); setSkipped(r.skipped); setStep({ kind: "paste" }); }
    else setStep({ kind: "start" });
  }, [open, want]);

  const where = scope === "shared" && !member ? (folders.length ? folders.find((f) => f.id === folder)?.name ?? folders[0].name : "a new Team folder") : "Mine";
  const go = (calls: Call[], label: string) => { setErr(""); onSave(calls, label, scope === "shared" && !member ? folder || folders[0]?.id || null : null); };

  const top = (
    <View className="gap-s1">
      <Text size="caption" tone="label">AI accounts are added in Settings, AI accounts. App sign-ins, like Google and GitHub, are added in Connections.</Text>
      <View className="flex-row flex-wrap gap-s2">
        <Button kind="ghost" size="sm" icon="spark" label="AI accounts" onPress={() => { onClose(); router.push("/u/settings/ai" as never); }} />
        <Button kind="ghost" size="sm" icon="link" label="Connections" onPress={() => { onClose(); router.push("/u/connections" as never); }} />
      </View>
    </View>
  );
  const back = <View className="self-start"><Button kind="ghost" size="sm" icon="chevron-left" label="Back" onPress={() => { setErr(""); setStep({ kind: "start" }); }} /></View>;
  const folderPick = scope === "shared" && !member && folders.length > 1
    ? <Select label="Folder" value={folder || folders[0].id} options={folders.map((f) => [f.id, f.name] as [string, string])} onChange={setFolder} />
    : <Text size="caption" tone="label">{`It goes to ${where}.`}</Text>;
  const fail = problem || err ? <Banner tone="warn"><Text>{err || problem}</Text></Banner> : null;

  const start = (
    <View className="gap-s4">
      {top}
      <Card flush>
        <Row dense chevron lead={<IconTile name="file" />} title="Paste from .env" sub="Paste KEY=value lines, or drop an .env file. Vyre groups them into items." onPress={() => setStep({ kind: "paste" })} />
        <Row dense chevron lead={<IconTile name="plus" />} title="Blank item" sub="A name, and fields like GHL_API_KEY." onPress={() => { setDraft(blankDraft()); setStep({ kind: "form", how: "blank", template: null }); }} />
        <Row dense chevron lead={<IconTile name="search" />} title="Pick an app" sub="Its fields, named for you, with where to find each." onPress={() => setStep({ kind: "pick" })} />
      </Card>
      <Card flush>
        <Row dense chevron lead={<IconTile name="globe" />} title="Website login" sub="Address, username, password and a one-time code." onPress={() => { setDraft(loginDraft()); setStep({ kind: "form", how: "login", template: null }); }} />
        <Row dense chevron lead={<IconTile name="file" />} title="Secure note" sub="Private text." onPress={() => { setDraft(noteDraft()); setStep({ kind: "form", how: "note", template: null }); }} />
      </Card>
    </View>
  );

  const preview = (d: Draft) => (
    <Card key={d.id}>
      <View className="gap-s3">
        <Field label="Item name" value={d.name} onChangeText={(name) => setDrafts((xs) => xs.map((x) => (x.id === d.id ? { ...x, name } : x)))}
          help={slugOf(d.name) && slugOf(d.name) !== d.name.trim() ? `Kept as ${slugOf(d.name)}. Placeholders take either spelling.` : undefined} />
        {d.fields.map((f) => {
          const warn = valueWarning(f.value);
          return (
            <View key={f.id} className="gap-s1">
              <View className="flex-row items-center gap-s2">
                <View className="min-w-0 flex-1"><Text mono strong={f.on} tone={f.on ? undefined : "label"}>{liveName(f.key)}</Text>
                  <Text size="caption" tone="label">{f.secret ? `Secret, ${secretHint(f.value)}` : f.value}</Text></View>
                <Button kind="ghost" size="sm" label={f.on ? "Leave out" : "Put back"} onPress={() => setDrafts((xs) => setField(xs, f.id, { on: !f.on }))} />
                <Menu trigger={<Button kind="ghost" size="sm" label="Move" />} items={[...drafts.filter((x) => x.id !== d.id).map((x) => ({ label: `To ${x.name || "another item"}`, onPress: () => setDrafts((xs) => moveField(xs, f.id, x.id)) })), { label: "To a new item", onPress: () => setDrafts((xs) => moveField(xs, f.id, "new")) }]} />
              </View>
              <View className="flex-row flex-wrap items-center gap-s2">
                <Switch label={`${f.key} is plain`} on={!f.secret} onChange={(plain) => setDrafts((xs) => setField(xs, f.id, { secret: !plain }))} />
                <Text size="caption" tone="label">{f.secret ? "Secret" : "Plain"}</Text>
                {warn ? <><Text size="caption" tone="label">{warn}</Text><Button kind="ghost" size="sm" label="Remove it" onPress={() => setDrafts((xs) => setField(xs, f.id, { value: withoutEnds(f.value) }))} /></> : null}
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
  const savePaste = () => {
    const calls: Call[] = [];
    for (const d of drafts) {
      if (!d.fields.some((f) => f.on)) continue;
      const c = itemCall(d, { member });
      if ("error" in c) { setErr(`${d.name || "An item"}: ${c.error}`); return; }
      calls.push(c);
    }
    if (!calls.length) { setErr("Tick at least one field."); return; }
    go(calls, calls.length === 1 ? String(calls[0].input.name) : `${calls.length} items`);
  };
  const paste = (
    <View className="gap-s4">
      {back}
      {drafts.length ? (
        <>
          <Text>{`${drafts.length === 1 ? "One item" : `${drafts.length} items`}. Rename them, move a field, untick what you do not want, and mark ids and addresses plain.`}</Text>
          {drafts.map(preview)}
          {skipped.length ? <Text size="caption" tone="label">{`Not read: ${skipped.slice(0, 4).join("; ")}${skipped.length > 4 ? ` and ${skipped.length - 4} more` : ""}.`}</Text> : null}
          {folderPick}
          {fail}
          <View className="flex-row flex-wrap gap-s2"><Button kind="primary" label={busy ? "Saving" : "Save"} disabled={busy} onPress={savePaste} /><Button kind="ghost" label="Paste again" onPress={() => setDrafts([])} /></View>
        </>
      ) : (
        <>
          <Field label="Paste .env lines" value={text} onChangeText={setText} multiline lines={8} mono placeholder={"GHL_API_KEY=...\nGHL_LOCATION_ID=..."} autoFocus={!phone} />
          <DropZone label="Or drop an .env file" accept=".env,text/plain" onText={(t) => setText(t)} />
          {fail}
          <View className="self-start"><Button kind="primary" label="Preview" disabled={!text.trim()} onPress={() => { const r = pasteDrafts(text); setDrafts(r.drafts); setSkipped(r.skipped); setErr(r.drafts.length ? "" : "No KEY=value line was found."); }} /></View>
          <Text size="caption" tone="label">Values are kept exactly as you paste them. Nothing is saved until you press Save.</Text>
        </>
      )}
    </View>
  );

  const ask = () => {
    if (!suggest) { setDraft({ ...blankDraft(), name: q.trim() }); setStep({ kind: "form", how: "blank", template: null, note: suggestionNote("no_answer") }); return; }
    setAsking(true); setErr("");
    suggest(q.trim()).then((s) => { setDraft(suggestionDraft(s)); setStep({ kind: "form", how: "blank", template: null, note: s.fields.length ? (s.source === "space" ? "Fields this Space used before. Change them if you need to." : "Fields your AI account suggested from the app's name. Check them against the app.") : suggestionNote(s.why) }); })
      .catch((e) => { setDraft({ ...blankDraft(), name: q.trim() }); setStep({ kind: "form", how: "blank", template: null, note: String((e as Error)?.message || suggestionNote("no_answer")) }); })
      .finally(() => setAsking(false));
  };
  const exact = found.some((t) => t.label.toLowerCase() === q.trim().toLowerCase());
  const pick = (
    <View className="gap-s3">
      {back}
      <Field name="Search apps" value={q} onChangeText={setQ} placeholder="Type an app's name" autoFocus={!phone} onSubmit={q.trim() && !exact ? ask : undefined} />
      {q.trim() && !exact ? <Card flush><Row dense chevron lead={<IconTile name="spark" />} title={asking ? `Asking about ${q.trim()}` : `Fields for ${q.trim()}`} sub={member ? "Add its fields yourself." : "Your own AI account suggests them from the app's name only."} onPress={asking ? undefined : ask} /></Card> : null}
      {found.length ? <Card flush>{found.map((t) => <Row key={t.id} dense chevron lead={<IconTile name={ICON[t.source]} />} title={t.label} sub={t.line} onPress={() => openOn(t)} />)}</Card> : null}
    </View>
  );

  const step0 = step.kind === "form" ? step : null;
  const tpl = step0?.template ?? null;
  const saveForm = () => {
    if (!step0) return;
    const c = step0.how === "login" || step0.how === "note" ? kindCall(step0.how, draft, { member }) : saveCall(tpl, draft, { member });
    if ("error" in c) { setErr(c.error); return; }
    go([c], tpl?.source === "need" ? tpl.label : draft.name);
  };
  const form = step0 ? (
    <View className="gap-s4">
      {back}
      {tpl ? <Row dense lead={<IconTile name={ICON[tpl.source]} />} title={tpl.label} sub={tpl.line} /> : null}
      {step0.note ? <Text tone="label">{step0.note}</Text> : null}
      {tpl?.source === "need" && !tpl.need?.multiple ? null : <Field label={tpl?.need?.multiple ? "Account name" : "Item name"} value={draft.name} onChangeText={(name) => setDraft((d) => ({ ...d, name }))} placeholder={step0.how === "login" ? "Airline account" : "GHL Sales"} autoFocus={!phone}
        help={slugOf(draft.name) && slugOf(draft.name) !== draft.name.trim() ? `Kept as ${slugOf(draft.name)}. Placeholders take either spelling.` : undefined} />}
      <FieldsEditor fields={draft.fields} multiline={step0.how === "note"} onChange={(id, change) => setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...f, ...change } : f)) }))}
        canAdd={step0.how === "blank" || Boolean(tpl?.extra)} canRemove={step0.how === "blank"} onAdd={() => setDraft((d) => ({ ...d, fields: [...d.fields, newField()] }))} />
      {tpl?.help ? <View className="self-start"><Button kind="ghost" size="sm" icon="external" label="Where do I find these?" onPress={() => void openExternal(tpl.help!)} /></View> : null}
      {tpl?.source === "need" ? null : folderPick}
      {fail}
      <Button kind="primary" label={busy ? "Saving" : "Add"} disabled={busy} onPress={busy ? () => {} : saveForm} />
      <Text size="caption" tone="label">Agents and Flows use it by placeholder. Vyre fills in the value; the model never sees a secret.</Text>
    </View>
  ) : null;

  return step.kind === "paste" ? paste : step.kind === "pick" ? pick : form ?? start;
}
