import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Banner, Button, Card, Chip, EmptyState, Field, GroupedList, IconButton, ListHeader, LoadingState, Menu, Row, Segmented, Select, Sheet, Text, allowsMock, listRows, showToast, useRecordsWorld, useUiTheme } from "@vyre/ui";
import type { FilterChip } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useSidebar } from "../shell/sidebar";
import { tool } from "../../src/real/box";
import { FileViewerSheet } from "../drive/FileViewerSheet";
import { aliasesFor, whenWords } from "../records/documents-model.js";
import { MADE_GROUPS, madeSub, appState, asRecs, fillsFor, madeGroupOf, madeRows } from "./model.js";
import { signingLabel, useSigningTemplates } from "./useSigningTemplates";

type Tab = "made" | "waiting" | "templates" | "setup";
const say = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");
const SAMPLE_MADE = [
  { id: "d1", urn: "", created_at: Date.now() - 3600_000, data: { name: "Engagement letter, Doe family", status: "Draft", template: "Engagement letter", file: "Documents/doe-family/engagement-letter-3f9a1c2e.docx" } },
  { id: "d2", urn: "", created_at: Date.now() - 86400_000, data: { name: "Will, Marcus Doe", status: "Sent", template: "Will", file: "Documents/doe-family/will-81bb04aa.docx", submission: 41 } },
  { id: "d3", urn: "", created_at: Date.now() - 4 * 86400_000, data: { name: "Engagement letter, Ortiz", status: "Signed", template: "Engagement letter", file: "Documents/ortiz/engagement-letter-77c0d1e9.docx", submission: 38 } },
];

/**
 * Documents, one home: what was made (opens in the viewer, can go out for signature), what is waiting for a signature (with a reminder), the Word templates (add one, see what each asks for and which object field fills it,
 * make a document), and the setup of the signing app. A member sees what she may read and the templates; adding, sending, reminding and setup are the owner's and an admin's.
 */
