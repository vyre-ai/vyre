// The Vault's Add sheet. Step one asks "What are you adding?": a searchable picker, grouped as the list and the sidebar are, every row from the providers catalog (add-model.js). Step two is that
// pick's own form: its labelled fields, a drop zone for a key file, or a Sign in button, with "Where do I get this?" from the catalog. Save is the vault.put the model builds; nothing here keeps a value after it.
import { useEffect, useMemo, useState } from "react";
import { Linking, View } from "react-native";
import { Banner, Button, Card, Field, GroupedList, IconButton, IconTile, Row, Segmented, Sheet, Text, type IconName } from "@vyre/ui";
import { usePhone } from "../places/Page";
import { DropZone } from "./DropZone";
import { IMPORT_ENTRY, callOf, entriesFor, formOf, pickerGroups, problemsOf, searchEntries, slugOf, startName, type Entry, type Form, type FormField } from "./add-model.js";
import { checkServiceAccount } from "../../../../core/vault/providers.js";

export type Call = { tool: string; input: Record<string, unknown> };
type Scope = "space" | "mine";

/** A secret is masked as it is typed, with an eye to look at it. */
function SecretInput({ field, value, error, onChange }: { field: FormField; value: string; error?: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <View className="flex-row items-end gap-s2">
      <View className="min-w-0 flex-1"><Field label={field.label} kind={shown ? "text" : "password"} mono={shown} value={value} error={error} onChangeText={onChange} /></View>
      <IconButton icon={shown ? "eye-off" : "eye"} label={shown ? `Hide ${field.label}` : `Show ${field.label}`} onPress={() => setShown(!shown)} />
    </View>
  );
}

