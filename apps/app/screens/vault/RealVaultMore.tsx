// Vault's other pages from the real vyred: Sharing (what you share, what is shared with you, shared vaults, emergency access), Browsers, Health with the breach check, an item's history, and the
// edit and SSH sheets. Nothing here shows a value: a replaced value is typed into a field that is cleared on save, and a made one is made on the box.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Pressable } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Chip, Divider, EmptyState, ErrorState, Field, Icon, LoadingState, Menu, Row, Segmented, Sheet, Switch, Text, comingSoon, showToast, useUiTheme } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { vaultMore } from "./more";
import { INVITE_ROLES, ROLE_HELP, acceptKind, inviteInput, newVaultInput, personLine, removedLine, roleWord, vaultLine, type Person, type SharedVault, EMERGENCY_WAITS, emergencyLine, type EmergencyContact, EXPIRES, MCP_DAYS, mcpPassInput, breachLine, deviceLines, revealLine, type Reveal, healthGroups, passInput, passLine, refusalWord, revokedLine, savedLine, sshNameError, updateInput, versionLine, waitingLine, dayWord,
  type Device, type Health, type NewMcpPass, type NewPass, type Pass, type Pending } from "./more-model";
import type { ListRow } from "./real-model";

/** A small button is 36 high, and a phone needs 44: the same button, medium there. */
const useSmall = (): "sm" | "md" => (useUiTheme().phone ? "md" : "sm");
const err = (e: unknown) => e as { code?: string; message?: string };
const say = (e: unknown, done: string) => refusalWord(err(e), done);

type Props = { rows: ListRow[]; reload: () => void; openItem: (name: string) => void };

// ---- Shared by you ----

