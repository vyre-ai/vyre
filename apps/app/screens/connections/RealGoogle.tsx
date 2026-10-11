// Google accounts. "Sign in with Google" grants the OAuth client item to the google module, starts the sign-in on the box, opens Google's page on this device and waits; an address
// pasted from another browser finishes it too. A service account or a refresh-token item is added by naming its vault item. Test asks Google for each scope.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Segmented, Sheet, Text, showToast } from "@vyre/ui";
import { connections } from "./source-real";
import { accountAuthLine, accountInput, itemsFor, scopeLines, words, type Account, type GoogleTest, type VaultItem } from "./model";
import { ItemPick, openUrl, usePoll } from "./shared";

type How = "signin" | "service-account" | "oauth";
const HOW: [How, string][] = [["signin", "Sign in with Google"], ["service-account", "Service account"], ["oauth", "Refresh token item"]];

export default function RealGoogle() {
  const [list, setList] = useState<Account[] | null>(null);
  const [problem, setProblem] = useState("");
  const [tested, setTested] = useState<Record<string, GoogleTest>>({});
  const [confirm, setConfirm] = useState("");
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => { connections.accounts().then((x) => { setList(x); setProblem(""); }).catch((e) => setProblem(words(e))); }, []);
  useEffect(load, [load]);
  const test = (name: string) => connections.testAccount(name).then((t) => setTested((m) => ({ ...m, [name]: t }))).catch((e) => setTested((m) => ({ ...m, [name]: { ok: false, scopes: {}, error: words(e), clientId: "", adminScopes: "" } })));
  if (problem && !list) return <ErrorState title="Google accounts did not load" reason={problem} retry={load} />;
  if (!list) return <LoadingState rows={2} />;
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">Add one and the assistant can read your calendar and mail; sends and invites wait for you.</Text>
      {list.length ? (
        <Card flush>
          {list.map((a, i) => {
            const t = tested[a.name];
            return (
              <View key={a.name}>{i ? <Divider /> : null}
                <Row title={<View className="flex-row items-center gap-s2"><Text mono>{a.name}</Text><Text tone="muted">{a.email}</Text></View>} sub={
                  <View className="gap-s1 pt-s1">
                    <Text size="secondary" tone="label">{accountAuthLine(a)}</Text>
                    <Text size="secondary" tone="label">{`Vault item: ${a.auth.item}`}</Text>
                    {t?.error ? <Text size="secondary" tone="err">{t.error}</Text> : null}
                    {t && !t.error ? (scopeLines(t).length ? scopeLines(t).map((s) => <Text key={s.scope} size="caption" tone={s.ok ? "ok" : "err"} numberOfLines={1}>{`${s.scope} ${s.ok ? "granted" : "refused"}`}</Text>) : <Text size="secondary" tone="muted">{t.ok ? "No scopes." : "Not checked."}</Text>) : <Text size="secondary" tone="muted">Not checked yet. Test asks Google for each scope.</Text>}
                    {t && a.auth.type === "service-account" && t.clientId ? (
                      <View className="gap-s1 pt-s1">
                        <Text size="caption" strong tone="label">For your Workspace admin console</Text>
                        <Text size="caption" tone="label">Client ID</Text><Text mono selectable size="secondary">{t.clientId}</Text>
                        <Text size="caption" tone="label">Scopes</Text><Text mono selectable size="caption">{t.adminScopes}</Text>
                      </View>
                    ) : null}
                    {confirm === a.name ? (
                      <View className="gap-s2 pt-s1">
                        <Text size="secondary">{`Disconnect ${a.name}? Its vault item stays, and so does its grant.`}</Text>
                        <View className="flex-row gap-s2"><Button size="sm" label="Remove" onPress={() => connections.removeAccount(a.name).then(() => { setConfirm(""); setTested(({ [a.name]: _x, ...r }) => r); load(); }).catch((e) => showToast(words(e)))} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setConfirm("")} /></View>
                      </View>
                    ) : <View className="flex-row gap-s2 pt-s1"><Button size="sm" label="Test" onPress={() => void test(a.name)} /><Button kind="ghost" size="sm" label="Remove" onPress={() => setConfirm(a.name)} /></View>}
                  </View>} />
              </View>
            );
          })}
        </Card>
      ) : <Card><EmptyState title="No Google account yet" body="Add one and the assistant can read your calendar and mail; sends and invites wait for you." /></Card>}
      <View className="self-start"><Button kind={list.length ? "ghost" : "primary"} size="sm" icon="plus" label="Add Google account" onPress={() => setAdding(true)} /></View>
      <AddGoogle open={adding} known={list.map((a) => a.name)} onClose={() => setAdding(false)} onDone={(name) => { load(); if (name) void test(name); }} />
    </View>
  );
}

