// The Connect apps screen on the real box: the catalog (connectors.catalog, and mcp.catalog for the one-click rows it knows beyond that) as the library's rows. Add signs in at once; Set up opens one
// sheet for what the box asks next (a token, the vendor's own app, or the sign-in page to approve); a connected row's menu opens Share with... (the connection's Vault item, vault.access.get and
// vault.access.set) and Disconnect. All of it goes through the kernel's tools, the same ones the MCP surface has. A secret typed here goes to the box once and is not kept (model.ts words redacts it).
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, ConnectApps, ErrorState, Field, LoadingState, Sheet, ShareSheet, Text, showToast, type ConnectApp } from "@vyre/ui";
import { connections } from "./source-real";
import { scopeOf, words, type Preset, type Step } from "./model";
import { appsOf, extraApps, granteesOf, inputOf, itemOfConnection, missing, shareChanges, sharesOf, sheetOf, memberGrantees, memberSharesOf } from "./connect-apps-model.js";
import { GuideView, openUrl, usePoll } from "./shared";

type Flow = { app: ConnectApp; preset: Preset; step: Step | null; values: Record<string, string>; busy: boolean; error: string };
type Grantee = { who: string; subject: string; kind: "person" | "agent" };

export default function RealConnectApps() {
  const [groups, setGroups] = useState<{ group: string; presets: Preset[] }[] | null>(null);
  const [shares, setShares] = useState<Record<string, ConnectApp["shares"]>>({});
  const [problem, setProblem] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [sharing, setSharing] = useState<{ app: ConnectApp; item: string; grantees: Grantee[]; held: { subject: string }[]; member: boolean } | null>(null);
  const [notice, setNotice] = useState("");
  const [entries, setEntries] = useState<unknown[]>([]);
  const load = useCallback(() => {
    connections.catalog().then((g) => { setGroups(g); setProblem(""); }).catch((e) => setProblem(words(e)));
    connections.oneClickEntries().then(setEntries).catch(() => setEntries([]));
  }, []);
  useEffect(load, [load]);

  const presets = (groups ?? []).flatMap((g) => g.presets);
  const curated = appsOf(groups ?? [], shares) as ConnectApp[];
  const more = extraApps(entries, curated) as ConnectApp[];
  const apps = [...curated, ...more];
  // A one-click row the catalog found has no curated preset: the box makes it from the entry when asked to connect it by id.
  const presetOf = (a: ConnectApp): Preset | null => presets.find((p) => p.id === a.id) ?? (more.some((m) => m.id === a.id) ? { id: a.id, label: a.name, group: a.category, who: "", note: a.blurb, setup: "none", via: "", connected: [] } as unknown as Preset : null);

  const open = flow?.step?.step === "open";
  usePoll(open, () => connections.catalog().then((g) => {
    setGroups(g);
    const now = g.flatMap((x) => x.presets).find((p) => p.id === flow?.preset.id);
    if (now && flow && now.connected.length > flow.preset.connected.length) { setNotice(`${now.label} is connected.`); setFlow(null); }
  }).catch(() => {}));

  const connect = (f: Flow, input: Record<string, unknown> = {}) => {
    const scope = scopeOf({ mode: "me", projects: [] });
    setFlow({ ...f, busy: true, error: "" });
    connections.connect(f.preset.id, f.preset.label, { ...(scope ? { scope } : {}), ...input }).then((step) => {
      if (step.step === "connected") { setNotice(step.line); setFlow(null); load(); return; }
      if (step.step === "open" && step.url) openUrl(step.url);
      if (step.step === "via" || step.step === "none") { setFlow({ ...f, busy: false, step: null, error: step.step === "via" ? step.message : "That app cannot be added from here." }); return; }
      setFlow({ ...f, busy: false, step, values: {}, error: "" });
    }).catch((e) => setFlow((cur) => (cur ? { ...cur, busy: false, error: words(e, Object.values(f.values)) } : cur)));
  };
  const add = (a: ConnectApp) => {
    const preset = presetOf(a);
    if (!preset) return;
    setNotice("");
    connect({ app: a, preset, step: null, values: {}, busy: false, error: "" });
  };
  const cancel = () => { const f = flow; setFlow(null); if (f?.step?.step === "open") connections.connectCancel(f.step.id).catch(() => {}); };
  const live = useRef(flow);
  live.current = flow;
  useEffect(() => () => { const s = live.current?.step; if (s?.step === "open") connections.connectCancel(s.id).catch(() => {}); }, []);

  const startShare = (a: ConnectApp) => {
    const conn = (a as ConnectApp & { connection?: string }).connection;
    if (!conn) return;
    const item = itemOfConnection({ name: conn });
    // The owner shares the connection's Vault item; a member, who has no access to the owner's Vault, shares her own connection (Fill in only).
    connections.agentList().catch(() => []).then(async (agents) => {
      try {
        const got = await connections.shareGet(item);
        setShares((s) => ({ ...s, [conn]: sharesOf(got, agents) }));
        setSharing({ app: a, item, grantees: granteesOf(got, agents), held: sharesOf(got, agents), member: false });
      } catch {
        const held = memberSharesOf(await connections.memberShareGet(conn), agents);
        setShares((s) => ({ ...s, [conn]: held }));
        setSharing({ app: a, item: conn, grantees: memberGrantees(held, agents), held, member: true });
      }
    }).catch((e) => setNotice(words(e)));
  };
  const changeShares = async (next: ConnectApp["shares"]) => {
    if (!sharing) return;
    const conn = (sharing.app as ConnectApp & { connection?: string }).connection ?? "";
    try {
      for (const input of shareChanges(sharing.item, shares[conn] ?? [], next, sharing.grantees)) await (sharing.member ? connections.memberShareSet(input) : connections.shareSet(input));
      setShares((s) => ({ ...s, [conn]: next }));
    } catch (e) { setNotice(words(e)); startShare(sharing.app); }
  };
  const disconnect = (a: ConnectApp) => {
    const conn = (a as ConnectApp & { connection?: string }).connection;
    if (conn) connections.disconnect(conn).then(() => { showToast(`${a.name} is disconnected.`); load(); }).catch((e) => setNotice(words(e)));
  };

  if (problem) return <ErrorState title="The catalog could not be read" reason={problem} retry={load} />;
  if (!groups) return <LoadingState />;
  const sheet = flow?.step ? sheetOf({ step: flow.step }) : null;
  const set = (name: string, v: string) => flow && setFlow({ ...flow, values: { ...flow.values, [name]: v } });
  return (
    <View style={{ gap: 12 }}>
      {notice ? <Banner><Text>{notice}</Text></Banner> : null}
      {flow && !flow.step && flow.error ? <Banner><Text>{flow.error}</Text></Banner> : null}
      <Card>
        <ConnectApps apps={apps.map((a) => (flow && flow.app.id === a.id && flow.busy ? { ...a, busy: true } : a))} query={query} onQuery={setQuery} category={category} onCategory={setCategory} onAdd={add}
          menuOf={(a) => [{ label: "Share with...", onPress: () => startShare(a) }, { label: "Disconnect", danger: true, onPress: () => disconnect(a) }]} />
      </Card>
      <Sheet open={!!sheet} onClose={cancel} title={sheet ? (sheet.kind === "signin" ? `Sign in to ${flow!.app.name}` : `Set up ${flow!.app.name}`) : ""}>
        {sheet && flow ? (
          <View style={{ gap: 12 }}>
            {sheet.help ? <Text>{sheet.help}</Text> : null}
            {sheet.kind === "client" && sheet.redirect ? <Text size="caption" tone="label">{`Redirect address: ${sheet.redirect}`}</Text> : null}
            <GuideView guide={sheet.guide} />
            {sheet.kind === "signin" ? (
              <>
                {sheet.url ? <View style={{ alignSelf: "flex-start" }}><Button label="Open the sign-in page" onPress={() => openUrl(sheet.url!)} /></View> : null}
                <Text size="caption" tone="label">Signing in on a different browser? Paste the address it ends on.</Text>
                <Field label="Address the page ended on" value={flow.values.paste ?? ""} onChangeText={(v) => set("paste", v)} placeholder="http://127.0.0.1:…/callback?code=…" />
              </>
            ) : sheet.fields.map((f) => <Field key={f.name} label={`${f.label}${f.required ? "" : " (optional)"}`} kind={f.secret ? "password" : undefined} value={flow.values[f.name] ?? ""} onChangeText={(v) => set(f.name, v)} />)}
            {flow.error ? <Text tone="muted" size="secondary">{flow.error}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
              <Button kind="ghost" label="Cancel" onPress={cancel} />
              <Button kind="primary" label={flow.busy ? "Working" : sheet.kind === "signin" ? "Finish" : "Connect"} disabled={flow.busy} onPress={() => {
                if (sheet.kind === "signin") {
                  const url = (flow.values.paste ?? "").trim();
                  const s = flow.step;
                  if (!url || !s || s.step !== "open") { setFlow({ ...flow, error: "Paste the address the page ended on." }); return; }
                  setFlow({ ...flow, busy: true, error: "" });
                  connections.connectFinish(s.id, url).then(() => { setFlow(null); load(); }).catch((e) => setFlow((cur) => (cur ? { ...cur, busy: false, error: words(e) } : cur)));
                  return;
                }
                const m = missing(sheet, flow.values);
                if (m) { setFlow({ ...flow, error: m }); return; }
                connect(flow, inputOf(sheet, flow.values));
              }} />
            </View>
          </View>
        ) : null}
      </Sheet>
      <ShareSheet app={sharing?.app ?? null} grantees={sharing?.grantees ?? []} open={sharing !== null} onClose={() => setSharing(null)} onChange={(n) => void changeShares(n)} fillOnly={sharing?.member} />
    </View>
  );
}
