import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Field, Row, Segmented, Select, Sheet, Text, showToast } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { signingLabel, useSigningTemplates } from "../documents/useSigningTemplates";
import { aliasesFor, unfilled, waitingFor, whenWords } from "./documents-model.js";

const say = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");

/**
 * The Documents bar of a record page: Make document (a Word template from the Drive, filled from this record and the ones linked to it), Send for signature (when the Documents app is here and the
 * record has an address), and what is still waiting for this person's signature, with a reminder. Each is the tool the Flow steps already call; nothing is shown that the box cannot do.
 */
export function DocumentsBar({ def, rec, related, email, canSend }: { def: any; rec: any; related: { urn: string; type: string }[]; email: string; canSend: boolean }) {
  const router = useRouter();
  const [templates, setTemplates] = useState<string[]>([]);
  const [waiting, setWaiting] = useState<any[]>([]);
  const [make, setMake] = useState<null | { name: string; asks: string[]; format: "docx" | "pdf"; busy: boolean; problem: string; made: string }>(null);
  const [send, setSend] = useState<null | { id: string; signer: string; note: string; busy: boolean; problem: string }>(null);
  const aliases = useMemo(() => aliasesFor(def, rec, related), [def, rec, related]);
  useEffect(() => { let live = true; tool<{ templates?: { name: string }[] }>("documents.template.list").then((r) => { if (live) setTemplates((r?.templates ?? []).map((t) => t.name)); }).catch(() => { if (live) setTemplates([]); }); return () => { live = false; }; }, []);
  const { signing } = useSigningTemplates(canSend);
  const loadWaiting = useCallback(() => {
    if (!email) { setWaiting([]); return; }
    tool<{ requests?: any[] }>("documents.signing.waiting").then((r) => setWaiting(waitingFor(r?.requests, email))).catch(() => setWaiting([]));
  }, [email]);
  useEffect(loadWaiting, [loadWaiting]);
  if (!templates.length && !(canSend && email) && !waiting.length) return null;

  const pick = (name: string) => {
    setMake({ name, asks: [], format: "docx", busy: false, problem: "", made: "" });
    tool<{ placeholders?: string[] }>("documents.template.get", { name }).then((r) => setMake((m) => (m && m.name === name ? { ...m, asks: unfilled(r?.placeholders ?? [], Object.keys(aliases)) } : m))).catch(() => {});
  };
  const generate = () => {
    if (!make) return;
    setMake({ ...make, busy: true, problem: "", made: "" });
    tool<{ path?: string }>("documents.generate", { template: make.name, records: aliases, format: make.format, ...(def.name === "contact" ? { contact: rec.urn } : {}) })
      .then((r) => setMake((m) => (m ? { ...m, busy: false, made: String(r?.path ?? "") } : m)))
      .catch((e) => setMake((m) => (m ? { ...m, busy: false, problem: say(e) } : m)));
  };
  const sendIt = () => {
    if (!send) return;
    const id = Number(send.id);
    if (!Number.isInteger(id) || id < 1) { setSend({ ...send, problem: "Pick a signing template." }); return; }
    setSend({ ...send, busy: true, problem: "" });
    tool("documents.send", { template_id: id, ...(def.name === "contact" ? { contact: rec.urn } : { email }), ...(send.signer.trim() ? { signer: send.signer.trim() } : {}), ...(send.note.trim() ? { note: send.note.trim() } : {}) })
      .then(() => { showToast("Sent for signature."); setSend(null); loadWaiting(); })
      .catch((e) => setSend((s) => (s ? { ...s, busy: false, problem: say(e) } : s)));
  };
  const remind = (submission: number) => { tool("documents.signing.remind", { submission }).then(() => showToast("Reminder sent.")).catch((e) => showToast(say(e))); };

  return (
    <View className="gap-s2">
      <View className="flex-row flex-wrap items-center gap-s2">
        {templates.length ? <Button kind="secondary" size="sm" icon="file" label="Make document" onPress={() => setMake({ name: "", asks: [], format: "docx", busy: false, problem: "", made: "" })} /> : null}
        {canSend && email ? <Button kind="secondary" size="sm" icon="send" label="Send for signature" onPress={() => setSend({ id: "", signer: "", note: "", busy: false, problem: "" })} /> : null}
      </View>
      {waiting.length ? (
        <Card flush title="Waiting for signature">
          {waiting.map((r) => (
            <Row key={r.submission} dense title={String(r.template ?? "Document")} sub={`Sent ${whenWords(r.at, Date.now()) || "recently"} to ${r.signer || r.email}`} end={<Button kind="ghost" size="sm" label="Remind" onPress={() => remind(r.submission)} />} />
          ))}
        </Card>
      ) : null}

      <Sheet open={!!make} onClose={() => setMake(null)} title="Make a document">
        {make ? (
          <View className="gap-s3">
            <Text tone="muted">{`It is filled from ${def.label.toLowerCase()} ${rec.id ? "and the records linked to it" : ""}, and filed in Files.`}</Text>
            <View className="flex-row flex-wrap gap-s2">{templates.map((t) => <Chip key={t} selected={make.name === t} onPress={() => pick(t)}>{t}</Chip>)}</View>
            {make.name && make.asks.length ? <Banner tone="warn"><Text strong>This template also asks for</Text><Text size="caption" tone="muted">{make.asks.join(", ")}. Nothing here gives them; the box will say what is missing.</Text></Banner> : null}
            <Segmented<"docx" | "pdf"> label="Format" value={make.format} onChange={(format) => setMake({ ...make, format })} options={[["docx", "Word"], ["pdf", "PDF"]]} />
            {make.problem ? <Banner tone="warn">{make.problem}</Banner> : null}
            {make.made ? <Banner><Text strong>Made and filed</Text><Text size="caption" tone="muted">{make.made}</Text></Banner> : null}
            <View className="flex-row gap-s2"><Button kind="primary" label="Make it" loading={make.busy} disabled={!make.name || make.busy} onPress={generate} /><Button kind="ghost" label={make.made ? "Done" : "Cancel"} onPress={() => setMake(null)} /></View>
          </View>
        ) : null}
      </Sheet>

      <Sheet open={!!send} onClose={() => setSend(null)} title="Send for signature">
        {send ? (
          <View className="gap-s3">
            <Text tone="muted">{`The signing link goes to ${email}. You approve the send.`}</Text>
            {signing.length ? <Select label="Signing template" value={send.id} options={[["", "Pick one"], ...signing.map((x) => [String(x.id), signingLabel(x)] as [string, string])]} onChange={(id) => setSend({ ...send, id })} /> : (
              <Banner><Text strong>No signing templates yet</Text><Text size="caption" tone="muted">Make one in the Documents app, then it shows here.</Text><View className="flex-row"><Button kind="secondary" size="sm" label="Open Documents" onPress={() => { setSend(null); router.push("/u/documents" as never); }} /></View></Banner>
            )}
            <Field label="Signer's name (optional)" value={send.signer} onChangeText={(signer) => setSend({ ...send, signer })} />
            <Field label="Note (optional)" value={send.note} onChangeText={(note) => setSend({ ...send, note })} multiline lines={2} />
            {send.problem ? <Banner tone="warn">{send.problem}</Banner> : null}
            <View className="flex-row gap-s2"><Button kind="primary" label="Send" loading={send.busy} disabled={send.busy || !signing.length || !send.id} onPress={sendIt} /><Button kind="ghost" label="Cancel" onPress={() => setSend(null)} /></View>
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
