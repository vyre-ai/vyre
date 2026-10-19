import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { CodeBlock } from "../components/CodeBlock";
import { Field } from "../components/Field";
import { Row } from "../components/Row";
import { Segmented } from "../components/Segmented";
import { Select } from "../components/Select";
import { Text } from "../components/Text";
import { routeFacts, sampleCall, schemeWords } from "./webhook-model.js";
import type { TriggerSources } from "./trigger-sources";

const NEW = "__new";
const SCHEMES: [string, string][] = [["hmac-sha256", "Signed body"], ["github", "GitHub"], ["stripe", "Stripe"]];

/**
 * "A webhook is called": pick an open route or open a new one, then see what the sender needs: the address, the header it signs in, the Vault item that holds the secret (a name, never the value) and a
 * sample call. If the listener is off or the box has no public address, it says so plainly, and offers to turn the listener on. Opening a route and turning the listener on are the owner's own acts: each
 * takes the person's yes on the box.
 */
export function WebhookFields({ route, onRoute, sources }: { route: string; onRoute: (r: string) => void; sources?: TriggerSources }) {
  const [hooks, setHooks] = useState<Awaited<ReturnType<NonNullable<TriggerSources["hooks"]>>> | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [name, setName] = useState("");
  const [scheme, setScheme] = useState("hmac-sha256");
  const [header, setHeader] = useState("");
  const [secret, setSecret] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState("");
  const load = useCallback(() => { if (sources?.hooks) void sources.hooks().then(setHooks); else setHooks(null); }, [sources]);
  useEffect(load, [load]);
  if (!sources?.hooks || hooks === null) return <Text tone="muted">This box does not take webhooks yet.</Text>;
  if (hooks === undefined) return <Text tone="muted">Looking.</Text>;
  const f = routeFacts(hooks, route);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setProblem(""); try { await fn(); } catch (e) { setProblem(e instanceof Error && e.message ? e.message : "That did not go through."); } finally { setBusy(false); } };
  const open = () => run(async () => {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name.trim())) throw new Error("Name the route with lowercase words joined by dashes, like northwind-orders.");
    if (scheme === "hmac-sha256" && !header.trim()) throw new Error("Name the header the sender puts its signature in.");
    await sources.openRoute!(name.trim(), scheme, header, secret.trim());
    onRoute(name.trim()); setOpening(false); setMade(secret.trim() ? "" : `hooks-${name.trim()}`); load();
  });
  return (
    <View className="gap-s3">
      <Select label="Which route" value={opening ? NEW : route} options={[...hooks.routes.map((r) => [r.name, `/hooks/${r.name}`] as [string, string]), [NEW, "Open a new route"]]} placeholder="Choose a route" onChange={(v) => { if (v === NEW) { setOpening(true); return; } setOpening(false); onRoute(v); }} />
      {opening ? (
        <View className="gap-s3">
          <Field label="Name" value={name} onChangeText={setName} placeholder="northwind-orders" help="The sender posts to /hooks/ and this name." />
          <Segmented label="Signed by" value={scheme} onChange={setScheme} options={SCHEMES} />
          {scheme === "hmac-sha256" ? <Field label="Signature header" value={header} onChangeText={setHeader} placeholder="x-signature" /> : null}
          <Field label="Secret, in the Vault (optional)" value={secret} onChangeText={setSecret} placeholder="northwind-orders-hook" help="Leave it empty and Vyre makes a strong secret in your Vault for this route. Or name a Vault item that already holds the sender's secret." />
          {secret.trim() && sources.openVault ? <View className="flex-row"><Button kind="secondary" size="sm" label="Add the secret in the Vault" disabled={!secret.trim()} onPress={() => sources.openVault!(secret.trim(), "add")} /></View> : null}
          <Text size="caption" tone="label">Opening the route asks for your yes. If Vyre makes the secret, you read it in the Vault, where a reveal needs you present.</Text>
          <View className="flex-row"><Button kind="primary" label={busy ? "Opening" : "Open the route"} disabled={busy || !sources.openRoute} onPress={() => void open()} /></View>
        </View>
      ) : null}
      {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      {!opening && route ? (
        f.found ? (
          <View className="gap-s2">
            <Banner tone={f.next === "none" ? "plain" : "warn"} icon={f.next === "none" ? "info" : "warning"}><Text>{f.line}</Text></Banner>
            {f.next === "enable" && sources.enableHooks ? <View className="flex-row"><Button kind="primary" label={busy ? "Turning on" : "Turn the listener on"} disabled={busy} onPress={() => void run(async () => { await sources.enableHooks!(); load(); })} /></View> : null}
            <Row dense title="Address" sub={f.url || "None yet: the box is not reachable from the internet"} />
            {f.url ? <CodeBlock code={f.url} lang="" /> : null}
            <Row dense title="Signed by" sub={`${f.scheme}: ${schemeWords(f.scheme)}`} />
            {f.header ? <Row dense title="Header" sub={f.header} /> : null}
            <Row dense title="Signing secret" sub={f.secret ? `In the Vault item ${f.secret}. Its value is never shown here.${made === f.secret ? " Vyre made it for this route." : ""}` : "Not named"} />
            {f.secret && sources.openVault ? <View className="flex-row"><Button kind={made === f.secret ? "primary" : "secondary"} size="sm" label="Reveal the secret" onPress={() => sources.openVault!(f.secret, "see")} /></View> : null}
            {made === f.secret ? <Text size="caption" tone="label">Copy it from the Vault into the sender's settings. Vyre does not show it again here.</Text> : null}
            <Text size="caption" strong tone="label">A test delivery</Text>
            <CodeBlock code={sampleCall(f.url, f.scheme, f.header)} lang="sh" />
          </View>
        ) : <Banner tone="warn"><Text>{f.line}</Text></Banner>
      ) : null}
    </View>
  );
}
