import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { CodeBlock } from "../components/CodeBlock";
import { Field } from "../components/Field";
import { Row } from "../components/Row";
import { Segmented } from "../components/Segmented";
import { Text } from "../components/Text";
import { SIGN_SCHEMES, addressFacts, curlSample, formSample, lastWords, schemeWords } from "./webhook-model.js";
import type { FlowHook } from "./webhook-model.js";
import type { TriggerSources } from "./trigger-sources";

const WORDS = {
  webhook: "The sender posts JSON or a form to this address. The address is the key, so keep it private.",
  form: "Point your form's action at this address. Vyre takes a form post or JSON.",
  signup: "Point your sign-up form's action at this address. The person's name and email are what the steps start with.",
};

/**
 * The Flow's own webhook address, for "A webhook is called", "A form is submitted" and "A person signs up". There is nothing to set up: turning the Flow on opens the address (that yes covers it) and
 * turning it off closes it. Shown: one address with Copy, Send a test, Get a new address and the last delivery; when the server has no public address yet, one plain line saying why. Signature checks are
 * under "Advanced, verify a signature", for senders that sign. A Flow saved the older way (a route opened by hand, or a form with no address) keeps it until the person gives it its own.
 */
export function WebhookFields({ kind, route, address, onOwn, sources }: { kind: "webhook" | "form" | "signup"; route?: string; address?: boolean; onOwn: () => void; sources?: TriggerSources }) {
  const [h, setH] = useState<FlowHook | null | undefined>(undefined);
  const [busy, setBusy] = useState("");
  const [said, setSaid] = useState<{ ok: boolean; line: string } | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [scheme, setScheme] = useState("none");
  const [header, setHeader] = useState("");
  const [secret, setSecret] = useState("");
  const load = useCallback(() => { if (sources?.flowHook) void sources.flowHook().then(setH, () => setH(null)); else setH(null); }, [sources]);
  const older = route !== undefined || address === false;
  useEffect(() => { if (!older) load(); }, [load, older]);
  useEffect(() => { if (h?.check) { setScheme(h.check.scheme); setHeader(h.check.header ?? ""); setSecret(h.check.secret); } }, [h]);
  if (older) {
    return (
      <View className="gap-s2">
        <Banner tone="warn" icon="warning"><Text>{route !== undefined ? `This Flow starts on the route /hooks/${route}, opened by hand. Give it its own address and there is nothing else to set up.` : "This Flow was saved before Flows had their own address, so nothing on the internet reaches it yet."}</Text></Banner>
        <View className="flex-row"><Button kind="primary" label="Give it its own address" onPress={onOwn} /></View>
        <Text size="caption" tone="label">Save the Flow and approve it. Its address shows here once it is on.</Text>
      </View>
    );
  }
  if (!sources?.flowHook) return <Text tone="muted">Save the Flow and turn it on. Its address shows here.</Text>;
  if (h === undefined) return <Text tone="muted">Looking.</Text>;
  const f = addressFacts(h);
  const run = async (what: string, fn: () => Promise<void>) => { setBusy(what); try { await fn(); } catch (e) { setSaid({ ok: false, line: e instanceof Error && e.message ? e.message : "That did not go through." }); } finally { setBusy(""); } };
  const open = Boolean(h && h.open && h.address);
  return (
    <View className="gap-s3">
      {f.state === "live" ? (
        <View className="gap-s2">
          <Text size="caption" strong tone="label">Address</Text>
          <CodeBlock code={f.address} lang="URL" />
          <Text size="caption" tone="label">{WORDS[kind]}</Text>
        </View>
      ) : <Banner tone={f.state === "here" ? "warn" : "plain"} icon={f.state === "here" ? "warning" : "info"}><Text>{f.line}</Text></Banner>}
      {open ? (
        <View className="flex-row flex-wrap gap-s2">
          {sources.testHook ? <Button kind="secondary" size="sm" label={busy === "test" ? "Sending" : "Send a test"} disabled={!!busy} onPress={() => void run("test", async () => { setSaid(await sources.testHook!()); load(); })} /> : null}
          {sources.renewHook && !renewing ? <Button kind="ghost" size="sm" label="Get a new address" disabled={!!busy} onPress={() => setRenewing(true)} /> : null}
        </View>
      ) : null}
      {renewing ? (
        <View className="gap-s2">
          <Banner tone="warn" icon="warning"><Text>The old address stops working at once. Give the new one to the sender after.</Text></Banner>
          <View className="flex-row gap-s2">
            <Button kind="primary" size="sm" label={busy === "renew" ? "Making it" : "Get a new address"} disabled={!!busy} onPress={() => void run("renew", async () => { await sources.renewHook!(); setRenewing(false); setSaid({ ok: true, line: "The address is new. The old one no longer works." }); load(); })} />
            <Button kind="ghost" size="sm" label="Keep this one" onPress={() => setRenewing(false)} />
          </View>
        </View>
      ) : null}
      {said ? <Banner tone={said.ok ? "plain" : "warn"} icon={said.ok ? "check" : "warning"}><Text>{said.line}</Text></Banner> : null}
      {open ? <Row dense title="Last delivery" sub={lastWords(h?.last)} /> : null}
      {f.state === "live" && kind !== "webhook" ? <CodeBlock code={formSample(f.address)} lang="html" /> : null}
      {f.state === "live" && kind === "webhook" ? <CodeBlock code={curlSample(f.address)} lang="sh" /> : null}
      {open && kind === "webhook" && sources.signHook ? (
        <View className="gap-s2">
          <View className="flex-row"><Button kind="ghost" size="sm" icon={advanced ? "chevron-up" : "chevron-down"} label="Advanced, verify a signature" onPress={() => setAdvanced(!advanced)} /></View>
          {h?.check && !advanced ? <Text size="caption" tone="label">{`Also checks ${schemeWords(h.check.scheme)}. The secret is in the Vault item ${h.check.secret}.`}</Text> : null}
          {advanced ? (
            <View className="gap-s3">
              <Text size="caption" tone="label">For a sender that signs what it sends. A delivery then needs the address and a valid signature.</Text>
              <Segmented label="Signature" value={scheme} onChange={setScheme} options={SIGN_SCHEMES} />
              {scheme === "hmac-sha256" ? <Field label="Signature header" value={header} onChangeText={setHeader} placeholder="x-signature" /> : null}
              {scheme !== "none" ? <Field label="Secret, in the Vault (optional)" value={secret} onChangeText={setSecret} placeholder="orders-signing" help="Leave it empty and Vyre makes one in the Vault. Or name a Vault item that holds the sender's secret." /> : null}
              <View className="flex-row flex-wrap gap-s2">
                <Button kind="primary" size="sm" label={busy === "sign" ? "Saving" : "Save the check"} disabled={!!busy || (scheme === "hmac-sha256" && !header.trim())} onPress={() => void run("sign", async () => { await sources.signHook!(scheme, header.trim(), secret.trim()); setAdvanced(false); load(); })} />
                {h?.check && sources.openVault ? <Button kind="ghost" size="sm" label="Reveal the secret" onPress={() => sources.openVault!(h.check!.secret, "see")} /> : null}
              </View>
              <Text size="caption" tone="label">Saving asks for your yes. A secret Vyre makes is read in the Vault, where a reveal needs you present.</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