export function PassesPage({ rows, reload }: Props) {
  const sm = useSmall();
  const [d, setD] = useState<{ passes: Pass[]; pending: Pending[]; reveals: Reveal[] } | null>(null);
  const [problem, setProblem] = useState("");
  const [sharing, setSharing] = useState<string[] | null>(null);
  const [offboarding, setOffboarding] = useState(false);
  const load = useCallback(() => { vaultMore.passes().then((x) => { setD(x); setProblem(""); }).catch((e) => setProblem(say(e, "loaded"))); }, []);
  useEffect(load, [load]);
  const act = (f: () => Promise<unknown>, done: string, then?: (r: unknown) => void) => f().then((r) => { showToast(done); then?.(r); load(); reload(); }).catch((e) => showToast(say(e, "done")));
  if (problem && !d) return <ErrorState title="Sharing did not load" reason={problem} retry={load} />;
  if (!d) return <LoadingState rows={3} />;
  const given = d.passes.filter((p) => p.direction === "to");
  const passRow = (p: Pass) => {
    const l = passLine(p);
    return <Row key={p.id} dense title={l.title} sub={[l.sub, l.state].filter(Boolean).join(". ")}
      end={<Button kind="holdText" size={sm} label={p.direction === "from" ? "Remove" : p.state === "waiting" ? "Cancel" : "Stop sharing"} onPress={() => vaultMore.revokePass(p.id).then((rot) => { showToast(revokedLine(p.holder, rot)); load(); reload(); }).catch((e) => showToast(say(e, "done")))} />} />;
  };
  return (
    <View className="gap-s3 pt-s2">
      {d.reveals.length ? (
        <View className="gap-s2">
          <Text strong size="secondary">{`Asking to see a value, ${d.reveals.length}`}</Text>
          <Card flush>
            {d.reveals.map((x, i) => (
              <View key={x.id}>{i ? <Divider /> : null}
                <Row title={<Text>{revealLine(x)}</Text>} sub={
                  <View className="flex-row gap-s2 pt-s1">
                    <Button size={sm} label="Allow once" onPress={() => act(() => vaultMore.allowReveal(x.id), "Allowed. They can take it once.")} />
                    <Button kind="ghost" size={sm} label="Decline" onPress={() => act(() => vaultMore.declineReveal(x.id), "Declined. Nothing was sent.")} />
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
                    <Button size={sm} label="Approve" onPress={() => act(() => vaultMore.approve(x.id), "Approved.")} />
                    <Button kind="ghost" size={sm} label="Deny" onPress={() => act(() => vaultMore.deny(x), "Denied. Nothing was shared.")} />
                  </View>} />
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      <Sec title="Shared by you">
        <View className="gap-s2">
          <Text tone="muted" size="secondary">Let another person's Vyre, or an outside agent, use an item. They use it and never see the value.</Text>
          <View className="flex-row flex-wrap gap-s2">
            <Button kind="primary" size={sm} icon="plus" label="Share an item" disabled={!rows.length} onPress={() => setSharing([])} />
            <Button kind="ghost" size={sm} label="Someone left" onPress={() => setOffboarding(true)} />
          </View>
          {given.length ? <Card flush>{given.map((p, i) => <View key={p.id}>{i ? <Divider /> : null}{passRow(p)}</View>)}</Card>
            : <Text tone="muted">Nothing shared yet. Nobody else can use anything in this vault.</Text>}
        </View>
      </Sec>
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
  const sm = useSmall();
  const { color } = useUiTheme();
  const text = extra ? `${line}\n${extra}` : line;
  return (
    <View className="gap-s2">
      <Button kind="secondary" size={sm} icon="copy" label={label} onPress={() => { Clipboard.setStringAsync(text).catch(() => {}); showToast("Copied"); }} />
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
    <Sheet open={open} onClose={onClose} title={madeMcp ? "Shared" : "Share with an outside agent"}>
      {madeMcp ? (
        <View className="gap-s3">
          <Text>{`Give ${madeMcp.name} one of these. It is shown once and holds no key. Their agent can use the items and never sees them.`}</Text>
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
            <Text size="caption" strong tone="label">Items</Text>
            <View className="flex-row flex-wrap gap-s2">{rows.filter((r) => r.kind === "api-credential").map((r) => <PickChip key={r.name} on={m.items.includes(r.name)} label={r.name} onPress={() => setM({ ...m, items: m.items.includes(r.name) ? m.items.filter((x) => x !== r.name) : [...m.items, r.name] })} />)}</View>
          </View>
          {mcpHosts.length ? (
            <View className="gap-s1">
              <Text size="caption" strong tone="label">Sites it may reach</Text>
              <View className="flex-row flex-wrap gap-s2">{mcpHosts.map((x) => <PickChip key={x} on={!m.offHosts.includes(x)} label={x} onPress={() => setM({ ...m, offHosts: m.offHosts.includes(x) ? m.offHosts.filter((y) => y !== x) : [...m.offHosts, x] })} />)}</View>
            </View>
          ) : null}
          <Field label="Call limit (optional)" value={m.budget} onChangeText={(budget) => setM({ ...m, budget })} help="How many calls it may make in all. Leave empty for no limit. A call that changes something still waits for you." />
          <View className="flex-row items-center gap-s3">
            <View className="flex-1 gap-s1">
              <Text strong size="secondary">May ask to see a value</Text>
              <Text size="caption" tone="muted">Their agent can ask; you approve each value once.</Text>
            </View>
            <Switch on={m.reveal} onChange={(reveal) => setM({ ...m, reveal })} label="May ask to see a value" />
          </View>
          <Text size="secondary" tone="muted">The key stays on your server. Reads run at once; anything that changes something waits for your yes. Stopping the share ends it at once.</Text>
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <Button kind="primary" label={busy ? "Sharing" : "Share"} disabled={busy} onPress={goMcp} />
        </View>
      )}
    </Sheet>
  );
  return (
    <Sheet open={open} onClose={onClose} title={made ? "Shared" : "Share an item"}>
      {made ? (
        <View className="gap-s3">
          <Text>{made.ticket ? `Shared with ${made.holder}. Send them this code. It names the items and holds no value.` : made.pending ? `Asked. Sharing with ${made.holder} waits for approval.` : `Shared with ${made.holder}.`}</Text>
          {made.ticket ? <Text mono selectable size="secondary">{made.ticket}</Text> : null}
          <Button kind="primary" label="Done" onPress={onClose} />
        </View>
      ) : (
        <View className="gap-s3">
          <Segmented label="For" value="vyre" onChange={(v) => { if (v === "agent") setAgent(true); }} options={[["vyre", "Another Vyre"], ["agent", "An outside agent"]]} />
          <Field label="To" value={n.holder} onChangeText={(holder) => setN({ ...n, holder })} help={people.length ? `Known: ${people.join(", ")}` : "A name for the person."} />
          <Segmented label="Ends" value={n.expires} onChange={(expires) => setN({ ...n, expires })} options={EXPIRES} />
          <Field label="Their Vyre card" value={n.card} onChangeText={(card) => setN({ ...n, card })} help="They send it from their own Vyre. Needed the first time." />
          <View className="gap-s1">
            <Text size="caption" strong tone="label">Items</Text>
            <View className="flex-row flex-wrap gap-s2">{rows.map((r) => <Chip key={r.name} selected={n.items.includes(r.name)} onPress={() => setN({ ...n, items: n.items.includes(r.name) ? n.items.filter((x) => x !== r.name) : [...n.items, r.name] })}>{r.name}</Chip>)}</View>
          </View>
          <Segmented label="How" value={n.mode} onChange={(mode) => setN({ ...n, mode })} options={[["relayed", "Stays on my server"], ["sealed", "Send a copy"]]} />
          {n.mode === "relayed"
            ? <Text size="secondary" tone="muted">The value never leaves your server. Stopping the share ends it at once.</Text>
            : <Text size="secondary" tone="warn">An encrypted copy goes to their Vyre and stays there. To take it back, you replace the value.</Text>}
          {n.mode === "relayed" && hosts.length ? (
            <View className="gap-s1">
              <Text size="caption" strong tone="label">Sites it may reach</Text>
              <View className="flex-row flex-wrap gap-s2">{hosts.map((x) => <Chip key={x} selected={!n.offHosts.includes(x)} onPress={() => setN({ ...n, offHosts: n.offHosts.includes(x) ? n.offHosts.filter((y) => y !== x) : [...n.offHosts, x] })}>{x.replace(/^https:\/\//, "")}</Chip>)}</View>
            </View>
          ) : null}
          <Field label="Note (optional)" value={n.note} onChangeText={(note) => setN({ ...n, note })} help="What they may do with it. They see this." />
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
    <Sheet open={open} onClose={onClose} title="Someone left">
      {out ? (
        <View className="gap-s2">
          <Text>{`${out.person} holds nothing here now. Stopped ${out.ended} ${out.ended === 1 ? "share" : "shares"}.`}</Text>
          {out.rotate.length ? <><Text strong size="secondary">Replace these</Text>{out.rotate.map((n) => <Text key={n}>{n}</Text>)}<Text size="caption" tone="label">They kept a copy of each. Replace each value to finish.</Text></>
            : <Text tone="muted">Nothing to replace. Everything they had stayed on your server.</Text>}
          <Button kind="primary" label="Done" onPress={onClose} />
        </View>
      ) : (
        <View className="gap-s3">
          <Text tone="muted">Stops everything shared with them and lists what to replace. It cannot be undone.</Text>
          <Field label="Who" value={who} onChangeText={(v) => { setWho(v); setSure(false); }} />
          {people.length ? <View className="flex-row flex-wrap gap-s2">{people.map((p) => <Chip key={p} onPress={() => { setWho(p); setSure(false); }}>{p}</Chip>)}</View> : null}
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <View className="flex-row gap-s2"><Button kind="primary" label={sure ? "Stop their access now" : "Stop their access"} onPress={go} /><Button kind="ghost" label="Cancel" onPress={onClose} /></View>
        </View>
      )}
    </Sheet>
  );
}

// ---- Sharing: the one page for what you give, what you are given, shared vaults and emergency access ----

export function SharingPage(p: Props) {
  return <View className="gap-s2"><PassesPage {...p} /><SharedPage {...p} /></View>;
}

// ---- Shared with you ----

function SharedPage({ reload }: Props) {
  const sm = useSmall();
  const [held, setHeld] = useState<Pass[] | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => { vaultMore.passes().then((x) => { setHeld(x.passes.filter((p) => p.direction === "from")); setProblem(""); }).catch((e) => setProblem(say(e, "loaded"))); }, []);
  useEffect(load, [load]);
  if (problem && !held) return <ErrorState title="Shared items did not load" reason={problem} retry={load} />;
  if (!held) return <LoadingState rows={2} />;
  return (
    <View className="gap-s2">
      <Sec title="Shared with you">
        <View className="gap-s2">
          {held.length ? <Card flush>{held.map((p, i) => {
            const l = passLine(p);
            return <View key={p.id}>{i ? <Divider /> : null}<Row dense title={l.title} sub={[l.sub, l.state].filter(Boolean).join(". ")} end={<Button kind="holdText" size={sm} label="Remove" onPress={() => vaultMore.revokePass(p.id).then(() => { showToast("Removed."); load(); reload(); }).catch((e) => showToast(say(e, "done")))} />} /></View>;
          })}</Card> : <Text tone="muted">Nothing shared with you yet. When someone shares an item, it shows up here and your assistants can use it. The value stays with them.</Text>}
          <View className="self-start"><Button kind="ghost" size={sm} icon="plus" label="Accept a share" onPress={() => setAccepting(true)} /></View>
        </View>
      </Sec>
      <AcceptSheet open={accepting} onClose={() => setAccepting(false)} onDone={() => { load(); reload(); }} />
      <SharedVaultsSection />
      <EmergencySection reload={reload} />
    </View>
  );
}

// ---- Shared vaults and people ----

/** The vaults shared with others and the people Vyre shares with, from names only. Reading is here; the buttons that change a shared vault say "Coming in this release" until trust's vault contract lands. */
export function SharedVaultsSection() {
  const sm = useSmall();
  const [vaults, setVaults] = useState<SharedVault[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [making, setMaking] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const load = useCallback(() => { vaultMore.sharedVaults().then(setVaults).catch(() => setVaults([])); vaultMore.people().then(setPeople).catch(() => setPeople([])); }, []);
  useEffect(load, [load]);
  const act = (f: () => Promise<unknown>, done: string | ((r: unknown) => string)) => f().then((r) => { showToast(typeof done === "function" ? done(r) : done); load(); }).catch((e) => showToast(say(e, "done")));
  if (!vaults) return null;
  return (
    <Sec title="Shared vaults">
      <View className="gap-s2">
        {vaults.length ? vaults.map((v) => {
          const mine = v.role === "owner" || v.role === "admin";
          return (
            <Card key={v.id} title={v.name}>
              <View className="gap-s2">
                <Text size="secondary" tone="label">{vaultLine(v)}</Text>
                {v.members.map((m) => <Row key={m.name} dense title={m.name} sub={`${roleWord(m.role)}${m.fingerprint ? `, ${m.fingerprint}` : ""}`}
                  end={!mine || m.role === "owner" ? null : <Menu trigger={<Button kind="ghost" size={sm} label="Manage" />} items={[
                    ...INVITE_ROLES.filter(([r]) => r !== m.role).map(([r, l]) => ({ label: `Make ${l.toLowerCase()}`, onPress: () => void act(() => vaultMore.memberRole(v.name, m.name, r), `${m.name} is now ${l.toLowerCase()} in ${v.name}.`) })),
                    { label: "Take out of the vault", danger: true, onPress: () => void act(() => vaultMore.memberRemove(v.name, m.name), (r) => removedLine(m.name, v.name, r as string[])) },
                  ]} />} />)}
                {mine ? <View className="flex-row flex-wrap gap-s2">
                  <Button kind="ghost" size={sm} icon="plus" label="Invite" onPress={() => setInviting(v.name)} />
                  <Button kind="ghost" size={sm} label="Change the keys" onPress={() => void act(() => vaultMore.rotateVault(v.name), `New keys for ${v.name}.`)} />
                </View> : <Text size="caption" tone="label">Only an admin can add people or change the keys.</Text>}
              </View>
            </Card>
          );
        }) : <Text size="secondary" tone="label">No shared vaults yet. A shared vault lets a group keep items together.</Text>}
        <View className="self-start"><Button kind="ghost" size={sm} icon="plus" label="New shared vault" onPress={() => setMaking(true)} /></View>
        {people.length ? <><Text strong size="secondary">People you share with</Text><Card flush>{people.map((p, i) => <View key={p.name}>{i ? <Divider /> : null}<Row dense title={p.name} sub={personLine(p)} /></View>)}</Card></> : null}
      </View>
      <NewVaultSheet open={making} onClose={() => setMaking(false)} onDone={load} />
      <InviteSheet vault={inviting} onClose={() => setInviting(null)} onDone={load} />
    </Sec>
  );
}

function NewVaultSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(""); setProblem(""); } }, [open]);
  const typed = newVaultInput(name);
  const savedAs = "input" in typed ? typed.input.name : "";
  const go = () => {
    const p = newVaultInput(name);
    if ("error" in p) { setProblem(p.error); return; }
    setBusy(true); setProblem("");
    vaultMore.createVault(p.input.name).then(() => { showToast(`${p.input.name} is made.`); onDone(); onClose(); }).catch((e) => setProblem(say(e, "made"))).finally(() => setBusy(false));
  };
  return (
    <Sheet open={open} onClose={onClose} title="New shared vault">
      <View className="gap-s3">
        <Text tone="muted">A place for items a group keeps together, such as one client's keys. You invite the people after.</Text>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Acme client" help={savedAs && savedAs !== name.trim() ? `Saved as ${savedAs}.` : undefined} />
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <Button kind="primary" label={busy ? "Making" : "Make the vault"} disabled={busy} onPress={go} />
      </View>
    </Sheet>
  );
}

function InviteSheet({ vault, onClose, onDone }: { vault: string | null; onClose: () => void; onDone: () => void }) {
  const [person, setPerson] = useState("");
  const [role, setRole] = useState("member");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ invite: string; member: string } | null>(null);
  useEffect(() => { if (vault) { setPerson(""); setRole("member"); setProblem(""); setMade(null); } }, [vault]);
  const go = () => {
    if (!vault) return;
    const p = inviteInput(vault, person, role);
    if ("error" in p) { setProblem(p.error); return; }
    setBusy(true); setProblem("");
    vaultMore.invite(p.input.vault, p.input.person, p.input.role).then((r) => { setMade({ invite: r.invite, member: r.member }); onDone(); }).catch((e) => setProblem(say(e, "invited"))).finally(() => setBusy(false));
  };
  return (
    <Sheet open={!!vault} onClose={onClose} title={made ? "Invited" : `Invite someone to ${vault ?? ""}`}>
      {made ? (
        <View className="gap-s3">
          <Text>{`Send ${made.member} this. It holds no value, and it works only for them.`}</Text>
          <CopyLine label="Copy the invite" line={made.invite} />
          <Button kind="primary" label="Done" onPress={onClose} />
        </View>
      ) : (
        <View className="gap-s3">
          <Field label="Who" value={person} onChangeText={setPerson} help="Someone whose Vyre card you have checked." />
          <Segmented label="Role" value={role} onChange={setRole} options={INVITE_ROLES} />
          <Text size="caption" tone="label">{ROLE_HELP[role]}</Text>
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <Button kind="primary" label={busy ? "Inviting" : "Invite"} disabled={busy} onPress={go} />
        </View>
      )}
    </Sheet>
  );
}

/** Paste what someone sent: a vault invite joins that vault, a pass adds what they shared. */
function AcceptSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPasted(""); setProblem(""); } }, [open]);
  const go = () => {
    const k = acceptKind(pasted);
    if ("error" in k) { setProblem(k.error); return; }
    setBusy(true); setProblem("");
    (k.kind === "invite" ? vaultMore.acceptInvite(k.value) : vaultMore.acceptTicket(k.value)).then(() => { showToast(k.kind === "invite" ? "You joined the vault." : "Added. What they shared is in Shared with you."); onDone(); onClose(); }).catch((e) => setProblem(say(e, "accepted"))).finally(() => setBusy(false));
  };
  return (
    <Sheet open={open} onClose={onClose} title="Accept a share">
      <View className="gap-s3">
        <Text tone="muted">Paste the invite or share someone sent you.</Text>
        <Field label="What they sent" value={pasted} onChangeText={setPasted} multiline lines={3} mono />
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <Button kind="primary" label={busy ? "Checking" : "Accept"} disabled={busy} onPress={go} />
      </View>
    </Sheet>
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
        onRefresh={() => act(() => vaultMore.emergencyRefresh(), "Updated with what is in the vault now.")} onAdd={() => setAdding(true)} />
      <AddEmergencySheet open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); reload(); }} />
    </>
  );
}

