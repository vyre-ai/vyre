// MCP servers behind the hub: each server with its state, its tools (Test lists them, each Read, Held or Off), Restart and Remove, and Add. A new server names the vault items it uses;
// the module must be allowed to read them, which is the person's own act (the app's box call asks for it). A value is never shown.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Segmented, Sheet, Text, showToast } from "@vyre/ui";
import { connections } from "./source-real";
import { MODE_WORDS, authWords, itemsFor, itemsNeeded, serverHow, serverInput, serverScopeLine, since, testedLine, toolModes, words, type Mode, type NewServer, type Server, type Tested, type VaultItem } from "./model";
import { ItemPick, WhoControl } from "./shared";

const blank = (): NewServer => ({ name: "", transport: "stdio", command: "", args: "", url: "", auth: "none", item: "", env: [], who: { mode: "me", projects: [] } });

export default function RealMcp() {
  const [list, setList] = useState<Server[] | null>(null);
  const [problem, setProblem] = useState("");
  const [tested, setTested] = useState<Record<string, Tested>>({});
  const [confirm, setConfirm] = useState("");
  const [adding, setAdding] = useState<NewServer | null>(null);
  const load = useCallback(() => { connections.servers().then((x) => { setList(x); setProblem(""); }).catch((e) => setProblem(words(e))); }, []);
  useEffect(load, [load]);
  const say = (e: unknown) => showToast(words(e as { code?: string; message?: string }));
  if (problem && !list) return <ErrorState title="MCP servers did not load" reason={problem} retry={load} />;
  if (!list) return <LoadingState rows={3} />;
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">Add one and its tools reach every chat through the one vyre entry.</Text>
      {list.length ? (
        <Card flush>
          {list.map((s, i) => {
            const t = tested[s.name];
            const rows = t?.ok ? toolModes(t.tools, s.policy.mode) : [];
            return (
              <View key={s.name}>{i ? <Divider /> : null}
                <Row title={<View className="flex-row items-center gap-s2"><Text mono>{s.name}</Text><Chip>{s.transport}</Chip><Text size="caption" tone={s.state === "running" ? "ok" : s.state === "failed" ? "err" : "faint"}>{s.state}</Text></View>} sub={
                  <View className="gap-s1 pt-s1">
                    {s.state === "failed" && s.error ? <Text size="secondary" tone="err">{s.error}</Text> : null}
                    <Text size="secondary" tone="label" mono numberOfLines={2}>{serverHow(s)}</Text>
                    <Text size="secondary" tone="label">{`${s.tools === null ? "Tools not listed yet. Test lists them." : `${s.tools} tools`}. Auth: ${authWords(s)}`}</Text>
                    <Text size="secondary" tone="label">{`${serverScopeLine(s)}. Last used ${since(s.lastUsed)}`}</Text>
                    {t && !t.ok ? <><Text size="secondary">{`The test failed: ${t.error || "no reason given"}`}</Text>{t.stderr.length ? <Text mono size="caption" tone="faint">{t.stderr.join("\n")}</Text> : null}</> : null}
                    {t?.ok ? (
                      <View className="gap-s2 pt-s1">
                        <Text size="secondary" tone="muted">{testedLine(t, rows.length)}</Text>
                        {rows.map((r) => (
                          <View key={r.tool} className="gap-s1">
                            <Text mono size="caption" numberOfLines={1}>{r.tool}</Text>
                            <Segmented label={`Mode for ${r.tool}`} value={r.mode} onChange={(m: Mode) => {
                              if (m === r.mode) return;
                              if (m === "read" && r.sends) { showToast("It sends as you, so it is always held."); return; }
                              const mode = { ...s.policy.mode, [r.tool]: m };
                              connections.setPolicy(s.name, { ...s.policy, mode }).then(load).catch(say);
                            }} options={MODE_WORDS} />
                          </View>
                        ))}
                      </View>
                    ) : null}
                    {confirm === s.name ? (
                      <View className="gap-s2 pt-s1">
                        <Text size="secondary">{`Remove ${s.name}? Its process stops. Its vault items and grants stay as they are.`}</Text>
                        <View className="flex-row gap-s2"><Button size="sm" label="Remove" onPress={() => connections.removeServer(s.name).then(() => { setConfirm(""); setTested(({ [s.name]: _x, ...r }) => r); load(); }).catch(say)} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setConfirm("")} /></View>
                      </View>
                    ) : (
                      <View className="flex-row flex-wrap gap-s2 pt-s1">
                        <Button size="sm" label="Test" onPress={() => connections.testServer(s.name).then((r) => { setTested((m) => ({ ...m, [s.name]: r })); load(); }).catch((e) => setTested((m) => ({ ...m, [s.name]: { ok: false, ms: 0, error: words(e), tools: [], stderr: [] } })))} />
                        <Button size="sm" label="Restart" onPress={() => connections.restartServer(s.name).then(load).catch(say)} />
                        <Button kind="ghost" size="sm" label="Remove" onPress={() => setConfirm(s.name)} />
                      </View>
                    )}
                  </View>} />
              </View>
            );
          })}
        </Card>
      ) : <Card><EmptyState title="No MCP servers yet" body="Add one and its tools reach every chat through the one vyre entry." /></Card>}
      <View className="self-start"><Button kind={list.length ? "ghost" : "primary"} size="sm" icon="plus" label="Add MCP server" onPress={() => setAdding(blank())} /></View>
      <AddServer value={adding} onClose={() => setAdding(null)} onAdded={(name, t) => { if (t) setTested((m) => ({ ...m, [name]: t })); load(); }} />
    </View>
  );
}

