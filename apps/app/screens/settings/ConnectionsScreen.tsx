// Settings, Connections (the Deck's connections.js, ported): MCP servers (Test, per-tool Read/Held/Off, Restart, Remove), Google accounts (Test, Remove) and GitHub accounts (device-code sign-in or a pasted token, Disconnect).
// Adding an MCP server or a Google account, and the connectors catalog, are not here yet (docs/work/web.md).
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Chip, Divider, ErrorState, Field, LoadingState, Segmented, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { listen } from "../../src/api/box";
import { connections } from "./connections";
import {
  MODE_WORDS, authWords, errText, githubEnd, googleAuthLine, reachLine, redact, runsLine, safeGithubUrl, scopeLine, toolModes, toolsLine,
  type GithubAccount, type GithubFlow, type GoogleAccount, type GoogleTested, type Mode, type Server, type Tested,
} from "./connections-model.ts";

type Sect<T> = { rows: T[]; error: string } | null;
const say = (e: unknown) => errText(e as any);

function Servers() {
  const [s, setS] = useState<Sect<Server>>(null);
  const [tested, setTested] = useState<Record<string, Tested>>({});
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const load = useCallback(() => { connections.servers().then(setS); }, []);
  useEffect(load, [load]);
  const act = (name: string, label: string, fn: () => Promise<unknown>) => { setBusy(`${name}:${label}`); setNote((n) => ({ ...n, [name]: "" })); fn().then(load).catch((e) => setNote((n) => ({ ...n, [name]: say(e) }))).finally(() => setBusy("")); };
  return (
    <Card className="gap-s3">
      <Text strong>MCP servers</Text>
      {s === null ? <LoadingState rows={2} /> : null}
      {s?.error ? <ErrorState title="MCP servers did not load" reason={s.error} retry={load} /> : null}
      {s && !s.error && !s.rows.length ? <Text tone="muted">No MCP server yet. Add one with vyre mcp add, and its tools appear here to Test.</Text> : null}
      {s?.rows.map((r, i) => {
        const t = tested[r.name];
        return (
          <View key={r.name}>
            {i ? <Divider /> : null}
            <View className="gap-s2 py-s2">
              <View className="flex-row flex-wrap items-center gap-s2"><Text strong mono>{r.name}</Text><Chip>{r.transport || "mcp"}</Chip><Chip tone={r.state === "running" ? "ok" : r.state === "failed" ? "warn" : "plain"}>{r.state}</Chip></View>
              {r.state === "failed" && r.error ? <Text size="caption" tone="warn">{r.error}</Text> : null}
              <Text size="caption" tone="label">{`Runs: ${runsLine(r) || "-"}`}</Text>
              <Text size="caption" tone="label">{`Tools: ${toolsLine(r)}`}</Text>
              <Text size="caption" tone="label">{`Auth: ${authWords(r)}`}</Text>
              <Text size="caption" tone="label">{`Scope: ${scopeLine(r)}`}</Text>
              {t ? (
                t.ok ? (
                  <View className="gap-s2">
                    <Text size="caption" tone="muted">{`Answered in ${t.ms} ms with ${t.tools.length === 1 ? "one tool" : `${t.tools.length} tools`}. A held tool waits at the Gate for you before anything reaches the server.`}</Text>
                    {toolModes(t.tools, r.policy.mode).map((m) => (
                      <View key={m.tool} className="gap-s1">
                        <Text size="caption" mono>{m.tool}</Text>
                        <Segmented label={`Mode for ${m.tool}`} value={m.mode} onChange={(v: Mode) => v !== m.mode && !(v === "read" && m.sends) && act(r.name, `mode:${m.tool}`, () => connections.setMode(r, m.tool, v))} options={MODE_WORDS.filter(([v]) => !(v === "read" && m.sends))} />
                      </View>
                    ))}
                  </View>
                ) : <View className="gap-s1"><Text size="caption" tone="warn">{`The test failed: ${t.error || "no reason given"}`}</Text>{t.stderr.length ? <Text size="caption" mono>{t.stderr.join("\n")}</Text> : null}</View>
              ) : null}
              {note[r.name] ? <Text size="caption" tone="warn">{note[r.name]}</Text> : null}
              {confirming === r.name ? (
                <View className="gap-s2">
                  <Text size="caption">{`Remove ${r.name}? Its process stops. Its vault items and grants stay as they are.`}</Text>
                  <View className="flex-row flex-wrap gap-s2">
                    <Button size="sm" label="Remove" onPress={() => { setConfirming(""); act(r.name, "remove", () => connections.remove(r.name)); }} />
                    <Button kind="ghost" size="sm" label="Cancel" onPress={() => setConfirming("")} />
                  </View>
                </View>
              ) : (
                <View className="flex-row flex-wrap gap-s2">
                  <Button size="sm" label={busy === `${r.name}:test` ? "Testing" : "Test"} disabled={!!busy} onPress={() => act(r.name, "test", async () => { try { const x = await connections.test(r.name); setTested((o) => ({ ...o, [r.name]: x })); } catch (e) { setTested((o) => ({ ...o, [r.name]: { ok: false, ms: 0, error: say(e), tools: [], stderr: [] } })); } })} />
                  <Button size="sm" label={busy === `${r.name}:restart` ? "Restarting" : "Restart"} disabled={!!busy} onPress={() => act(r.name, "restart", () => connections.restart(r.name))} />
                  <Button kind="ghost" size="sm" label="Remove" onPress={() => setConfirming(r.name)} />
                </View>
              )}
            </View>
          </View>
        );
      })}
    </Card>
  );
}

