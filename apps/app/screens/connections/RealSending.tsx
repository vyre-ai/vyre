// "Sending service": the firm's own account at Resend, Mailgun, Postmark, SendGrid or an SMTP server, which Flows send their email through. The key is typed here once, goes to the vault
// and is never shown back. An owner or an admin adds, tests and removes it; a test sends one email to the address typed here and asks for the person's presence first.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, ErrorState, Field, LoadingState, Row, Segmented, Text, showToast } from "@vyre/ui";
import { connections } from "./source-real";
import { words } from "./model";

const SERVICES: [string, string][] = [["resend", "Resend"], ["mailgun", "Mailgun"], ["postmark", "Postmark"], ["sendgrid", "SendGrid"], ["smtp", "SMTP"]];
type Form = { service: string; api_key: string; from: string; domain: string; region: string; smtp_host: string; smtp_port: string; username: string; security: string };
const BLANK: Form = { service: "resend", api_key: "", from: "", domain: "", region: "", smtp_host: "", smtp_port: "", username: "", security: "starttls" };

export default function RealSending() {
  const [now, setNow] = useState<Awaited<ReturnType<typeof connections.sending>> | null>(null);
  const [problem, setProblem] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(() => { connections.sending().then((s) => { setNow(s); setProblem(""); }).catch((e) => setProblem(words(e))); }, []);
  useEffect(load, [load]);

  const save = () => {
    if (!form) return;
    const f = form;
    if (!f.api_key.trim()) { setError(f.service === "smtp" ? "Type the SMTP password." : "Paste the API key."); return; }
    if (!f.from.trim()) { setError("Type the address the email comes from, such as Harlow Law <hello@harlow.example>."); return; }
    if (f.service === "mailgun" && !f.domain.trim()) { setError("Mailgun needs the sending domain."); return; }
    if (f.service === "smtp" && !f.smtp_host.trim()) { setError("Type the SMTP server."); return; }
    const fields = Object.fromEntries(Object.entries(f).filter(([k, v]) => v.trim() && (f.service === "smtp" || !["smtp_host", "smtp_port", "username", "security"].includes(k)) && (f.service === "mailgun" || k !== "region")).map(([k, v]) => [k, v.trim()]));
    setBusy(true); setError("");
    connections.saveSending(fields).then(() => { setForm(null); setBusy(false); setNotice("The sending service is saved. Send yourself a test to check it."); load(); })
      .catch((e) => { setBusy(false); setError(words(e, [f.api_key])); });
    setForm({ ...f, api_key: "" });
  };
  const test = () => {
    if (!testTo.trim()) { setError("Type your own email address to send the test to."); return; }
    setBusy(true); setError("");
    connections.testSending(testTo.trim()).then((r) => { setBusy(false); setNotice(`A test email is on its way to ${r.to} through ${r.label}.`); }).catch((e) => { setBusy(false); setError(words(e)); });
  };

  if (problem && !now) return <ErrorState title="The sending service could not be read" reason={problem} retry={load} />;
  if (!now) return <LoadingState rows={2} />;
  const set = (p: Partial<Form>) => form && setForm({ ...form, ...p });
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">Your own account at an email service. Flows send their email through it, from your address. Every send still waits for a person's yes. Vyre's servers send no email.</Text>
      {notice ? <Banner><Text>{notice}</Text></Banner> : null}
      <Card flush>
        <Row title={now.configured ? now.label : "No sending service yet"}
          sub={<View className="gap-s1 pt-s1">
            {now.configured ? <Text size="secondary">{`Sends from ${now.from}`}</Text> : <Text size="secondary" tone="muted">Add one so a Flow can send email. Only an owner or an admin can.</Text>}
            {now.configured ? (
              <View className="gap-s2 pt-s2">
                <Field label="Send a test to" value={testTo} onChangeText={setTestTo} placeholder="you@yourfirm.com" />
                {error && !form ? <Text tone="muted" size="secondary">{error}</Text> : null}
                <View className="flex-row gap-s2">
                  <Button kind="primary" size="sm" label={busy ? "Sending" : "Send a test"} disabled={busy} onPress={test} />
                  <Button kind="ghost" size="sm" label="Replace" onPress={() => { setForm({ ...BLANK }); setError(""); setNotice(""); }} />
                  <Button kind="holdText" size="sm" label="Remove" onPress={() => connections.removeSending().then(() => { showToast("The sending service is removed."); setNotice(""); load(); }).catch((e) => showToast(words(e)))} />
                </View>
              </View>
            ) : null}
            {form ? (
              <View className="gap-s2 pt-s2">
                <Segmented label="Service" value={form.service} onChange={(service) => set({ service })} options={SERVICES} />
                <Field label={form.service === "smtp" ? "SMTP password" : "API key"} kind="password" value={form.api_key} onChangeText={(api_key) => set({ api_key })} />
                <Field label="From address" value={form.from} onChangeText={(from) => set({ from })} placeholder="Harlow Law <hello@harlow.example>" />
                {form.service === "mailgun" ? <Field label="Sending domain" value={form.domain} onChangeText={(domain) => set({ domain })} placeholder="mg.harlow.example" /> : null}
                {form.service === "mailgun" ? <Field label="Region (us or eu, optional)" value={form.region} onChangeText={(region) => set({ region })} /> : null}
                {form.service === "smtp" ? <Field label="SMTP server" value={form.smtp_host} onChangeText={(smtp_host) => set({ smtp_host })} placeholder="smtp.harlow.example" /> : null}
                {form.service === "smtp" ? <Field label="SMTP port (optional)" value={form.smtp_port} onChangeText={(smtp_port) => set({ smtp_port })} /> : null}
                {form.service === "smtp" ? <Field label="SMTP username (optional)" value={form.username} onChangeText={(username) => set({ username })} /> : null}
                {form.service === "smtp" ? <Segmented label="Security" value={form.security} onChange={(security) => set({ security })} options={[["starttls", "STARTTLS"], ["tls", "TLS"]]} /> : null}
                {error ? <Text tone="muted" size="secondary">{error}</Text> : null}
                <View className="flex-row gap-s2">
                  <Button kind="primary" size="sm" label={busy ? "Saving" : "Save"} disabled={busy} onPress={save} />
                  <Button kind="ghost" size="sm" label="Cancel" onPress={() => { setForm(null); setError(""); }} />
                </View>
              </View>
            ) : null}
          </View>}
          end={form || now.configured ? null : <Button kind="primary" size="sm" label="Add a sending service" onPress={() => { setForm({ ...BLANK }); setNotice(""); }} />} />
      </Card>
    </View>
  );
}
