// "Add a service": the catalog of vendor-hosted connectors, grouped, with a Connect on each. Step one is who can use it; then the box answers with the step to draw:
// the vendor's sign-in page (opened on this device, with a paste box for an address that ended on another one), a token with the preset's own extra fields, the OAuth
// client to pick from the vault, or a line saying it comes through another connector. Nothing polls except while a sign-in is open.
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Text, showToast } from "@vyre/ui";
import { connections } from "./source-real";
import { SETUP_WORD, scopeLine, scopeOf, whoFrom, words, type Preset, type Step, type Who, type VaultItem } from "./model";
import { GuideView, ItemPick, WhoControl, openUrl, usePoll } from "./shared";

export default function RealCatalog() {
  const [groups, setGroups] = useState<{ group: string; presets: Preset[] }[] | null>(null);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [flow, setFlow] = useState<{ preset: Preset; who: Who; step: Step | null; busy: boolean; error: string; token: string; extra: Record<string, string>; client: string; app: Record<string, string>; paste: string } | null>(null);
  const [editing, setEditing] = useState<{ name: string; label: string; who: Who; error: string } | null>(null);
  const [projects, setProjects] = useState<{ slug: string; name: string }[] | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const load = useCallback(() => { connections.catalog().then((g) => { setGroups(g); setProblem(""); }).catch((e) => setProblem(words(e))); }, []);
  useEffect(load, [load]);
  const needProjects = () => { if (!projects) connections.projects().then(setProjects).catch(() => setProjects([])); };

  // While a vendor sign-in is open, the box finishes it on its own; the catalog tells us when it has.
  const open = flow?.step?.step === "open";
  usePoll(open, () => connections.catalog().then((g) => {
    setGroups(g);
    const now = g.flatMap((x) => x.presets).find((p) => p.id === flow?.preset.id);
    if (now && flow && now.connected.length > flow.preset.connected.length) { setNotice(`${now.label} is connected.`); setFlow(null); }
  }).catch(() => {}));

  const start = (preset: Preset) => { needProjects(); setFlow({ preset, who: { mode: "me", projects: [] }, step: null, busy: false, error: "", token: "", extra: {}, client: "", app: {}, paste: "" }); setNotice(""); };
  const connect = (extra: { token?: string; extra?: Record<string, string>; client?: string; app?: { client_id: string; client_secret?: string } } = {}) => {
    if (!flow) return;
    const scope = scopeOf(flow.who);
    if (scope === undefined) { setFlow({ ...flow, error: "Choose at least one project." }); return; }
    setFlow({ ...flow, busy: true, error: "" });
    connections.connect(flow.preset.id, flow.preset.label, { ...(scope ? { scope } : {}), ...extra }).then((step) => {
      if (step.step === "connected") { setNotice(step.line); setFlow(null); load(); return; }
      if (step.step === "open" && step.url) openUrl(step.url);
      if (step.step === "client") connections.vaultItems().then(setItems).catch(() => setItems([]));
      setFlow((f) => (f ? { ...f, busy: false, step, token: "", app: {} } : f));
    }).catch((e) => setFlow((f) => (f ? { ...f, busy: false, token: "", error: words(e, [extra.token ?? "", extra.client ?? "", extra.app?.client_secret ?? ""]) } : f)));
  };
  const cancel = () => { const f = flow; setFlow(null); if (f?.step?.step === "open") connections.connectCancel(f.step.id).catch(() => {}); };
  const finish = () => {
    if (!flow || flow.step?.step !== "open") return;
    const url = flow.paste.trim();
    if (!url) { setFlow({ ...flow, error: "Paste the address the page ended on." }); return; }
    setFlow({ ...flow, busy: true, error: "" });
    connections.connectFinish(flow.step.id, url).then(() => { setFlow(null); load(); }).catch((e) => setFlow((f) => (f ? { ...f, busy: false, error: words(e) } : f)));
  };
  const live = useRef(flow);
  live.current = flow;
  // A sign-in left open is cancelled when the section goes away.
  useEffect(() => () => { const s = live.current?.step; if (s?.step === "open") connections.connectCancel(s.id).catch(() => {}); }, []);

  const panel = () => {
    if (!flow) return null;
    const s = flow.step;
    const f = flow;
    const set = (p: Partial<typeof f>) => setFlow({ ...f, ...p });
    const err = f.error ? <Text tone="muted" size="secondary">{f.error}</Text> : null;
    const cancelBtn = <Button kind="ghost" size="sm" label="Cancel" onPress={cancel} />;
    if (!s) {
      return (
        <View className="gap-s3 p-s4">
          <WhoControl who={f.who} projects={projects} onChange={(who) => set({ who })} />
          {err}
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={f.busy ? "Asking" : "Connect"} disabled={f.busy} onPress={() => connect()} />{cancelBtn}</View>
        </View>
      );
    }
    if (s.step === "open") {
      return (
        <View className="gap-s3 p-s4">
          <Text size="secondary">Approve it on the vendor's page, then come back. This finishes by itself.</Text>
          {s.url ? <View className="self-start"><Button size="sm" label="Open the sign-in page" onPress={() => openUrl(s.url!)} /></View> : null}
          <Text size="caption" tone="label">Signing in on a different browser? Paste the address it ends on.</Text>
          <Field label="Address the page ended on" value={f.paste} onChangeText={(paste) => set({ paste })} placeholder="http://127.0.0.1:…/callback?code=…" />
          {err}
          <View className="flex-row gap-s2"><Button size="sm" label="Finish" disabled={f.busy} onPress={finish} />{cancelBtn}</View>
        </View>
      );
    }
    if (s.step === "token") {
      return (
        <View className="gap-s3 p-s4">
          {s.help ? <Text size="secondary">{s.help}</Text> : null}
          <GuideView guide={s.guide} />
          <Field label={s.label} kind="password" value={f.token} onChangeText={(token) => set({ token })} />
          {s.extra.map((x) => <Field key={x.name} label={`${x.label}${x.required ? "" : " (optional)"}`} value={f.extra[x.name] ?? ""} onChangeText={(v) => set({ extra: { ...f.extra, [x.name]: v } })} />)}
          {err}
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={f.busy ? "Connecting" : "Connect"} disabled={f.busy} onPress={() => {
            if (!f.token.trim()) { set({ error: "Paste the token first." }); return; }
            const miss = s.extra.find((x) => x.required && !(f.extra[x.name] ?? "").trim());
            if (miss) { set({ error: `${miss.label} is needed.` }); return; }
            const extra = Object.fromEntries(Object.entries(f.extra).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
            const token = f.token.trim();
            connect({ token, extra });
          }} />{cancelBtn}</View>
        </View>
      );
    }
    if (s.step === "client") {
      return (
        <View className="gap-s3 p-s4">
          {s.help ? <Text size="secondary">{s.help}</Text> : null}
          <GuideView guide={s.guide} />
          {s.redirect ? <Text size="caption" tone="label">Redirect address to register: <Text mono size="caption" selectable>{s.redirect}</Text></Text> : null}
          {s.fields.map((x) => <Field key={x.name} label={`${x.label}${x.required ? "" : " (optional)"}`} kind={x.secret ? "password" : undefined} value={f.app[x.name] ?? ""} onChangeText={(v) => set({ app: { ...f.app, [x.name]: v }, client: "" })} />)}
          {items.length ? <><Text size="caption" tone="label">Or use an app already in the vault:</Text><ItemPick items={items} value={f.client} onChange={(client) => set({ client, app: {} })} empty="" /></> : null}
          {err}
          <View className="flex-row gap-s2"><Button kind="primary" size="sm" label={f.busy ? "Connecting" : "Use it"} disabled={f.busy} onPress={() => {
            if (f.client) { connect({ client: f.client }); return; }
            const miss = s.fields.find((x) => x.required && !(f.app[x.name] ?? "").trim());
            if (miss) { set({ error: `${miss.label} is needed.` }); return; }
            connect({ app: { client_id: (f.app.client_id ?? "").trim(), ...((f.app.client_secret ?? "").trim() ? { client_secret: f.app.client_secret.trim() } : {}) } });
          }} />{cancelBtn}</View>
        </View>
      );
    }
    return <View className="gap-s3 p-s4"><Text size="secondary">{s.step === "via" ? s.message : "Nothing more to do here."}</Text>{cancelBtn}</View>;
  };

  if (problem && !groups) return <ErrorState title="The catalog could not be read" reason={problem} retry={load} />;
  if (!groups) return <LoadingState rows={3} />;
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">Sign in to a service the way its own site does. Vyre keeps the credential in the vault and agents use it without seeing it.</Text>
      {notice ? <Banner><Text>{notice}</Text></Banner> : null}
      {groups.length ? groups.map((g) => (
        <View key={g.group} className="gap-s1">
          <Text strong size="secondary">{g.group}</Text>
          <Card flush>
            {g.presets.map((p, i) => (
              <View key={p.id}>{i ? <Divider /> : null}
                <Row title={p.label} sub={
                  <View className="gap-s1 pt-s1">
                    {p.who ? <Text size="secondary" tone="label">{p.who}</Text> : null}
                    {SETUP_WORD[p.setup] ? <Text size="caption" tone="faint">{SETUP_WORD[p.setup]}</Text> : null}
                    {p.note ? <Text size="secondary" tone="muted">{p.note}</Text> : null}
                    {p.setup === "via" && p.via && !p.connected.length ? <Text size="secondary" tone="muted">{`Comes through ${p.via}.`}</Text> : null}
                    {p.connected.map((c) => editing?.name === c.name ? (
                      <View key={c.name} className="gap-s2 pt-s2">
                        <WhoControl who={editing.who} projects={projects} onChange={(who) => setEditing({ ...editing, who, error: "" })} />
                        {editing.error ? <Text tone="muted" size="secondary">{editing.error}</Text> : null}
                        <View className="flex-row gap-s2"><Button kind="primary" size="sm" label="Save" onPress={() => {
                          const scope = scopeOf(editing.who);
                          if (scope === undefined) { setEditing({ ...editing, error: "Choose at least one project." }); return; }
                          connections.setScope(c.name, scope).then(() => { showToast(`${editing.label}: who can use it changed.`); setEditing(null); load(); }).catch((e) => setEditing({ ...editing, error: words(e) }));
                        }} /><Button kind="ghost" size="sm" label="Cancel" onPress={() => setEditing(null)} /></View>
                      </View>
                    ) : (
                      <View key={c.name} className="gap-s1 pt-s1">
                        <Text size="secondary">{`${c.label || c.name}${c.mode ? `, ${c.mode}` : ""}`}</Text>
                        <Text size="caption" tone="label">{scopeLine(c.scope)}</Text>
                        <View className="flex-row gap-s2">
                          <Button kind="ghost" size="sm" label="Who can use it" onPress={() => { needProjects(); setEditing({ name: c.name, label: c.label || c.name, who: whoFrom(c.scope), error: "" }); }} />
                          <Button kind="holdText" size="sm" label="Disconnect" onPress={() => connections.disconnect(c.name).then(() => { showToast(`${c.name} is disconnected.`); load(); }).catch((e) => showToast(words(e)))} />
                        </View>
                      </View>
                    ))}
                    {flow?.preset.id === p.id ? panel() : null}
                  </View>}
                  end={flow || (p.setup === "via" && !p.connected.length) ? null : <Button kind={p.connected.length ? "ghost" : "primary"} size="sm" label={p.connected.length ? "Add another" : "Connect"} onPress={() => start(p)} />} />
              </View>
            ))}
          </Card>
        </View>
      )) : <Card><EmptyState title="No services to add" body="Your server lists none yet." /></Card>}
    </View>
  );
}