function Google() {
  const [s, setS] = useState<Sect<GoogleAccount>>(null);
  const [tested, setTested] = useState<Record<string, GoogleTested>>({});
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const load = useCallback(() => { connections.accounts().then(setS); }, []);
  useEffect(load, [load]);
  const act = (name: string, fn: () => Promise<unknown>, after = load) => { setBusy(name); setNote((n) => ({ ...n, [name]: "" })); fn().then(after).catch((e) => setNote((n) => ({ ...n, [name]: say(e) }))).finally(() => setBusy("")); };
  return (
    <Card className="gap-s3">
      <Text strong>Google accounts</Text>
      {s === null ? <LoadingState rows={2} /> : null}
      {s?.error ? <ErrorState title="Google accounts did not load" reason={s.error} retry={load} /> : null}
      {s && !s.error && !s.rows.length ? <Text tone="muted">No Google account yet. Add one with vyre google add and the assistant can read your calendar and mail; sends and invites wait for you.</Text> : null}
      {s?.rows.map((a, i) => {
        const t = tested[a.name];
        return (
          <View key={a.name}>
            {i ? <Divider /> : null}
            <View className="gap-s2 py-s2">
              <View className="flex-row flex-wrap items-center gap-s2"><Text strong mono>{a.name}</Text><Text tone="muted">{a.email}</Text></View>
              <Text size="caption" tone="label">{`Auth: ${googleAuthLine(a)}`}</Text>
              <Text size="caption" tone="label">{`Vault item: ${a.auth.item || "-"}`}</Text>
              {t ? (
                <View className="gap-s1">
                  {Object.keys(t.scopes).length ? <View className="flex-row flex-wrap gap-s1">{Object.entries(t.scopes).map(([k, ok]) => <Chip key={k} tone={ok ? "ok" : "warn"}>{`${k} ${ok ? "granted" : "refused"}`}</Chip>)}</View> : <Text size="caption" tone="muted">{t.ok ? "None" : "Not checked"}</Text>}
                  {t.error ? <Text size="caption" tone="warn">{t.error}</Text> : null}
                </View>
              ) : <Text size="caption" tone="label">Scopes: not checked yet. Test asks Google for each one.</Text>}
              {note[a.name] ? <Text size="caption" tone="warn">{note[a.name]}</Text> : null}
              {confirming === a.name ? (
                <View className="gap-s2">
                  <Text size="caption">{`Disconnect ${a.name}? Its vault item stays, and so does its grant.`}</Text>
                  <View className="flex-row flex-wrap gap-s2">
                    <Button size="sm" label="Remove" onPress={() => { setConfirming(""); act(a.name, () => connections.googleRemove(a.name)); }} />
                    <Button kind="ghost" size="sm" label="Cancel" onPress={() => setConfirming("")} />
                  </View>
                </View>
              ) : (
                <View className="flex-row flex-wrap gap-s2">
                  <Button size="sm" label={busy === a.name ? "Testing" : "Test"} disabled={!!busy} onPress={() => act(a.name, async () => { try { setTested((o) => ({ ...o, [a.name]: { ok: false, scopes: {}, error: "" } })); const x = await connections.googleTest(a.name); setTested((o) => ({ ...o, [a.name]: x })); } catch (e) { setTested((o) => ({ ...o, [a.name]: { ok: false, scopes: {}, error: say(e) } })); } }, () => {})} />
                  <Button kind="ghost" size="sm" label="Remove" onPress={() => setConfirming(a.name)} />
                </View>
              )}
            </View>
          </View>
        );
      })}
    </Card>
  );
}