export function DocumentsHome() {
  const router = useRouter();
  const { phone } = useUiTheme();
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();
  const admin = useSidebar((s) => s.canSetDefault) || allowsMock();
  const [tab, setTab] = useState<Tab>((["made", "waiting", "templates", "setup"].includes(String(tabParam)) ? tabParam : "made") as Tab);
  const { data: world, reload } = useRecordsWorld();
  const hasType = !!world?.types.some((t: any) => t.name === "document");
  const [templates, setTemplates] = useState<{ name: string; size?: number }[] | null>(null);
  const [asks, setAsks] = useState<Record<string, string[]>>({});
  const [waiting, setWaiting] = useState<any[] | null>(null);
  const { app, signing, reload: loadApp } = useSigningTemplates(admin);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<FilterChip[]>([]);
  const [busy, setBusy] = useState("");
  const [make, setMake] = useState<null | { template: string; type: string; record: string; format: "docx" | "pdf"; made: string; problem: string }>(null);
  const [send, setSend] = useState<null | { name: string; template: string; email: string; problem: string }>(null);

  const loadTemplates = useCallback(() => { tool<{ templates?: { name: string; size?: number }[] }>("documents.template.list").then((r) => setTemplates(r?.templates ?? [])).catch(() => setTemplates([])); }, []);
  const loadWaiting = useCallback(() => { if (!admin) return; tool<{ requests?: any[] }>("documents.signing.waiting").then((r) => setWaiting(r?.requests ?? [])).catch(() => setWaiting([])); }, [admin]);
  useEffect(() => { loadTemplates(); loadWaiting(); }, [loadTemplates, loadWaiting]);
  useEffect(() => { (templates ?? []).forEach((t) => { if (!asks[t.name]) tool<{ placeholders?: string[] }>("documents.template.get", { name: t.name }).then((r) => setAsks((a) => ({ ...a, [t.name]: r?.placeholders ?? [] }))).catch(() => {}); }); }, [templates]);

  const recs = useMemo(() => (hasType ? world?.byType.document ?? [] : allowsMock() ? SAMPLE_MADE : []), [world, hasType]);
  const rows = useMemo(() => madeRows(recs), [recs]);
  const def = useMemo(() => ({ name: "document", label: "Document", plural: "Documents", fields: [{ name: "name", label: "Name", kind: "text" }, { name: "status", label: "Status", kind: "choice", options: ["Draft", "Sent", "Signed"] }, { name: "template", label: "Template", kind: "text" }] }), []);
  const keep = new Set(listRows(def, asRecs(rows), chips, query, {}).map((r: any) => r.id));
  const shown = rows.filter((r) => keep.has(r.id)).map((r) => ({ ...r, group: madeGroupOf(r.status) }));
  const types = (world?.types ?? []).filter((t: any) => !t.internal).map((t: any) => ({ name: t.name, label: t.label, fields: t.fields }));

  const pickFile = () => {
    if (Platform.OS !== "web" || typeof document === "undefined") { showToast("Add a template from a computer."); return; }
    const i = document.createElement("input"); i.type = "file"; i.accept = ".docx";
    i.onchange = () => {
      const f = i.files?.[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const b64 = String(rd.result ?? "").split(",")[1] ?? "";
        const name = f.name.replace(/\.docx$/i, "");
        setBusy("add"); tool("documents.template.add", { name, base64: b64 }).then(() => { showToast(`${name} added.`); loadTemplates(); }).catch((e) => showToast(say(e))).finally(() => setBusy(""));
      };
      rd.readAsDataURL(f);
    };
    i.click();
  };
  const generate = () => {
    if (!make) return;
    const rec = (world?.byType[make.type] ?? []).find((r: any) => r.id === make.record);
    const def2 = types.find((t: any) => t.name === make.type);
    if (!rec || !def2) { setMake({ ...make, problem: "Pick the record it is made for." }); return; }
    setBusy("make");
    const related: { urn: string; type: string }[] = [];
    tool<{ path?: string }>("documents.generate", { template: make.template, records: aliasesFor(def2, rec, related), format: make.format, ...(make.type === "contact" ? { contact: rec.urn } : {}) })
      .then((r) => { setMake((m) => (m ? { ...m, made: String(r?.path ?? ""), problem: "" } : m)); reload(); }).catch((e) => setMake((m) => (m ? { ...m, problem: say(e) } : m))).finally(() => setBusy(""));
  };
  const doSend = () => {
    if (!send) return;
    const id = Number(send.template);
    if (!Number.isInteger(id)) { setSend({ ...send, problem: "Pick the signing template." }); return; }
    if (!send.email.includes("@")) { setSend({ ...send, problem: "Give the signer's e-mail address." }); return; }
    setBusy("send");
    tool("documents.send", { template_id: id, email: send.email.trim() }).then(() => { showToast("Sent for signature."); setSend(null); loadWaiting(); }).catch((e) => setSend((s) => (s ? { ...s, problem: say(e) } : s))).finally(() => setBusy(""));
  };
  const remind = (n: number) => tool("documents.signing.remind", { submission: n }).then(() => showToast("Reminder sent.")).catch((e) => showToast(say(e)));

  const tabs: [Tab, string][] = [["made", "Made"], ...(admin ? ([["waiting", "Waiting"]] as [Tab, string][]) : []), ["templates", "Word templates"], ...(admin ? ([["setup", "Setup"]] as [Tab, string][]) : [])];
  return (
    <Page title="Documents" top sub={undefined}>
      <Segmented<Tab> label="Documents" value={tab} onChange={setTab} options={tabs} />

      {tab === "made" ? (
        rows.length || hasType ? (
          <View className="gap-s3">
            <ListHeader title={null} noun="documents" shown={shown.length} total={rows.length} query={query} onQuery={setQuery} chips={chips} onChips={setChips} def={def} ctx={{}} />
            {shown.length ? (
              <GroupedList groups={MADE_GROUPS.map(([, t]) => ({ name: t }))} items={shown} itemNoun="documents" renderItems={(its) => (
                <Card flush>
                  {its.map((r, i) => (
                    <View key={r.id}>
                      {i ? <View className="h-px bg-edge" /> : null}
                      <Row dense title={r.name} sub={madeSub(r, whenWords(r.at, Date.now()))} onPress={() => r.file ? setOpen(r.file) : undefined}
                        end={<View className="flex-row items-center gap-s2">{r.status === "Sent" ? <Chip>Out for signature</Chip> : null}
                          <Menu trigger={<IconButton icon="more" label={`${r.name}, more`} />} items={[
                            ...(r.file ? [{ label: "Open", onPress: () => setOpen(r.file) }] : []),
                            ...(admin && r.status === "Draft" ? [{ label: "Send for signature", onPress: () => setSend({ name: r.name, template: "", email: "", problem: "" }) }] : []),
                          ]} /></View>} />
                    </View>
                  ))}
                </Card>
              )} />
            ) : <Card><EmptyState title="No documents match" body="Clear the search or a filter to see them all." action={{ label: "Clear", onPress: () => { setQuery(""); setChips([]); } }} /></Card>}
          </View>
        ) : <Card><EmptyState title="Nothing made yet" body={hasType ? "Make a document from a template, or from a record's page." : "Install the Documents Kit to keep a record of every document made. Documents are still filed in Files."} action={{ label: "Make a document", onPress: () => setTab("templates") }} /></Card>
      ) : null}

      {tab === "waiting" ? (
        waiting === null ? <LoadingState rows={3} /> : waiting.length ? (
          <Card flush>
            {waiting.map((w, i) => (
              <View key={w.submission}>{i ? <View className="h-px bg-edge" /> : null}
                <Row dense title={String(w.template ?? "Document")} sub={`${w.signer || w.email}, sent ${whenWords(w.at, Date.now()) || "recently"}`} end={<Button kind="secondary" size="sm" label="Remind" onPress={() => void remind(w.submission)} />} />
              </View>
            ))}
          </Card>
        ) : <Card><EmptyState title="Nothing is waiting" body="Documents sent for signature that nobody has signed yet show here." /></Card>
      ) : null}

      {tab === "templates" ? (
        <View className="gap-s3">
          {admin ? <View className="flex-row"><Button kind="primary" icon="upload" label="Add a Word template" loading={busy === "add"} onPress={pickFile} /></View> : null}
          {templates === null ? <LoadingState rows={3} /> : templates.length ? templates.map((t) => {
            const f = fillsFor(asks[t.name] ?? [], types);
            return (
              <Card key={t.name} title={t.name} className="gap-s2" actions={<Button kind="secondary" size="sm" icon="file" label="Make document" onPress={() => setMake({ template: t.name, type: "", record: "", format: "docx", made: "", problem: "" })} />}>
                {f.length ? f.map((x) => <View key={x.placeholder} className="flex-row items-center gap-s2"><Text size="caption" mono>{`{${x.placeholder}}`}</Text><Text size="caption" tone={x.from ? "muted" : "warn"}>{x.from ? `from ${x.from}` : "nothing here fills it yet"}</Text></View>) : <Text size="caption" tone="label">{asks[t.name] ? "It asks for no values." : "Reading what it asks for..."}</Text>}
              </Card>
            );
          }) : <Card><EmptyState title="No templates yet" body={admin ? "Add a Word file with {placeholders} such as {contact.name}. Documents are made from it." : "The owner or an admin adds the firm's Word templates."} /></Card>}
        </View>
      ) : null}

      {tab === "setup" ? (
        <View className="gap-s3">
          <Card className="gap-s2">
            <View className="flex-row items-center gap-s2"><Text strong>Signing</Text><Chip tone={app?.running ? "ok" : "plain"}>{app?.word ?? "Checking..."}</Chip></View>
            <Text tone="muted">Documents go out for signature through the Documents app on this server.</Text>
            {app && !app.installed ? <View className="flex-row"><Button kind="primary" label="Install the Documents app" loading={busy === "install"} onPress={() => { setBusy("install"); tool("appmods.install", { name: "documents" }).then(() => { showToast("Installing. This can take a few minutes."); loadApp(); }).catch((e) => showToast(say(e))).finally(() => setBusy("")); }} /></View> : null}
            {app && app.installed && !app.running ? <View className="flex-row"><Button kind="primary" label="Start it" loading={busy === "start"} onPress={() => { setBusy("start"); tool("appmods.start", { name: "documents" }).then(() => { showToast("Started."); loadApp(); }).catch((e) => showToast(say(e))).finally(() => setBusy("")); }} /></View> : null}
            {app?.running ? <Text size="caption" tone="label">{`${signing.length} signing ${signing.length === 1 ? "template" : "templates"} ready. Make them in the app's own screen.`}</Text> : null}
          </Card>
          <Card className="gap-s2">
            <Text strong>Signed copies</Text>
            <Text tone="muted">Links to signed copies last until you end them. This ends every link made so far; links made afterwards work.</Text>
            <View className="flex-row"><Button kind="secondary" label="End all signed-copy links" loading={busy === "revoke"} onPress={() => { setBusy("revoke"); tool("documents.signed-link.revoke").then(() => showToast("Every earlier link is ended.")).catch((e) => showToast(say(e))).finally(() => setBusy("")); }} /></View>
          </Card>
        </View>
      ) : null}

      <Sheet open={!!make} onClose={() => setMake(null)} title={make ? `Make ${make.template}` : ""}>
        {make ? (
          <View className="gap-s3">
            <Select label="Made for" value={make.type} options={[["", "Pick an object"], ...types.filter((t: any) => (world?.byType[t.name] ?? []).length).map((t: any) => [t.name, t.label] as [string, string])]} onChange={(type) => setMake({ ...make, type, record: "" })} />
            {make.type ? <Select label="Record" value={make.record} options={[["", "Pick one"], ...(world?.byType[make.type] ?? []).map((r: any) => [r.id, String(Object.values(r.data ?? {}).find((v) => typeof v === "string") ?? r.id)] as [string, string])]} onChange={(record) => setMake({ ...make, record })} /> : null}
            <Segmented<"docx" | "pdf"> label="Format" value={make.format} onChange={(format) => setMake({ ...make, format })} options={[["docx", "Word"], ["pdf", "PDF"]]} />
            {!make.record ? <Text size="caption" tone="label">Pick who it is for to make it.</Text> : null}
            {make.problem ? <Banner tone="warn">{make.problem}</Banner> : null}
            {make.made ? <Banner><Text strong>Made and filed</Text><Text size="caption" tone="muted">{make.made}</Text></Banner> : null}
            <View className="flex-row gap-s2"><Button kind="primary" label="Make it" loading={busy === "make"} disabled={!make.record} onPress={generate} />{make.made ? <Button kind="secondary" label="Open it" onPress={() => { setOpen(make.made); setMake(null); }} /> : null}<Button kind="ghost" label={make.made ? "Done" : "Cancel"} onPress={() => setMake(null)} /></View>
          </View>
        ) : null}
      </Sheet>

      <Sheet open={!!send} onClose={() => setSend(null)} title={send ? `Send ${send.name}` : ""}>
        {send ? (
          <View className="gap-s3">
            <Text tone="muted">It goes out for signature and the signer gets their link by e-mail. You approve the send.</Text>
            {signing.length ? <Select label="Signing template" value={send.template} options={[["", "Pick one"], ...signing.map((x) => [String(x.id), signingLabel(x)] as [string, string])]} onChange={(template) => setSend({ ...send, template })} /> : <Field label="Signing template number" kind="number" value={send.template} onChangeText={(template) => setSend({ ...send, template })} help="The Documents app is not answering, so the list is not there. Its number is in the app." />}
            <Field label="Signer's e-mail" kind="email" value={send.email} onChangeText={(email) => setSend({ ...send, email })} />
            {send.problem ? <Banner tone="warn">{send.problem}</Banner> : null}
            <View className="flex-row gap-s2"><Button kind="primary" label="Send" loading={busy === "send"} onPress={doSend} /><Button kind="ghost" label="Cancel" onPress={() => setSend(null)} /></View>
          </View>
        ) : null}
      </Sheet>
      <FileViewerSheet path={open} onClose={() => setOpen(null)} />
    </Page>
  );
}
