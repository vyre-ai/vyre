// Vault's other pages from the real vyred: Passes (with what waits for the person), Shared with you, Devices, Watchtower with the breach check, an item's history, and the
// edit and SSH sheets. Nothing here shows a value: a replaced value is typed into a field that is cleared on save, and a made one is made on the box.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Pressable } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, Icon, LoadingState, Row, Segmented, Sheet, Switch, Text, showToast, useUiTheme } from "@vyre/ui";
import { vaultMore } from "./more";
import { personLine, roleWord, vaultLine, type Person, type SharedVault, EMERGENCY_WAITS, emergencyLine, type EmergencyContact, EXPIRES, MCP_DAYS, mcpPassInput, breachLine, deviceLines, revealLine, type Reveal, healthGroups, passInput, passLine, refusalWord, revokedLine, savedLine, sshNameError, updateInput, versionLine, waitingLine, dayWord,
  type Device, type Health, type NewMcpPass, type NewPass, type Pass, type Pending } from "./more-model";
import type { ListRow } from "./real-model";

const err = (e: unknown) => e as { code?: string; message?: string };
const say = (e: unknown, done: string) => refusalWord(err(e), done);

type Props = { rows: ListRow[]; reload: () => void; openItem: (name: string) => void };

// ---- Passes ----

