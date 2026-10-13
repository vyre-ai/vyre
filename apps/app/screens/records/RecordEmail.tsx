// A record's Email: a compose sheet (to filled from the record, From picked from the credentials a Flow can send with), and the contact's mail below it, each opening read-only. A send is held at the
// Gate for the person's yes (comms.email or mail.send); nothing leaves from here. Search and read are mail.search and mail.read.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, Field, Row, Sheet, Text, showToast } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { MEMBER_LINE, checkDraft, fromChoices, heldWords, mergeThreads, refusedForMember, sendCall, threadQueries } from "./record-email.js";

type Msg = { id: string; account?: string; from?: string; to?: string; subject?: string; date?: string; snippet?: string };
const say = (e: unknown) => String((e as { message?: string })?.message || "That did not go through.");

export function RecordEmail({ email, name }: { email: string; name: string }) {
  const [compose, setCompose] = useState(false);
  const [from, setFrom] = useState<ReturnType<typeof fromChoices>>([]);
  const [pick, setPick] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [threads, setThreads] = useState<Msg[] | null>(null);
  const [member, setMember] = useState(false);
  const [reading, setReading] = useState<{ msg: Msg; text: string | null; error: string } | null>(null);

  // The owner's door decides: a member is refused here, and then she sees one line and no error. Anything else that goes wrong shows as "no mail yet", never as an error.
  const load = useCallback(() => {
    tool<{ credentials?: unknown[] }>("comms.credentials", { kind: "email" }).then((r) => {
      const c = fromChoices(r.credentials); setFrom(c); setPick((p) => p || c[0]?.id || "");
      return Promise.all(threadQueries(email).map((q) => tool<{ messages?: Msg[] }>("mail.search", { q, limit: 10 }).then((x) => x.messages ?? []).catch((e) => { if (refusedForMember(e)) throw e; return [] as Msg[]; })))
        .then((lists) => setThreads(mergeThreads(lists) as Msg[]));
    }).catch((e) => { if (refusedForMember(e)) setMember(true); setThreads([]); });
  }, [email]);
  useEffect(load, [load]);

  const open = () => { setCompose(true); setError(""); };
  const send = () => {
    const choice = from.find((c) => c.id === pick);
    if (!choice) { setError("Choose what to send from. Connect a sending service or a mail login in Settings, Connections."); return; }
    const bad = checkDraft({ to: email, subject, body });
    if (bad) { setError(bad); return; }
    const call = sendCall(choice, { to: email, subject, body });
    setBusy(true); setError("");
    tool(call.tool, call.input).then((r) => { setBusy(false); setCompose(false); setSubject(""); setBody(""); showToast(heldWords(r)); }).catch((e) => { setBusy(false); setError(say(e)); });
  };
  const read = (msg: Msg) => {
    setReading({ msg, text: null, error: "" });
    tool<{ body?: string }>("mail.read", { id: msg.id, ...(msg.account ? { account: msg.account } : {}) })
      .then((r) => setReading({ msg, text: String(r.body ?? ""), error: "" })).catch((e) => setReading({ msg, text: null, error: say(e) }));
  };

  if (member) return <Text tone="muted" size="secondary">{MEMBER_LINE}</Text>;
  return (
    <View className="gap-s2">
      <View className="flex-row"><Button kind="secondary" size="sm" label="Email" onPress={open} /></View>
      <Text strong size="secondary">{`Email with ${name}`}</Text>
      {threads === null ? <Text tone="muted" size="secondary">Looking for mail.</Text>
        : threads.length ? (
          <Card flush>{threads.map((m, i) => (
            <View key={`${m.account}:${m.id}`}>{i ? <Divider /> : null}
              <Row title={m.subject || "(no subject)"} sub={<Text size="secondary" tone="muted">{[m.from, m.date?.slice(0, 10)].filter(Boolean).join(" · ")}</Text>} end={<Button kind="ghost" size="sm" label="Read" onPress={() => read(m)} />} />
            </View>))}
          </Card>)
        : <Text tone="muted" size="secondary">No mail with this contact yet.</Text>}

      <Sheet open={compose} onClose={() => setCompose(false)} title={`Email ${name}`}>
        <View className="gap-s3 p-s4">
          <Field label="To" value={email} onChangeText={() => {}} />
          <Text size="caption" strong tone="label">From</Text>
          {from.length ? <View className="gap-s1">{from.map((c) => <Button key={c.id} kind={pick === c.id ? "primary" : "ghost"} size="sm" label={c.label} onPress={() => setPick(c.id)} />)}</View>
            : <Text tone="muted" size="secondary">No sending service or mail login is connected. Add one in Settings, Connections.</Text>}
          <Field label="Subject" value={subject} onChangeText={setSubject} />
          <Field label="Message" value={body} onChangeText={setBody} multiline />
          <Banner><Text size="secondary">Sending asks for your yes first. You read the final words in Approvals.</Text></Banner>
          {error ? <Text tone="muted" size="secondary">{error}</Text> : null}
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={busy ? "Holding" : "Send for approval"} disabled={busy} onPress={send} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setCompose(false)} /></View>
        </View>
      </Sheet>

      <Sheet open={reading !== null} onClose={() => setReading(null)} title={reading?.msg.subject || "Email"}>
        <View className="gap-s2 p-s4">
          <Text size="caption" tone="label">{[reading?.msg.from, reading?.msg.date?.slice(0, 10)].filter(Boolean).join(" · ")}</Text>
          {reading?.error ? <Text tone="muted" size="secondary">{reading.error}</Text> : reading?.text === null ? <Text tone="muted" size="secondary">Opening.</Text> : <Text selectable>{reading?.text}</Text>}
        </View>
      </Sheet>
    </View>
  );
}