function Github() {
  const [s, setS] = useState<Sect<GithubAccount>>(null);
  const [form, setForm] = useState(false);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [flow, setFlow] = useState<GithubFlow | null>(null);
  const [confirming, setConfirming] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const open = useRef<string>("");
  const load = useCallback(() => { connections.github().then(setS); }, []);
  useEffect(load, [load]);
  // github.connected and github.connect-failed end the open device sign-in; nothing here polls.
  useEffect(() => listen((e) => {
    const end = open.current ? githubEnd(e, open.current) : null;
    if (!end) return;
    open.current = "";
    if (end.ok) { setFlow(null); setForm(false); load(); } else { setFlow(null); setStatus(end.error); }
  }), [load]);
  useEffect(() => () => { if (open.current) void connections.githubCancel(open.current).catch(() => {}); }, []);
  const close = () => { if (open.current) void connections.githubCancel(open.current).catch(() => {}); open.current = ""; setFlow(null); setForm(false); setStatus(""); setToken(""); };
  const start = async () => {
    if (!name.trim()) return setStatus("Give the account a name, like work or personal.");
    setStatus("Starting.");
    try {
      const f = await connections.githubStart(name.trim());
      if (!f) return setStatus("GitHub did not return a code. Try again.");
      open.current = f.id; setFlow(f); setStatus("");
    } catch (e) { setStatus(say(e)); }
  };
  const withToken = async () => {
    const n = name.trim(), t = token.trim();
    if (!n) return setStatus("Give the account a name, like work or personal.");
    if (!t) return setStatus("Paste the token first.");
    setStatus("Checking the token.");
    try { const d = await connections.githubToken(n, t); setToken(""); setForm(false); setStatus(""); showToast(reachLine(String(d?.login || ""), typeof d?.repos === "number" ? d.repos : null)); load(); }
    catch (e) { setToken(""); setStatus(redact((e as Error).message || "GitHub did not take that token.", [t])); }
  };
  const disconnect = (a: GithubAccount) => { setConfirming(""); connections.githubRemove(a.name).then((d) => { if (d?.warning) setNote((n) => ({ ...n, [a.name]: String(d.warning) })); load(); }).catch((e) => setNote((n) => ({ ...n, [a.name]: say(e) }))); };
  return (
    <Card className="gap-s3">
      <Text strong>GitHub accounts</Text>
      {s === null ? <LoadingState rows={1} /> : null}
      {s?.error ? <ErrorState title="GitHub accounts did not load" reason={s.error} retry={load} /> : null}
      {s && !s.error && !s.rows.length && !form ? <Text tone="muted">No GitHub account yet. Connect one and an agent can clone your repos and work in its own worktree, one branch per session.</Text> : null}
      {s?.rows.map((a, i) => (
        <View key={a.name}>
          {i ? <Divider /> : null}
          <View className="gap-s2 py-s2">
            <View className="flex-row flex-wrap items-center gap-s2"><Text strong mono>{a.name}</Text><Text tone="muted">{a.login}</Text></View>
            {note[a.name] ? <Text size="caption" tone="warn">{note[a.name]}</Text> : null}
            {confirming === a.name ? (
              <View className="gap-s2">
                <Text size="caption">{`Disconnect ${a.name}? This removes its token from your vault and the account from Vyre. It does not revoke the token at GitHub: delete it at github.com/settings/applications (signed in with GitHub) or github.com/settings/tokens (a token you pasted).`}</Text>
                <View className="flex-row flex-wrap gap-s2"><Button size="sm" label="Disconnect" onPress={() => disconnect(a)} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setConfirming("")} /></View>
              </View>
            ) : <View className="self-start"><Button kind="ghost" size="sm" label="Disconnect" onPress={() => setConfirming(a.name)} /></View>}
          </View>
        </View>
      ))}
      {flow ? (
        <View className="gap-s2">
          <Text>Enter this code at github.com/login/device:</Text>
          <Text size="title" mono>{flow.user_code}</Text>
          <View className="flex-row flex-wrap gap-s2">
            <Button size="sm" label="Copy" kind="ghost" onPress={() => { void Clipboard.setStringAsync(flow.user_code); showToast("Copied."); }} />
            <Button size="sm" label="Open GitHub" onPress={() => void Linking.openURL(safeGithubUrl(flow.verification_uri_complete || flow.verification_uri))} />
          </View>
          <Text size="caption" tone="muted">{`Good for about ${flow.minutes} ${flow.minutes === 1 ? "minute" : "minutes"}.`}</Text>
          <View className="self-start"><Button kind="ghost" size="sm" label="Cancel" onPress={close} /></View>
        </View>
      ) : form ? (
        <View className="gap-s2">
          <Field label="Name" value={name} onChangeText={setName} placeholder="work" help="What the assistant calls it, like work or personal." />
          <Text size="caption" tone="label">GitHub asks for repo access: full read and write on every repo the account can reach. Its device sign-in has no narrower option.</Text>
          <View className="flex-row flex-wrap gap-s2"><Button kind="primary" size="sm" label="Sign in with GitHub" onPress={() => void start()} /><Button kind="ghost" size="sm" label="Cancel" onPress={close} /></View>
          <Field label="Or paste a token" kind="password" value={token} onChangeText={setToken} help="A token you made at GitHub. A fine-grained token can reach fewer repos than signing in does." />
          <View className="self-start"><Button size="sm" label="Connect with this token" onPress={() => void withToken()} /></View>
        </View>
      ) : <View className="self-start"><Button size="sm" label="Add a GitHub account" onPress={() => { setForm(true); setStatus(""); }} /></View>}
      {status ? <Text size="caption" tone="muted">{status}</Text> : null}
    </Card>
  );
}

export function ConnectionsScreen() {
  return (
    <Page title="Connections" back="/u/settings">
      <Banner>The servers and accounts your assistants can reach. Only names are shown here; the values stay sealed in your vault.</Banner>
      <Servers />
      <Google />
      <Github />
    </Page>
  );
}