export function PassesPage({ rows, reload }: Props) {
  const [d, setD] = useState<{ passes: Pass[]; pending: Pending[]; reveals: Reveal[] } | null>(null);
  const [problem, setProblem] = useState("");
  const [sharing, setSharing] = useState<string[] | null>(null);
  const [offboarding, setOffboarding] = useState(false);
  const load = useCallback(() => { vaultMore.passes().then((x) => { setD(x); setProblem(""); }).catch((e) => setProblem(say(e, "loaded"))); }, []);
  useEffect(load, [load]);
  const act = (f: () => Promise<unknown>, done: string, then?: (r: unknown) => void) => f().then((r) => { showToast(done); then?.(r); load(); reload(); }).catch((e) => showToast(say(e, "done")));
  if (problem && !d) return <ErrorState title="Passes did not load" reason={problem} retry={load} />;
  if (!d) return <LoadingState rows={3} />;
  const given = d.passes.filter((p) => p.direction === "to");
  const held = d.passes.filter((p) => p.direction === "from");
  const passRow = (p: Pass) => {
    const l = passLine(p);
    return <Row key={p.id} dense title={l.title} sub={[l.sub, l.state].filter(Boolean).join(". ")}
      end={<Button kind="holdText" size="sm" label={p.direction === "from" ? "Remove" : p.state === "waiting" ? "Cancel" : "Revoke"} onPress={() => vaultMore.revokePass(p.id).then((rot) => { showToast(revokedLine(p.holder, rot)); load(); reload(); }).catch((e) => showToast(say(e, "done")))} />} />;
  };
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">A pass lets another person's Vyre use an item. Their Vyre asks yours, yours makes the call; a relayed pass never lets the value leave your server.</Text>
      {d.reveals.length ? (
        <View className="gap-s2">
          <Text strong size="secondary">{`Asking to see a value, ${d.reveals.length}`}</Text>
          <Card flush>
            {d.reveals.map((x, i) => (
              <View key={x.id}>{i ? <Divider /> : null}
                <Row title={<Text>{revealLine(x)}</Text>} sub={
                  <View className="flex-row gap-s2 pt-s1">
                    <Button size="sm" label="Allow once" onPress={() => act(() => vaultMore.allowReveal(x.id), "Allowed. They can take it once.")} />
                    <Button kind="ghost" size="sm" label="Decline" onPress={() => act(() => vaultMore.declineReveal(x.id), "Declined. Nothing was sent.")} />
                  </View>} />
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      {d.pending.length ? (
        <View className="gap-s2">
          <Text strong size="secondary">{`Waiting for you, ${d.pending.length}`}</Text>
          <Card flush>
            {d.pending.map((x, i) => (
              <View key={x.id}>{i ? <Divider /> : null}
                <Row title={<Text>{waitingLine(x)}</Text>} sub={
                  <View className="flex-row gap-s2 pt-s1">
                    <Button size="sm" label="Approve" onPress={() => act(() => vaultMore.approve(x.id), "Approved.")} />
                    <Button kind="ghost" size="sm" label="Deny" onPress={() => act(() => vaultMore.deny(x), "Denied. Nothing was shared.")} />
                  </View>} />
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-s2">
        <Button kind="primary" size="sm" icon="plus" label="New pass" disabled={!rows.length} onPress={() => setSharing([])} />
        <Button kind="ghost" size="sm" label="Offboard a person" onPress={() => setOffboarding(true)} />
      </View>
      {given.length || held.length ? <Card flush>{[...given, ...held].map((p, i) => <View key={p.id}>{i ? <Divider /> : null}{passRow(p)}</View>)}</Card>
        : <Card><EmptyState title="No passes" body="Nobody else's Vyre can use anything here." /></Card>}
      <NewPassSheet open={sharing !== null} preset={sharing ?? []} rows={rows} people={[...new Set(d.passes.map((p) => p.holder).filter(Boolean))]} onClose={() => setSharing(null)} onMade={() => { load(); reload(); }} />
      <OffboardSheet open={offboarding} people={[...new Set(given.map((p) => p.holder))]} onClose={() => setOffboarding(false)} onDone={() => { load(); reload(); }} />
    </View>
  );
}

/** A choice that is plainly on or off: filled with a check when chosen, outlined when not. */
function PickChip({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  const { color } = useUiTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} style={{ alignSelf: "flex-start" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: on ? color.accent : color["edge-strong"], backgroundColor: on ? color.accent : "transparent" }}>
        {on ? <Icon name="check" size={12} tone="accent-ink" /> : null}
        <Text size="caption" medium style={{ color: on ? color["accent-ink"] : color["text-2"] }}>{label}</Text>
      </View>
    </Pressable>
  );
}

/** One line to give an outsider: a button that copies it, over the line itself in a code box, collapsed to one row. */
function CopyLine({ label, line, extra }: { label: string; line: string; extra?: string }) {
  const { color } = useUiTheme();
  const text = extra ? `${line}\n${extra}` : line;
  return (
    <View className="gap-s2">
      <Button kind="secondary" size="sm" icon="copy" label={label} onPress={() => { Clipboard.setStringAsync(text).catch(() => {}); showToast("Copied"); }} />
      <View style={{ borderRadius: 8, borderWidth: 1, borderColor: color["edge-strong"], paddingHorizontal: 10, paddingVertical: 8 }}>
        <Text mono selectable size="caption" numberOfLines={1}>{line}</Text>
      </View>
    </View>
  );
}

function NewPassSheet({ open, preset, rows, people, onClose, onMade }: { open: boolean; preset: string[]; rows: ListRow[]; people: string[]; onClose: () => void; onMade: () => void }) {
  const blank = (): NewPass => ({ holder: "", items: preset, mode: "relayed", expires: "30d", card: "", note: "", offHosts: [] });
  const [n, setN] = useState<NewPass>(blank);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ ticket: string; pending: boolean; holder: string } | null>(null);
  const [agent, setAgent] = useState(false);
  const [apiHosts, setApiHosts] = useState<Record<string, string[]>>({});
  useEffect(() => { if (open) vaultMore.mcpItems().then((xs) => setApiHosts(Object.fromEntries(xs.map((x) => [x.name, x.hosts])))).catch(() => {}); }, [open]);
  const apiOf = (name: string) => rows.find((r) => r.name === name)?.kind === "api-credential";
  const blankMcp = (): NewMcpPass => ({ name: "", items: preset.filter((x) => apiOf(x)), days: 7, budget: "", offHosts: [], reveal: false });
  const [m, setM] = useState<NewMcpPass>(blankMcp);
  const [madeMcp, setMadeMcp] = useState<{ claude: string; codex: string; token: string; name: string } | null>(null);
  useEffect(() => { if (open) { setN(blank()); setM(blankMcp()); setProblem(""); setMade(null); setMadeMcp(null); setAgent(false); } }, [open]);
  const hostsOf = (name: string) => rows.find((r) => r.name === name)?.hosts ?? [];
  const hosts = [...new Set(n.items.flatMap(hostsOf))];
  const go = () => {
    const p = passInput(n, hostsOf);
    if ("error" in p) { setProblem(p.error); return; }
    setBusy(true); setProblem("");
    vaultMore.createPass(p.input).then((r) => { setMade({ ...r, holder: n.holder.trim() }); onMade(); }).catch((e) => setProblem(say(e, "shared"))).finally(() => setBusy(false));
  };
  const mcpHostsOf = (name: string) => apiHosts[name] ?? [];
  const mcpHosts = [...new Set(m.items.flatMap(mcpHostsOf))];
  const goMcp = () => {
    const p = mcpPassInput(m, (i) => apiHosts[i] ?? []);
    if ("error" in p) { setProblem(p.error); return; }
    setBusy(true); setProblem("");
    vaultMore.createMcpPass(p.input).then((r) => { setMadeMcp(r); onMade(); }).catch((e) => setProblem(say(e, "shared"))).finally(() => setBusy(false));
  };
  if (agent) return (
    <Sheet open={open} onClose={onClose} title={madeMcp ? "Pass made" : "New pass for an outside agent"}>
      {madeMcp ? (
        <View className="gap-s3">
          <Text>{`Give ${madeMcp.name} one of these. It is shown once and holds no key: their agent can have calls made with the credentials and never sees them.`}</Text>
          <CopyLine label="Copy for Claude Code" line={madeMcp.claude} />
          <CopyLine label="Copy for Codex" line={madeMcp.codex.split("   #")[0]} extra={madeMcp.codex.includes("export ") ? madeMcp.codex.slice(madeMcp.codex.indexOf("export ")) : ""} />
          <Button kind="primary" label="Done" onPress={onClose} />
        </View>
      ) : (
        <View className="gap-s3">
          <Segmented label="For" value="agent" onChange={(v) => { if (v === "vyre") setAgent(false); }} options={[["vyre", "Another Vyre"], ["agent", "An outside agent"]]} />
          <Field label="Name" value={m.name} onChangeText={(name) => setM({ ...m, name })} help="Who or what it is for, such as Dana's Claude." />
          <Text size="caption" strong tone="label">Ends after</Text>
          <Segmented label="Ends after" value={String(m.days)} onChange={(d) => setM({ ...m, days: Number(d) as 7 | 30 | 90 })} options={MCP_DAYS.map(([d, l]): [string, string] => [String(d), l])} />
          <View className="gap-s1">
            <Text size="caption" strong tone="label">Credentials</Text>
            <View className="flex-row flex-wrap gap-s2">{rows.filter((r) => r.kind === "api-credential").map((r) => <PickChip key={r.name} on={m.items.includes(r.name)} label={r.name} onPress={() => setM({ ...m, items: m.items.includes(r.name) ? m.items.filter((x) => x !== r.name) : [...m.items, r.name] })} />)}</View>
          </View>
          {mcpHosts.length ? (
            <View className="gap-s1">
              <Text size="caption" strong tone="label">Hosts it may call</Text>
              <View className="flex-row flex-wrap gap-s2">{mcpHosts.map((x) => <PickChip key={x} on={!m.offHosts.includes(x)} label={x} onPress={() => setM({ ...m, offHosts: m.offHosts.includes(x) ? m.offHosts.filter((y) => y !== x) : [...m.offHosts, x] })} />)}</View>
            </View>
          ) : null}
          <Field label="Call limit (optional)" value={m.budget} onChangeText={(budget) => setM({ ...m, budget })} help="How many calls the pass may make in all. Leave empty for no limit. A call that changes something still waits for you." />
          <View className="flex-row items-center gap-s3">
            <View className="flex-1 gap-s1">
              <Text strong size="secondary">May ask to see a value</Text>
              <Text size="caption" tone="muted">Their agent can ask; you approve each value once.</Text>
            </View>
            <Switch on={m.reveal} onChange={(reveal) => setM({ ...m, reveal })} label="May ask to see a value" />
          </View>
          <Text size="secondary" tone="muted">The key never leaves your server. A read runs at once; anything that changes something waits for your yes. Ending the pass stops it at once.</Text>
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <Button kind="primary" label={busy ? "Sharing" : "Share"} disabled={busy} onPress={goMcp} />
        </View>
      )}
    </Sheet>
  );
  return (
    <Sheet open={open} onClose={onClose} title={made ? "Pass made" : "New pass"}>
      {made ? (
        <View className="gap-s3">
          <Text>{made.ticket ? `Made a pass for ${made.holder}. Send them this ticket; it names the items and holds no value.` : made.pending ? `Asked. The pass to ${made.holder} waits for approval.` : `Made a pass for ${made.holder}.`}</Text>
          {made.ticket ? <Text mono selectable size="secondary">{made.ticket}</Text> : null}
          <Button kind="primary" label="Done" onPress={onClose} />
        </View>
      ) : (
        <View className="gap-s3">
          <Segmented label="For" value="vyre" onChange={(v) => { if (v === "agent") setAgent(true); }} options={[["vyre", "Another Vyre"], ["agent", "An outside agent"]]} />
          <Field label="To" value={n.holder} onChangeText={(holder) => setN({ ...n, holder })} help={people.length ? `Known: ${people.join(", ")}` : "A name for the person."} />
          <Segmented label="Ends" value={n.expires} onChange={(expires) => setN({ ...n, expires })} options={EXPIRES} />
          <Field label="Their card" value={n.card} onChangeText={(card) => setN({ ...n, card })} help="From their vyre vault card. Needed the first time; a changed card must be confirmed." />
          <View className="gap-s1">
            <Text size="caption" strong tone="label">Items</Text>
            <View className="flex-row flex-wrap gap-s2">{rows.map((r) => <Chip key={r.name} selected={n.items.includes(r.name)} onPress={() => setN({ ...n, items: n.items.includes(r.name) ? n.items.filter((x) => x !== r.name) : [...n.items, r.name] })}>{r.name}</Chip>)}</View>
          </View>
          <Segmented label="How" value={n.mode} onChange={(mode) => setN({ ...n, mode })} options={[["relayed", "Relayed"], ["sealed", "Sealed"]]} />
          {n.mode === "relayed"
            ? <Text size="secondary" tone="muted">The value never leaves your server. Revoking ends it at once.</Text>
            : <Text size="secondary" tone="warn">Revoking means rotating. An encrypted copy goes to their Vyre and stays there. To take it back you must replace the value.</Text>}
          {n.mode === "relayed" && hosts.length ? (
            <View className="gap-s1">
              <Text size="caption" strong tone="label">Hosts it may call</Text>
              <View className="flex-row flex-wrap gap-s2">{hosts.map((x) => <Chip key={x} selected={!n.offHosts.includes(x)} onPress={() => setN({ ...n, offHosts: n.offHosts.includes(x) ? n.offHosts.filter((y) => y !== x) : [...n.offHosts, x] })}>{x.replace(/^https:\/\//, "")}</Chip>)}</View>
            </View>
          ) : null}
          <Field label="Note" value={n.note} onChangeText={(note) => setN({ ...n, note })} help="What they may do with it. They see this." />
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <Button kind="primary" label={busy ? "Sharing" : "Share"} disabled={busy} onPress={go} />
        </View>
      )}
    </Sheet>
  );
}

function OffboardSheet({ open, people, onClose, onDone }: { open: boolean; people: string[]; onClose: () => void; onDone: () => void }) {
  const [who, setWho] = useState("");
  const [out, setOut] = useState<{ person: string; ended: number; rotate: string[] } | null>(null);
  const [problem, setProblem] = useState("");
  const [sure, setSure] = useState(false);
  useEffect(() => { if (open) { setWho(""); setOut(null); setProblem(""); setSure(false); } }, [open]);
  const go = () => {
    const person = who.trim();
    if (!person) { setProblem("Say who left."); return; }
    if (!sure) { setSure(true); return; }
    vaultMore.offboard(person).then((r) => { setOut({ person, ...r }); onDone(); }).catch((e) => setProblem(say(e, "done")));
  };
  return (
    <Sheet open={open} onClose={onClose} title="Offboard a person">
      {out ? (
        <View className="gap-s2">
          <Text>{`${out.person} holds nothing here now. Ended ${out.ended} ${out.ended === 1 ? "pass" : "passes"}.`}</Text>
          {out.rotate.length ? <><Text strong size="secondary">Rotate these</Text>{out.rotate.map((n) => <Text key={n}>{n}</Text>)}<Text size="caption" tone="label">They had a sealed copy of each. Replace each value to finish.</Text></>
            : <Text tone="muted">Nothing to rotate. Every pass they held was relayed.</Text>}
          <Button kind="primary" label="Done" onPress={onClose} />
        </View>
      ) : (
        <View className="gap-s3">
          <Text tone="muted">Ends every pass a person holds, forgets their card, and lists what must be rotated. One action, and it cannot be undone.</Text>
          <Field label="Who left" value={who} onChangeText={(v) => { setWho(v); setSure(false); }} />
          {people.length ? <View className="flex-row flex-wrap gap-s2">{people.map((p) => <Chip key={p} onPress={() => { setWho(p); setSure(false); }}>{p}</Chip>)}</View> : null}
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <View className="flex-row gap-s2"><Button kind="primary" label={sure ? "Offboard now" : "Offboard"} onPress={go} /><Button kind="ghost" label="Cancel" onPress={onClose} /></View>
        </View>
      )}
    </Sheet>
  );
}

// ---- Shared with you ----

export function SharedPage({ reload }: Props) {
  const [held, setHeld] = useState<Pass[] | null>(null);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => { vaultMore.passes().then((x) => { setHeld(x.passes.filter((p) => p.direction === "from")); setProblem(""); }).catch((e) => setProblem(say(e, "loaded"))); }, []);
  useEffect(load, [load]);
  if (problem && !held) return <ErrorState title="Shared items did not load" reason={problem} retry={load} />;
  if (!held) return <LoadingState rows={2} />;
  return (
    <View className="gap-s2 pt-s2">
      {held.length ? <Card flush>{held.map((p, i) => {
        const l = passLine(p);
        return <View key={p.id}>{i ? <Divider /> : null}<Row dense title={l.title} sub={[l.sub, l.state].filter(Boolean).join(". ")} end={<Button kind="holdText" size="sm" label="Remove" onPress={() => vaultMore.revokePass(p.id).then(() => { showToast("Removed."); load(); reload(); }).catch((e) => showToast(say(e, "done")))} />} /></View>;
      })}</Card> : <Card><EmptyState title="Nothing shared with you" body="When someone shares something, paste their ticket with vyre vault pass accept." /></Card>}
      <Text size="caption" tone="label">Your agents use these with vault.relay. Their box adds the value; it never reaches yours.</Text>
      <SharedVaultsSection />
      <EmergencySection reload={reload} />
    </View>
  );
}

// ---- Shared vaults and people ----

/** The vaults shared with others and the people Vyre shares with, from names only. Reading is here; making and changing a shared vault is at the command line until the app may ask for it. */
export function SharedVaultsSection() {
  const [vaults, setVaults] = useState<SharedVault[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => { vaultMore.sharedVaults().then(setVaults).catch(() => setVaults([])); vaultMore.people().then(setPeople).catch(() => setPeople([])); }, []);
  if (!vaults || (!vaults.length && !people.length)) return null;
  return (
    <View className="gap-s2 pt-s4">
      <Text strong size="secondary">Shared vaults</Text>
      {vaults.length ? vaults.map((v) => (
        <Card key={v.id} title={v.name}>
          <View className="gap-s2">
            <Text size="secondary" tone="label">{vaultLine(v)}</Text>
            {v.members.map((m) => <Row key={m.name} dense title={m.name} sub={`${roleWord(m.role)}${m.fingerprint ? `, ${m.fingerprint}` : ""}`} />)}
          </View>
        </Card>
      )) : <Text size="secondary" tone="label">None yet. Make one with vyre vault vaults create.</Text>}
      {people.length ? <><Text strong size="secondary">People you share with</Text><Card flush>{people.map((p, i) => <View key={p.name}>{i ? <Divider /> : null}<Row dense title={p.name} sub={personLine(p)} /></View>)}</Card></> : null}
    </View>
  );
}

// ---- Emergency access ----

/**
 * Emergency access (R032-12): a person you trust may ask, and after the wait the items open to them unless you deny it. This lists who can ask and where each request stands, with Deny while one
 * waits and Remove at any time (taking access away never needs a yes), and adds a contact with a wait of 1 to 30 days. Adding and rebuilding are the person's own yes at the vault's floor.
 */
export function EmergencySection({ reload }: { reload: () => void }) {
  const [list, setList] = useState<EmergencyContact[] | null>(null);
  const [problem, setProblem] = useState("");
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => { vaultMore.emergency().then((x) => { setList(x); setProblem(""); }).catch((e) => setProblem(say(e, "loaded"))); }, []);
  useEffect(load, [load]);
  const act = (f: () => Promise<unknown>, done: string) => f().then(() => { showToast(done); load(); reload(); }).catch((e) => showToast(say(e, "done")));
  return (
    <>
      <EmergencyView list={list} problem={problem} onDeny={(c) => act(() => vaultMore.emergencyDeny(c.person), "Denied. Nothing was opened.")} onRemove={(c) => act(() => vaultMore.emergencyRemove(c.person), "Removed. Their access is gone.")}
        onRefresh={() => act(() => vaultMore.emergencyRefresh(), "Sealed again with what is in the vault now.")} onAdd={() => setAdding(true)} />
      <AddEmergencySheet open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); reload(); }} />
    </>
  );
}

/** The list and its actions, from what it is given: the section above reads the box, the gallery gives it a sample. */
export function EmergencyView({ list, problem, onDeny, onRemove, onRefresh, onAdd }: { list: EmergencyContact[] | null; problem: string; onDeny: (c: EmergencyContact) => void; onRemove: (c: EmergencyContact) => void; onRefresh: () => void; onAdd: () => void }) {
  const phone = useUiTheme().phone, size = phone ? "md" : "sm";
  return (
    <View className="gap-s2 pt-s4">
      <Text strong size="secondary">Emergency access</Text>
      <Text size="caption" tone="label">Someone you trust can ask. After the wait, the items open to them unless you deny it. They are never shown the values until it opens.</Text>
      {problem && !list ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      {list && list.length ? <Card flush>{list.map((c, i) => {
        const l = emergencyLine(c);
        const buttons = <View className="flex-row gap-s1">
          {l.canDeny ? <Button size={size} label="Deny" onPress={() => onDeny(c)} /> : null}
          <Button kind="holdText" size={size} label="Remove" onPress={() => onRemove(c)} />
        </View>;
        // A phone has no room beside the words: the actions sit under them.
        return <View key={c.person}>{i ? <Divider /> : null}{phone
          ? <Row dense title={l.title} sub={<View className="gap-s1"><Text size="secondary" tone="label">{l.sub}</Text>{buttons}</View>} />
          : <Row dense title={l.title} sub={l.sub} end={buttons} />}</View>;
      })}</Card> : list ? <Card><EmptyState title="No one yet" body="Add someone you trust, and give them a wait you are comfortable with." /></Card> : null}
      <View className="flex-row gap-s2 self-start">
        <Button kind="primary" label="Add someone" onPress={onAdd} />
        {list && list.length ? <Button kind="ghost" label="Rebuild" onPress={onRefresh} /> : null}
      </View>
    </View>
  );
}

function AddEmergencySheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [who, setWho] = useState("");
  const [wait, setWait] = useState("7d");
  const [problem, setProblem] = useState("");
  useEffect(() => { if (open) { setWho(""); setWait("7d"); setProblem(""); } }, [open]);
  const go = () => {
    const person = who.trim();
    if (!person) { setProblem("Say who."); return; }
    vaultMore.emergencyAdd(person, wait).then(() => { showToast(`${person} can ask for emergency access.`); onDone(); }).catch((e) => setProblem(say(e, "done")));
  };
  return (
    <Sheet open={open} onClose={onClose} title="Emergency access for someone">
      <View className="gap-s3">
        <Text tone="muted">They must be someone whose card you have already checked. They can ask at any time; you can deny it during the wait.</Text>
        <Field label="Who" value={who} onChangeText={setWho} />
        <Segmented label="Wait" value={wait} onChange={setWait} options={EMERGENCY_WAITS} />
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <View className="flex-row gap-s2"><Button kind="primary" label="Add" onPress={go} /><Button kind="ghost" label="Cancel" onPress={onClose} /></View>
      </View>
    </Sheet>
  );
}

// ---- Devices ----

export function DevicesPage(_: Props) {
  const [list, setList] = useState<Device[] | null>(null);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => { vaultMore.devices().then((x) => { setList(x); setProblem(""); }).catch((e) => setProblem(say(e, "loaded"))); }, []);
  useEffect(load, [load]);
  if (problem && !list) return <ErrorState title="Devices did not load" reason={problem} retry={load} />;
  if (!list) return <LoadingState rows={2} />;
  return (
    <View className="gap-s2 pt-s2">
      {list.length ? <Card flush>{list.map((d, i) => {
        const l = deviceLines(d, Date.now());
        return <View key={d.id}>{i ? <Divider /> : null}<Row dense title={d.name} sub={[l.sub, l.sessions].filter(Boolean).join(". ")}
          end={d.revoked ? null : <Button kind="holdText" size="sm" label="Revoke" onPress={() => vaultMore.revokeDevice(d.id).then(() => { showToast(`${d.name} can no longer fill. Its sessions ended.`); load(); }).catch((e) => showToast(say(e, "done")))} />} /></View>;
      })}</Card> : <Card><EmptyState title="No browser is paired" body="Pair one from the extension; vyre vault pair shows the code." /></Card>}
      <Text size="caption" tone="label">A paired browser fills only on pages whose origin matches an item, and only while unlocked.</Text>
    </View>
  );
}

// ---- Watchtower ----

export function WatchtowerPage({ openItem }: Props) {
  const [h, setH] = useState<Health | null>(null);
  const [problem, setProblem] = useState("");
  const [caps, setCaps] = useState<{ breach: "ask" | "off" } | null>(null);
  const [breach, setBreach] = useState<{ line: string; names: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback(() => { vaultMore.health().then((x) => { setH(x); setProblem(""); }).catch((e) => setProblem(say(e, "loaded"))); vaultMore.caps().then(setCaps).catch(() => {}); }, []);
  useEffect(load, [load]);
  if (problem && !h) return <ErrorState title="Watchtower did not load" reason={problem} retry={load} />;
  if (!h) return <LoadingState rows={3} />;
  const groups = healthGroups(h);
  const check = () => {
    setChecking(true); setBreach(null);
    vaultMore.breachCheck().then((b) => setBreach({ line: breachLine(b), names: b.breached })).catch((e) => setBreach({ line: say(e, "checked"), names: [] })).finally(() => setChecking(false));
  };
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">Checked on your server against the sealed values. Only names and reasons come back to this page.</Text>
      {groups.length ? groups.map((g) => (
        <View key={g.code} className="gap-s1">
          <Text strong size="secondary">{g.title}</Text>
          <Text size="caption" tone="label">{g.why}</Text>
          <Card flush>{g.rows.map((r, i) => <View key={r.name}>{i ? <Divider /> : null}<Row dense title={r.name} sub={r.others.length ? `Same value as ${r.others.join(", ")}` : undefined} onPress={() => openItem(r.name)} /></View>)}</Card>
        </View>
      )) : <Card><EmptyState title="Nothing to fix" body={`${h.checked} ${h.checked === 1 ? "item" : "items"} checked on your server.`} /></Card>}
      <View className="gap-s2 pt-s2">
        <Text strong size="secondary">Known breaches</Text>
        <Text size="secondary" tone="muted">A network call, and off unless you allow it. It sends the first 5 characters of each password's SHA-1 to api.pwnedpasswords.com, with padding, and compares the rest here. No password and no full hash leaves.</Text>
        <View className="self-start"><Button kind="primary" size="sm" label={checking ? "Checking" : "Check now"} disabled={checking || caps?.breach !== "ask"} onPress={check} /></View>
        {caps && caps.breach !== "ask" ? <Text size="caption" tone="label">Off. To allow it, set vault.breach to "ask" in config.json; every check still asks you first.</Text> : null}
        {breach ? <><Text>{breach.line}</Text>{breach.names.map((n) => <Row key={n} dense title={n} onPress={() => openItem(n)} />)}</> : null}
      </View>
    </View>
  );
}

// ---- one item: history, edit ----

export function ItemHistory({ name }: { name: string }) {
  const [h, setH] = useState<Awaited<ReturnType<typeof vaultMore.history>> | undefined>(undefined);
  useEffect(() => { setH(undefined); vaultMore.history(name).then(setH).catch(() => setH(null)); }, [name]);
  if (!h || (!h.versions.length && !h.earlier)) return null;
  return (
    <View className="gap-s1">
      <Text size="caption" strong tone="label">History</Text>
      {h.versions.slice(0, 6).map((v) => <Text key={v.ver + ":" + v.at} size="secondary">{versionLine(v)}</Text>)}
      {h.earlier ? <Text size="caption" tone="label">{`${h.earlier.count} earlier ${h.earlier.count === 1 ? "password" : "passwords"}, the last replaced ${dayWord(h.earlier.last)}. Kept sealed, never shown.`}</Text> : null}
    </View>
  );
}

/** The fields a new one can be made for on the box. */
const MAKEABLE = ["password", "value", "key"];

export function EditSheet({ item, onClose, onSaved }: { item: { name: string; description: string; fields: string[] } | null; onClose: () => void; onSaved: () => void }) {
  const [desc, setDesc] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [make, setMake] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDesc(item?.description ?? ""); setTyped({}); setMake(null); setProblem(""); }, [item?.name]);
  if (!item) return null;
  const save = () => {
    const u = updateInput({ name: item.name, description: desc, was: item.description, replace: typed, generate: make ? { field: make, length: 24, symbols: true } : null });
    if ("error" in u) { setProblem(u.error); return; }
    setBusy(true); setProblem("");
    vaultMore.update(u.input).then((r) => { setTyped({}); showToast(savedLine(item.name, r.generated)); onSaved(); onClose(); }).catch((e) => setProblem(say(e, "saved"))).finally(() => setBusy(false));
  };
  return (
    <Sheet open onClose={onClose} title={`Change ${item.name}`}>
      <View className="gap-s3">
        <Field label="Description" value={desc} onChangeText={setDesc} />
        {item.fields.map((f) => (
          <View key={f} className="gap-s1">
            <Field label={`New ${f}`} kind="password" value={typed[f] ?? ""} onChangeText={(v) => setTyped({ ...typed, [f]: v })} help="Leave empty to keep it exactly as it is. Nothing is shown to fill in." />
            {MAKEABLE.includes(f) ? <View className="self-start"><Chip selected={make === f} onPress={() => setMake(make === f ? null : f)}>Make a new one on my server</Chip></View> : null}
          </View>
        ))}
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <Button kind="primary" label={busy ? "Saving" : "Save"} disabled={busy} onPress={save} />
        <Text size="caption" tone="label">The box may ask you to approve this save. Assistants never see the value.</Text>
      </View>
    </Sheet>
  );
}

export function SshSheet({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade: () => void }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(""); setDesc(""); setProblem(""); } }, [open]);
  const go = () => {
    const bad = sshNameError(name.trim());
    if (bad) { setProblem(bad); return; }
    setBusy(true); setProblem("");
    vaultMore.sshGenerate(name.trim(), desc).then(() => { showToast(`Made ${name.trim()} on your server. Its public half is on the item.`); onMade(); onClose(); }).catch((e) => setProblem(say(e, "made"))).finally(() => setBusy(false));
  };
  return (
    <Sheet open={open} onClose={onClose} title="Make an SSH key">
      <View className="gap-s3">
        <Text tone="muted">Makes an ed25519 key on your server. The private half never leaves it; you get the public half to paste into GitHub or a server.</Text>
        <Field label="Name" value={name} onChangeText={setName} placeholder="deploy-key" />
        <Field label="Description" value={desc} onChangeText={setDesc} />
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <Button kind="primary" label={busy ? "Making" : "Make the key"} disabled={busy} onPress={go} />
      </View>
    </Sheet>
  );
}