/** The list and its actions, from what it is given: the section above reads the box, the gallery gives it a sample. */
export function EmergencyView({ list, problem, onDeny, onRemove, onRefresh, onAdd }: { list: EmergencyContact[] | null; problem: string; onDeny: (c: EmergencyContact) => void; onRemove: (c: EmergencyContact) => void; onRefresh: () => void; onAdd: () => void }) {
  const phone = useUiTheme().phone, size = phone ? "md" : "sm";
  return (
    <Sec title="Emergency access">
    <View className="gap-s2">
      <Text size="caption" tone="label">Someone you trust can ask. After the wait, the items open to them unless you deny it. They never see a value before then.</Text>
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
      })}</Card> : list ? <Text tone="muted">No one yet. Add someone you trust and choose how long they wait.</Text> : null}
      <View className="flex-row gap-s2 self-start">
        <Button kind="primary" label="Add someone" onPress={onAdd} />
        {list && list.length ? <Button kind="ghost" label="Update what they can open" onPress={onRefresh} /> : null}
      </View>
    </View>
    </Sec>
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

// ---- Browsers ----

export function DevicesPage(_: Props) {
  const sm = useSmall();
  const [list, setList] = useState<Device[] | null>(null);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => { vaultMore.devices().then((x) => { setList(x); setProblem(""); }).catch((e) => setProblem(say(e, "loaded"))); }, []);
  useEffect(load, [load]);
  if (problem && !list) return <ErrorState title="Browsers did not load" reason={problem} retry={load} />;
  if (!list) return <LoadingState rows={2} />;
  return (
    <View className="gap-s2 pt-s2">
      {list.length ? <Card flush>{list.map((d, i) => {
        const l = deviceLines(d, Date.now());
        return <View key={d.id}>{i ? <Divider /> : null}<Row dense title={d.name} sub={[l.sub, l.sessions].filter(Boolean).join(". ")}
          end={d.revoked ? null : <Button kind="holdText" size={sm} label="Remove" onPress={() => vaultMore.revokeDevice(d.id).then(() => { showToast(`${d.name} can no longer fill logins.`); load(); }).catch((e) => showToast(say(e, "done")))} />} /></View>;
      })}</Card> : <Text tone="muted">No browsers yet. A paired browser fills your logins for you.</Text>}
      <Text size="caption" tone="label">It fills only on the site an item is for, and only while the vault is open.</Text>
      <View className="self-start"><Button kind="ghost" size={sm} icon="plus" label="Pair a browser" onPress={comingSoon} /></View>
    </View>
  );
}

