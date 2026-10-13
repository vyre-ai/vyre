import { useState } from "react";
import { View } from "react-native";
import { ActivityFeed, Banner, ImportWizard, RecordForm, RecordHeader, RelatedSection, SectionLabel, formErrors, guessMapping, importIssues, useUiTheme } from "@vyre/ui";
import type { Activity, DupeRule } from "@vyre/ui";
import { ASSET_FIELDS } from "./data";

const ENV = { links: { "vyre://j/contact/1": { title: "Jane Doe", type: "contact" }, "vyre://j/contact/2": { title: "Marcus Doe", type: "contact" } } };

/** Create an Asset: the form is drawn from the type's six fields. Real state: required first, errors after a try, Create and add another resets. */
export function RecordFormDemo({ tried: t0 = false, values: v0 = {} }: { tried?: boolean; values?: Record<string, any> }) {
  const [values, setValues] = useState<Record<string, any>>(v0);
  const [tried, setTried] = useState(t0);
  const errors = tried ? formErrors(ASSET_FIELDS as any, values) : {};
  return (
    <View className="gap-s3">
      <SectionLabel first>New asset</SectionLabel>
      {tried && Object.keys(errors).length ? <Banner tone="warn">{`${Object.keys(errors).length} fields need a value.`}</Banner> : null}
      <RecordForm fields={ASSET_FIELDS} values={values} onChange={(n, v) => setValues({ ...values, [n]: v })} errors={errors} env={ENV} noun="asset"
        onCreate={() => setTried(true)} onCreateMore={() => { setTried(true); if (!Object.keys(formErrors(ASSET_FIELDS as any, values)).length) { setValues({}); setTried(false); } }} onCancel={() => {}} />
    </View>
  );
}

const ITEMS: Activity[] = [
  { id: "1", kind: "email", at: 6, when: "2 hours ago", actor: "Jane Doe", what: "replied: \"The deed is attached.\"" },
  { id: "2", kind: "note", at: 5, when: "Yesterday", actor: "Alex Rivera", what: "left a note", why: "Wants the trust signed before the 30th. Call after 3pm." },
  { id: "3", kind: "call", at: 4, when: "Mon", actor: "Priya Shah", what: "called, 12 minutes", why: "Confirmed the two accounts to retitle." },
  { id: "4", kind: "change", at: 3, when: "Mon", actor: "Alex Rivera", what: "changed Plan from Will to Trust" },
  { id: "5", kind: "change", at: 2, when: "Last week", actor: "Your assistant", what: "filled in Household size", why: "From the intake form." },
];

/** A record page as a person needs it: who it is and what to do, the records linked to it by type, one timeline with a note box. */
export function RecordPageDemo() {
  const { phone } = useUiTheme();
  const [items, setItems] = useState(ITEMS);
  const left = (
    <View className="min-w-0 flex-[2] gap-s4">
      <ActivityFeed items={items} onNote={(t) => setItems([{ id: String(items.length + 1), kind: "note", at: items.length + 10, when: "Just now", actor: "You", what: "left a note", why: t }, ...items])} />
    </View>
  );
  const right = (
    <View className="min-w-0 flex-1 gap-s4">
      <RelatedSection title="Assets" noun="an asset" rows={[{ id: "a1", title: "Family home", sub: "Real estate, $640,000", chip: "Trust" }, { id: "a2", title: "Joint savings", sub: "Bank account", chip: "Joint" }, { id: "a3", title: "Term life policy", sub: "Life insurance, $500,000" }]} onOpen={() => {}} onAdd={() => {}} />
      <RelatedSection title="Projects" noun="a project" rows={[{ id: "p1", title: "Doe family trust", sub: "Drafting" }]} onOpen={() => {}} onAdd={() => {}} />
      <RelatedSection title="Beneficiaries" noun="a beneficiary" rows={[]} onOpen={() => {}} onAdd={() => {}} />
    </View>
  );
  return (
    <View className="gap-s4">
      <RecordHeader face={{ kind: "person", id: "jane", name: "Jane Doe" }} title="Jane Doe" kind="Client" facts={[["Stage", "Drafting"], ["Owner", "Alex Rivera"], ["Next step", "Signing, Oct 28"]]}
        actions={[{ label: "Email", icon: "mail", primary: true, onPress: () => {} }, { label: "Call", icon: "phone", onPress: () => {} }, { label: "New project", icon: "plus", onPress: () => {} }, { label: "Add a note", icon: "edit", onPress: () => {} }]} />
      <View className={phone ? "gap-s4" : "flex-row items-start gap-s4"}>{left}{right}</View>
    </View>
  );
}

const HEADERS = ["Name", "Kind", "Estimated value", "Held in", "Account no."];
const ROWS = [
  { Name: "Family home", Kind: "Real estate", "Estimated value": "640000", "Held in": "Trust", "Account no.": "" },
  { Name: "Joint savings", Kind: "Bank account", "Estimated value": "$82,000", "Held in": "Joint", "Account no.": "9921" },
  { Name: "", Kind: "Vehicle", "Estimated value": "18000", "Held in": "Individual", "Account no.": "" },
  { Name: "Family home", Kind: "Real estate", "Estimated value": "640000", "Held in": "Trust", "Account no.": "" },
  { Name: "Term life policy", Kind: "Life insurance", "Estimated value": "about 500k", "Held in": "Individual", "Account no.": "5530" },
  { Name: "Retirement account", Kind: "Retirement account", "Estimated value": "310000", "Held in": "Individual", "Account no.": "7710" },
];
const IMPORT_FIELDS = ASSET_FIELDS.map((f) => (f.name === "title" || f.name === "name" ? { ...f, unique: true } : f));

/** Import assets from a CSV, driven by real mapping and checks on sample rows. `start` opens it at a step. */
export function ImportDemo({ start = 0 }: { start?: number }) {
  const [step, setStep] = useState(start);
  const [mapping, setMapping] = useState<Record<string, string>>(guessMapping(HEADERS, IMPORT_FIELDS));
  const [dupe, setDupe] = useState<DupeRule>("skip");
  const issues = importIssues(ROWS, mapping, IMPORT_FIELDS as any);
  return (
    <ImportWizard step={step} noun="assets" source="" fileName={step ? "assets-2026.csv" : ""} headers={HEADERS} sample={ROWS[0]} mapping={mapping} onMap={(h, f) => setMapping({ ...mapping, [h]: f })} fields={ASSET_FIELDS}
      issues={issues} total={ROWS.length} dupe={dupe} onDupe={setDupe} result={{ created: 4, updated: 0, skipped: 1, flagged: 1 }} onNext={() => setStep(Math.min(3, step + 1))} onBack={() => setStep(Math.max(0, step - 1))} />
  );
}