function AddGoogle({ open, known, onClose, onDone }: { open: boolean; known: string[]; onClose: () => void; onDone: (name?: string) => void }) {
  const [how, setHow] = useState<How>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [item, setItem] = useState("");
  const [items, setItems] = useState<VaultItem[]>([]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<string | null>(null);
  const [flow, setFlow] = useState<{ id: string; name: string; url: string; paste: string } | null>(null);
  useEffect(() => { if (open) { setHow("signin"); setName(""); setEmail(""); setSubject(""); setItem(""); setProblem(""); setLeft(null); setFlow(null); connections.vaultItems().then(setItems).catch(() => setItems([])); } }, [open]);

  // The box finishes the sign-in by itself when the loopback is reachable; this notices it.
  usePoll(!!flow, () => connections.accounts().then((l) => { if (flow && l.some((a) => a.name === flow.name) && !known.includes(flow.name)) { setFlow(null); onClose(); onDone(flow.name); } }).catch(() => {}));

  const cancel = () => { const f = flow; setFlow(null); if (f) connections.googleCancel(f.id).catch(() => {}); onClose(); };
  const grant = async (it: string): Promise<boolean> => {
    if (items.find((i) => i.name === it)?.grants.includes("google")) return true;
    try { await connections.grantItem(it, "google"); return true; } catch { return false; }
  };
  const go = async () => {
    setProblem("");
    if (how === "signin") {
      if (!name.trim()) { setProblem("Give the account a name."); return; }
      if (!item) { setProblem("Choose the vault item that holds your OAuth client."); return; }
      setBusy(true);
      if (!(await grant(item))) { setBusy(false); setLeft(item); return; }
      try { const r = await connections.googleConnect(name.trim(), item); openUrl(r.url); setFlow({ id: r.id, name: name.trim(), url: r.url, paste: "" }); }
      catch (e) { setProblem(words(e as { code?: string; message?: string })); }
      setBusy(false);
      return;
    }
    const p = accountInput({ name, email, type: how, item, subject });
    if ("error" in p) { setProblem(p.error); return; }
    setBusy(true);
    try {
      await connections.addAccount(p.input);
      if (await grant(item)) { onClose(); onDone(name.trim()); } else { onDone(); setLeft(item); }
    } catch (e) { setProblem(words(e as { code?: string; message?: string })); }
    setBusy(false);
  };
  const finish = () => {
    if (!flow) return;
    if (!flow.paste.trim()) { setProblem("Paste the whole address from the browser's address bar."); return; }
    setBusy(true); setProblem("");
    connections.googleFinish(flow.id, flow.paste.trim()).then((r) => { setFlow(null); onClose(); onDone(r.name || flow.name); }).catch((e) => setProblem(words(e))).finally(() => setBusy(false));
  };
  return (
    <Sheet open={open} onClose={flow ? cancel : onClose} title="Add a Google account">
      {left ? (
        <View className="gap-s3">
          <Text>{`Google cannot use ${left} in the Vault yet. Give it access, then try again.`}</Text>
          <View className="flex-row gap-s2">
            <Button kind="primary" label={busy ? "Giving access" : "Give access"} disabled={busy} onPress={() => { setBusy(true); connections.grantItem(left, "google").then(() => { setLeft(null); onClose(); onDone(); }).catch((e) => setProblem(words(e as { code?: string; message?: string }))).finally(() => setBusy(false)); }} />
            <Button kind="ghost" label="Not now" onPress={onClose} />
          </View>
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        </View>
      ) : flow ? (
        <View className="gap-s3">
          <Text>Waiting for Google. Finish in the page that opened.</Text>
          <View className="self-start"><Button size="sm" label="Open Google's sign-in page" onPress={() => openUrl(flow.url)} /></View>
          <Text size="caption" tone="label">Signed in on another device? Paste the address the browser landed on.</Text>
          <Field label="Address" value={flow.paste} onChangeText={(paste) => setFlow({ ...flow, paste })} placeholder="http://127.0.0.1:…/google/callback?state=…" />
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <View className="flex-row gap-s2"><Button size="sm" label="Finish" disabled={busy} onPress={finish} /><Button kind="ghost" size="sm" label="Cancel" onPress={cancel} /></View>
        </View>
      ) : (
        <View className="gap-s3">
          <Field label="Name" value={name} onChangeText={setName} help="What the assistant calls it, like work or home." placeholder="work" />
          <Segmented label="Signs in with" value={how} onChange={(h) => { setHow(h); setItem(""); setProblem(""); }} options={HOW} />
          {how !== "signin" ? <Field label="Address" value={email} onChangeText={setEmail} placeholder="you@example.com" /> : null}
          <Text size="caption" strong tone="label">{how === "signin" ? "OAuth client" : "Vault item"}</Text>
          <ItemPick items={itemsFor(items, how)} value={item} onChange={setItem} empty="No vault item fits this. Add one in the Vault first." />
          <Text size="caption" tone="label">{how === "signin" ? "A Desktop app OAuth client from Google Cloud console, kept in the Vault as an env set with client_id and client_secret (bring it in with Import, from a .env file)." : how === "oauth" ? "An env set with client_id, client_secret, refresh_token and token_uri." : "A note or secret holding the service account's JSON. It acts as the address below through domain-wide delegation."}</Text>
          {how === "service-account" ? <Field label="Acts as" value={subject} onChangeText={setSubject} help="Leave empty to act as the account's own address." /> : null}
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <Button kind="primary" label={busy ? "Working" : how === "signin" ? "Sign in with Google" : "Add account"} disabled={busy} onPress={go} />
        </View>
      )}
    </Sheet>
  );
}