// ---- Health ----

export function WatchtowerPage({ openItem }: Props) {
  const sm = useSmall();
  const [h, setH] = useState<Health | null>(null);
  const [problem, setProblem] = useState("");
  const [caps, setCaps] = useState<{ breach: "ask" | "off" } | null>(null);
  const [breach, setBreach] = useState<{ line: string; names: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback(() => { vaultMore.health().then((x) => { setH(x); setProblem(""); }).catch((e) => setProblem(say(e, "loaded"))); vaultMore.caps().then(setCaps).catch(() => {}); }, []);
  useEffect(load, [load]);
  if (problem && !h) return <ErrorState title="Health did not load" reason={problem} retry={load} />;
  if (!h) return <LoadingState rows={3} />;
  const groups = healthGroups(h);
  const check = () => {
    setChecking(true); setBreach(null);
    vaultMore.breachCheck().then((b) => setBreach({ line: breachLine(b), names: b.breached })).catch((e) => setBreach({ line: say(e, "checked"), names: [] })).finally(() => setChecking(false));
  };
  return (
    <View className="gap-s3 pt-s2">
      <Text tone="muted" size="secondary">Checked on your server. Only names and reasons come to this screen, never a value.</Text>
      {groups.length ? groups.map((g) => (
        <View key={g.code} className="gap-s1">
          <Text strong size="secondary">{g.title}</Text>
          <Text size="caption" tone="label">{g.why}</Text>
          <Card flush>{g.rows.map((r, i) => <View key={r.name}>{i ? <Divider /> : null}<Row dense title={r.name} sub={r.others.length ? `Same value as ${r.others.join(", ")}` : undefined} onPress={() => openItem(r.name)} /></View>)}</Card>
        </View>
      )) : <Card><EmptyState title="All good" body={`${h.checked} ${h.checked === 1 ? "item" : "items"} checked. Nothing needs a look.`} /></Card>}
      <View className="gap-s2 pt-s2">
        <Text strong size="secondary">Known breaches</Text>
        <Text size="secondary" tone="muted">Compares your passwords with public lists of leaked ones. Only a short fingerprint of each leaves your server, never a password, and the match is made here.</Text>
        {caps && caps.breach !== "ask"
          ? <View className="gap-s2 self-start"><Text size="caption" tone="label">Not turned on. It makes a call to the outside, so it asks you each time once it is.</Text><View className="self-start"><Button kind="secondary" size={sm} label="Turn on" onPress={comingSoon} /></View></View>
          : <View className="self-start"><Button kind="primary" size={sm} label={checking ? "Checking" : "Check now"} disabled={checking} onPress={check} /></View>}
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
      {h.earlier ? <Text size="caption" tone="label">{`${h.earlier.count} earlier ${h.earlier.count === 1 ? "password" : "passwords"}, the last replaced ${dayWord(h.earlier.last)}. Kept, and never shown.`}</Text> : null}
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
    <Sheet open onClose={onClose} title={`Edit ${item.name}`}>
      <View className="gap-s3">
        <Field label="Description" value={desc} onChangeText={setDesc} />
        {item.fields.map((f) => (
          <View key={f} className="gap-s1">
            <Field label={`New ${f}`} kind="password" value={typed[f] ?? ""} onChangeText={(v) => setTyped({ ...typed, [f]: v })} help="Leave empty to keep it exactly as it is. Nothing is shown to fill in." />
            {MAKEABLE.includes(f) ? <View className="self-start"><Chip selected={make === f} onPress={() => setMake(make === f ? null : f)}>Make a new one for me</Chip></View> : null}
          </View>
        ))}
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <Button kind="primary" label={busy ? "Saving" : "Save"} disabled={busy} onPress={save} />
        <Text size="caption" tone="label">Assistants use it and never see the value.</Text>
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
    vaultMore.sshGenerate(name.trim(), desc).then(() => { showToast(`Made ${name.trim()}. Its public half is on the item.`); onMade(); onClose(); }).catch((e) => setProblem(say(e, "made"))).finally(() => setBusy(false));
  };
  return (
    <Sheet open={open} onClose={onClose} title="New SSH key">
      <View className="gap-s3">
        <Text tone="muted">Made on your server. The private half never leaves it. You get the public half to paste into GitHub or another server.</Text>
        <Field label="Name" value={name} onChangeText={setName} placeholder="deploy-key" />
        <Field label="Description" value={desc} onChangeText={setDesc} />
        {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
        <Button kind="primary" label={busy ? "Making" : "Make the key"} disabled={busy} onPress={go} />
      </View>
    </Sheet>
  );
}