function AddServer({ value, onClose, onAdded }: { value: NewServer | null; onClose: () => void; onAdded: (name: string, t: Tested | null) => void }) {
  const [n, setN] = useState<NewServer>(blank());
  const [items, setItems] = useState<VaultItem[]>([]);
  const [projects, setProjects] = useState<{ slug: string; name: string }[] | null>(null);
  const [problem, setProblem] = useState("");
  const [left, setLeft] = useState<{ name: string; items: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (value) { setN(value); setProblem(""); setLeft(null); connections.vaultItems().then(setItems).catch(() => setItems([])); connections.projects().then(setProjects).catch(() => setProjects([])); } }, [value]);
  if (!value) return null;
  const go = async () => {
    const p = serverInput(n);
    if ("error" in p) { setProblem(p.error); return; }
    setBusy(true); setProblem("");
    try {
      const r = await connections.addServer(p.input);
      // The server is made; its module must be able to read the vault items it names (the person's own act). What cannot be granted yet is asked again with a button.
      const stillNeeded: string[] = [];
      for (const it of itemsNeeded(p.input)) {
        if (items.find((i) => i.name === it)?.grants.includes("mcp")) continue;
        try { await connections.grantItem(it, "mcp"); } catch { stillNeeded.push(it); }
      }
      let t = r.test;
      if (itemsNeeded(p.input).length && !stillNeeded.length) t = await connections.testServer(String(p.input.name)).catch(() => t);
      onAdded(String(p.input.name), t);
      if (stillNeeded.length) setLeft({ name: String(p.input.name), items: stillNeeded }); else onClose();
    } catch (e) { setProblem(words(e as { code?: string; message?: string })); } finally { setBusy(false); }
  };
  const authItems = n.auth === "none" || n.auth === "env" ? [] : itemsFor(items, n.auth);
  return (
    <Sheet open onClose={onClose} title="Add an MCP server">
      {left ? (
        <View className="gap-s3">
          <Text>{`${left.name} is added, but it cannot use ${left.items.length === 1 ? "its Vault item" : "its Vault items"} yet. Give it access, then test it.`}</Text>
          {left.items.map((it) => <Row key={it} dense title={it} end={<Button size="sm" label="Give access" onPress={() => { connections.grantItem(it, "mcp").then(() => { const rest = left.items.filter((x) => x !== it); if (rest.length) setLeft({ ...left, items: rest }); else onClose(); }).catch((e) => setProblem(words(e as { code?: string; message?: string }))); }} />} />)}
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <Button kind="primary" label="Done" onPress={onClose} />
        </View>
      ) : (
        <View className="gap-s3">
          <Field label="Name" value={n.name} onChangeText={(name) => setN({ ...n, name })} help="Lowercase letters, digits and dashes. Tools show as <name>__<tool>." />
          <Segmented label="Transport" value={n.transport} onChange={(transport) => setN({ ...n, transport })} options={[["stdio", "Command"], ["http", "Web address"]]} />
          {n.transport === "stdio" ? <>
            <Field label="Command" value={n.command} onChangeText={(command) => setN({ ...n, command })} placeholder="npx" />
            <Field label="Arguments" value={n.args} onChangeText={(args) => setN({ ...n, args })} placeholder="-y some-mcp-server" />
          </> : <Field label="Address" value={n.url} onChangeText={(url) => setN({ ...n, url })} placeholder="https://example.com/mcp" />}
          <Segmented label="Auth" value={n.auth} onChange={(auth) => setN({ ...n, auth, item: "" })} options={[["none", "None"], ["bearer", "Bearer"], ["env", "Env vars"], ["oauth", "OAuth"], ["service-account", "Service acct"]]} />
          {n.auth === "bearer" || n.auth === "oauth" || n.auth === "service-account" ? <>
            <ItemPick items={authItems} value={n.item} onChange={(item) => setN({ ...n, item })} empty="No vault item fits this. Add one in the Vault first." />
            <Text size="caption" tone="label">{n.auth === "oauth" ? "An env set with client_id, client_secret, refresh_token and token_uri." : n.auth === "service-account" ? "A note or secret holding the service account's JSON." : "Sent as Authorization: Bearer on each request."}</Text>
          </> : null}
          {n.auth === "env" ? (
            <View className="gap-s2">
              {n.env.map((r, i) => (
                <View key={i} className="gap-s1">
                  <Field label="Variable" value={r.var} onChangeText={(v) => setN({ ...n, env: n.env.map((x, j) => (j === i ? { ...x, var: v } : x)) })} placeholder="TRACKER_TOKEN" />
                  <ItemPick items={itemsFor(items, "env")} value={r.item} onChange={(item) => setN({ ...n, env: n.env.map((x, j) => (j === i ? { ...x, item, field: "" } : x)) })} empty="No vault item fits this." />
                  {(() => { const f = items.find((x) => x.name === r.item); return f && f.kind === "env-set" && f.fields.length ? <View className="flex-row flex-wrap gap-s2">{f.fields.map((x) => <Chip key={x} selected={r.field === x} onPress={() => setN({ ...n, env: n.env.map((y, j) => (j === i ? { ...y, field: r.field === x ? "" : x } : y)) })}>{x}</Chip>)}</View> : null; })()}
                  <View className="self-start"><Button kind="ghost" size="sm" label="Remove this variable" onPress={() => setN({ ...n, env: n.env.filter((_, j) => j !== i) })} /></View>
                </View>
              ))}
              <View className="self-start"><Button kind="ghost" size="sm" label="Add a variable" onPress={() => setN({ ...n, env: [...n.env, { var: "", item: "", field: "" }] })} /></View>
            </View>
          ) : null}
          <WhoControl who={n.who} projects={projects} onChange={(who) => setN({ ...n, who })} />
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <Button kind="primary" label={busy ? "Adding" : "Add server"} disabled={busy} onPress={go} />
        </View>
      )}
    </Sheet>
  );
}