export function AddSheet({ open, scope, busy, problem, onClose, onSave, onImport, onSignIn }: {
  open: boolean; scope: Scope; busy: boolean; /** What the box said to the last Save. */ problem: string; onClose: () => void;
  onSave: (call: Call, name: string) => void; onImport: () => void; onSignIn: (form: Form) => void;
}) {
  const phone = usePhone();
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Entry | null>(null);
  const [name, setName] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [file, setFile] = useState<{ text: string; name: string; email: string } | null>(null);
  const [fileErr, setFileErr] = useState("");
  const [mode, setMode] = useState<"make" | "existing">("make");
  const [more, setMore] = useState({ description: "", sshFile: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  useEffect(() => { if (open) { setQ(""); setPick(null); } }, [open]);

  const entries = useMemo(() => entriesFor(scope), [scope]);
  const found = useMemo(() => searchEntries(entries, q), [entries, q]);
  const form = pick ? formOf(pick.id) : null;

  const choose = (e: Entry) => {
    if (e.id === IMPORT_ENTRY.id) { onClose(); onImport(); return; }
    setPick(e); setName(startName(e)); setVals({}); setFile(null); setFileErr(""); setMode("make"); setMore({ description: "", sshFile: "" }); setErrs({});
  };
  const set = (k: string, v: string) => { setVals((x) => ({ ...x, [k]: v })); setErrs((x) => ({ ...x, [k]: "" })); };
  const slug = slugOf(name);

  const save = () => {
    if (!form) return;
    const bad = form.how === "ssh" ? {} : problemsOf(form, name, vals, file?.text ?? "");
    if (Object.keys(bad).length) { setErrs(bad); return; }
    const call = callOf(form, name, vals, { scope, file: file?.text, sshMode: mode, sshFile: more.sshFile, description: more.description });
    if (!call) return;
    if ("error" in call) { setErrs(form.how === "ssh" ? { [mode === "existing" && /key file/.test(call.error) ? "sshFile" : "name"]: call.error } : { name: call.error }); return; }
    onSave(call, name.trim());
  };

  const title = scope === "mine" ? "Add to your vault" : "Add to the Space vault";

  const groups = pickerGroups(found);
  const pickerBody = (
        <View className="gap-s3">
          <Text size="title" strong accessibilityRole="header">What are you adding?</Text>
          <Field name="Search what to add" value={q} onChangeText={setQ} placeholder="Search, for example Twilio or password" autoFocus={!phone} />
          {found.length ? (
            <GroupedList groups={groups.map((g) => ({ name: g.name }))} items={groups.flatMap((g) => g.items)} itemNoun="choices"
              renderItems={(xs) => (
                <Card flush>
                  {(xs as Entry[]).map((e) => <Row key={e.id} dense chevron lead={<IconTile name={e.icon as IconName} />} title={e.label} sub={e.blurb} onPress={() => choose(e)} />)}
                </Card>
              )} />
          ) : <Text tone="muted">Nothing matches that. Try "Any API key" for a service that is not listed.</Text>}
        </View>
  );

  const formBody = !pick || !form ? null : (
      <View className="gap-s3">
        <View className="self-start"><Button kind="ghost" size="sm" icon="chevron-left" label="What are you adding?" onPress={() => setPick(null)} /></View>
        <Row dense lead={<IconTile name={pick.icon as IconName} />} title={form.title} sub={pick.blurb} />
        <Field label="Name" error={errs.name} value={name} onChangeText={(v) => { setName(v); setErrs((x) => ({ ...x, name: "" })); }} help={slug && slug !== name.trim() ? `Saved as ${slug}.` : "Letters, digits, dot, dash and underscore."} />
        {form.how === "oauth" ? (
          <View className="gap-s2">
            <Button kind="primary" label={`Sign in with ${form.signIn}`} onPress={() => onSignIn(form)} />
            <Text size="caption" tone="label">This opens Connections, where Vyre runs the sign-in and keeps the result in the vault.</Text>
          </View>
        ) : form.how === "ssh" ? (
          <View className="gap-s3">
            <Segmented label="How" value={mode} onChange={setMode} options={[["make", "Make a new key"], ["existing", "Use a key file"]]} />
            {mode === "make"
              ? <><Text tone="muted">Made on your server. The private half never leaves it. You get the public half to paste into GitHub or another server.</Text>
                <Field label="Description (optional)" value={more.description} onChangeText={(description) => setMore({ ...more, description })} /></>
              : <Field label="Where the key file is on your server" error={errs.sshFile} value={more.sshFile} onChangeText={(sshFile) => { setMore({ ...more, sshFile }); setErrs({}); }} placeholder="/home/you/.ssh/id_ed25519" mono help="Your server reads the file itself. The key does not pass through this page." />}
          </View>
        ) : (
          <>
            {form.file ? (
              <DropZone label={form.file.label} accept=".json,application/json" error={errs[form.file.name] || fileErr}
                done={file ? `${file.email} (${file.name})` : undefined}
                onText={(text, fname) => {
                  setErrs((x) => ({ ...x, [form.file!.name]: "" }));
                  try { setFile({ text, name: fname, email: checkServiceAccount(text).email }); setFileErr(""); } catch (e) { setFile(null); setFileErr(e instanceof Error ? e.message : "That file is not a service-account key."); }
                }} />
            ) : null}
            {form.fields.map((f) => f.secret && !f.multiline
              ? <SecretInput key={f.name} field={f} value={vals[f.name] ?? ""} error={errs[f.name]} onChange={(v) => set(f.name, v)} />
              : <Field key={f.name} label={f.label} error={errs[f.name]} value={vals[f.name] ?? ""} onChangeText={(v) => set(f.name, v)} multiline={f.multiline} lines={f.multiline ? 5 : undefined} placeholder={f.hint}
                  kind={f.name === "url" ? "url" : "text"} />)}
          </>
        )}
        {form.help ? <View className="self-start"><Button kind="ghost" size="sm" icon="external" label="Where do I get this?" onPress={() => void Linking.openURL(form.help!)} /></View> : null}
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        {form.how === "oauth" ? null : <Button kind="primary" label={busy ? "Saving" : form.how === "ssh" && mode === "make" ? "Make the key" : "Add"} disabled={busy} onPress={busy ? () => {} : save} />}
        <Text size="caption" tone="label">Agents use it and never see the value.</Text>
      </View>
  );

  return <Sheet open={open} onClose={onClose} title={title}>{formBody ?? pickerBody}</Sheet>;
}
