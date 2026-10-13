import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, ControlRow, Divider, EmptyState, ErrorState, Field, LoadingState, Row, Sheet, Text, showToast } from "@vyre/ui";
import { Footnote, Page, Sec } from "../places/Frame";
import { useMembers } from "../spaces/state";
import { MOCK } from "../../src/real/box";
import { ACCESS, ADMIN_ONLY, ADMIN_ONLY_LINE, CAN_DO, TOOLS, WHERE, builtInName, canDuplicate, canEditRoles, holdersLine, nameProblem, removeRefusal, rolesRefusal, sees, setAccess, setCan, setHidden, setProject, setTool, setWhere, type Role } from "./roles";
import { useRoles } from "./state";

/** Settings, Roles: the space's roles with how many people hold each; open one to edit its four sections. Owner and admin only. */
export function RolesScreen() {
  const { world, error, reload, src } = useRoles();
  const { spaces, space, load } = useMembers();
  useEffect(() => { void load(); }, [load]);
  const mine = MOCK ? "owner" : spaces.find((s) => s.id === space)?.role;
  const [openId, setOpenId] = useState("");
  const [making, setMaking] = useState(false);

  if (!world) return <Page title="Roles" back="/u/settings"><LoadingState rows={4} /></Page>;
  if (!canEditRoles(mine)) return <Page title="Roles" back="/u/settings"><Card><EmptyState title="Only an owner or admin changes roles" body="Ask an owner or admin of this space." /></Card></Page>;
  const open = world.roles.find((r) => r.id === openId);
  if (open) return <RoleDetail key={open.id} role={open} world={world} src={src} back={() => setOpenId("")} go={setOpenId} />;

  const built = world.roles.filter((r) => r.builtin);
  const custom = world.roles.filter((r) => !r.builtin);
  const names = Object.fromEntries(world.projects.map((p) => [p.id, p.name]));
  const row = (r: Role, i: number) => (
    <View key={r.id}>
      {i ? <Divider /> : null}
      <Row dense title={r.name} sub={sees(r, names)} state={holdersLine(r.holders)} chevron onPress={() => setOpenId(r.id)} accessibilityLabel={`${r.name}, ${holdersLine(r.holders)}`} />
    </View>
  );
  return (
    <Page title="Roles" sub="What each person in this space can do, see and use." back="/u/settings" actions={<Button kind="primary" size="sm" icon="plus" label="New role" onPress={() => setMaking(true)} />}>
      {error ? <Banner tone="warn"><Text>{error}</Text></Banner> : null}
      <Sec title="Built in"><Card flush>{built.map(row)}</Card></Sec>
      <Sec title="Your roles" meta={custom.length ? String(custom.length) : undefined}>
        {custom.length ? <Card flush>{custom.map(row)}</Card> : <Card><EmptyState title="No roles of your own yet" body="Make one from a built-in role, like Paralegal or Contractor, and change what it can do." action={{ label: "New role", onPress: () => setMaking(true) }} /></Card>}
      </Sec>
      <Footnote icon="shield">A role is never above Admin. A new member gets only the projects they are on, with no mail, calendar or computers, until a role turns them on.</Footnote>
      <NewRole open={making} onClose={() => setMaking(false)} roles={world.roles} create={async (from, name) => { const r = await src.create(from, name); await reload(); setOpenId(r.id); }} />
    </Page>
  );
}

function NewRole({ open, onClose, roles, create }: { open: boolean; onClose: () => void; roles: Role[]; create: (from: string, name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const from = "member";
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const go = async () => {
    const bad = nameProblem(name, roles);
    if (bad) { setProblem(bad); return; }
    setBusy(true);
    try { await create(from, name); setName(""); setProblem(""); onClose(); } catch (e) { setProblem(rolesRefusal((e as { code?: string }).code, (e as Error).message)); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="New role">
      <Text tone="muted">It starts as a Member and you change what it can do next. A role is never wider than Admin.</Text>
      <Field label="Name" name="Role name" value={name} onChangeText={(v) => { setName(v); setProblem(""); }} placeholder="Paralegal, Contractor, Bookkeeper" error={problem} />
      <View className="flex-row gap-s2"><Button kind="primary" label="Make the role" loading={busy} onPress={() => void go()} /><Button kind="ghost" label="Cancel" onPress={onClose} /></View>
    </Sheet>
  );
}

type Src = ReturnType<typeof useRoles>["src"];

function RoleDetail({ role, world, src, back, go }: { role: Role; world: NonNullable<ReturnType<typeof useRoles>["world"]>; src: Src; back: () => void; go: (id: string) => void }) {
  // Saved as you go: the screen shows a change at once and sends it; a refusal puts the old value back and says why.
  const [local, setLocal] = useState<Role | null>(null);
  const pending = useRef(0);
  const [note, setNote] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(role.name);
  useEffect(() => { if (!pending.current) setLocal(null); }, [role]);
  const r = local ?? role;
  const locked = role.builtin;
  const edit = (f: (x: Role) => Role) => {
    const next = f(r);
    setLocal(next); pending.current++;
    void src.save(next).catch((e: unknown) => { setLocal(null); showToast(rolesRefusal((e as { code?: string }).code, (e as Error).message)); }).finally(() => { pending.current--; });
  };
  const names = Object.fromEntries(world.projects.map((p) => [p.id, p.name]));
  const why = removeRefusal(role);
  const rename = () => { const bad = nameProblem(name, world.roles, role.id); if (bad) { setNote(bad); return; } setNote(""); setRenaming(false); edit((x) => ({ ...x, name: name.trim() })); };
  const duplicate = () => void src.duplicate(role.id).then((c) => go(c.id)).catch((e: unknown) => showToast(rolesRefusal((e as { code?: string }).code, (e as Error).message)));
  const sub = `${holdersLine(role.holders)} · ${locked ? "Built in" : `Starts from ${builtInName(role.from || "member")}`}`;
  return (
    <Page title={r.name} sub={sub} onBack={back}
      actions={<>
        {locked ? (canDuplicate(role) ? <Button kind="primary" size="sm" label="Duplicate to change" onPress={duplicate} /> : null) : <><Button kind="ghost" size="sm" label="Rename" onPress={() => { setName(r.name); setRenaming(true); }} />{canDuplicate(role) ? <Button kind="ghost" size="sm" label="Duplicate" onPress={duplicate} /> : null}</>}
      </>}>
      <Text tone="muted">{sees(r, names)}</Text>
      {locked ? <Banner icon="shield"><Text>{canDuplicate(role) ? `${role.name} is built in. Duplicate it to make a version you can change.` : `${role.name} is built in and cannot be changed or copied.`}</Text></Banner> : null}

      <Sec title="1. Can do">
        <Card flush>{(world.catalogue?.can ?? CAN_DO.map(([k, t, l]) => [k, t, l, ADMIN_ONLY.includes(k) ? "admin" : "member"])).map(([k, title, line, needs], i) => {
            // A custom role is a Member at heart: what only an admin can do is shown unavailable, so the screen never offers what the box refuses.
            const out = !locked && needs === "admin";
            return <View key={k}>{i ? <Divider /> : null}<ControlRow title={title} sub={out ? ADMIN_ONLY_LINE : line} on={out ? false : !!r.can[k]} locked={locked || out} onToggle={(v) => edit((x) => setCan(x, k, v))} /></View>;
          })}</Card>
      </Sec>

      <Sec title="2. Where">
        <Card flush>
          {WHERE.map(([k, title, line], i) => <View key={k}>{i ? <Divider /> : null}<Row dense title={title} sub={line} selected={r.where.kind === k} end={r.where.kind === k ? <Chip tone="accent">Chosen</Chip> : undefined} onPress={locked ? undefined : () => edit((x) => setWhere(x, k as Role["where"]["kind"]))} /></View>)}
        </Card>
        {r.where.kind === "chosen" ? (
          <View className="gap-s2 pt-s3">
            <View className="flex-row flex-wrap gap-s2">{world.projects.map((p) => <Chip key={p.id} selected={r.where.projects.includes(p.id)} onPress={locked ? undefined : () => edit((x) => setProject(x, p.id, !x.where.projects.includes(p.id)))}>{p.name}</Chip>)}</View>
            <Text size="caption" tone="label">{world.projects.length ? (r.where.projects.length ? `${r.where.projects.length} of ${world.projects.length} projects.` : "No project chosen yet, so this role sees none.") : "This space has no projects yet."}</Text>
          </View>
        ) : null}
      </Sec>

      <Sec title="3. Which data">
        <Card flush>
          {r.data.map((d, i) => {
            const fields = world.types.find((t) => t.id === d.id)?.fields ?? [];
            return (
              <View key={d.id}>
                {i ? <Divider /> : null}
                <ControlRow title={d.name} sub={d.access === "none" ? "Not shown to this role." : d.hidden.length ? `${d.hidden.length} hidden: ${d.hidden.join(", ")}.` : undefined} value={d.access} options={ACCESS as [string, string][]} locked={locked} onChoose={(v) => edit((x) => setAccess(x, d.id, v as "none" | "read" | "edit"))}>
                  {d.access !== "none" && fields.length ? (
                    <View className="gap-s1">
                      <Text size="caption" tone="label">Hide a field</Text>
                      <View className="flex-row flex-wrap gap-s2">{fields.map((f) => <Chip key={f} icon={d.hidden.includes(f) ? "sealed" : undefined} selected={d.hidden.includes(f)} onPress={locked ? undefined : () => edit((x) => setHidden(x, d.id, f, !d.hidden.includes(f)))}>{f}</Chip>)}</View>
                    </View>
                  ) : null}
                </ControlRow>
              </View>
            );
          })}
        </Card>
      </Sec>

      <Sec title="4. Which tools">
        <Card flush>{(world.catalogue?.tools ?? TOOLS).map(([k, title, line], i) => <View key={k}>{i ? <Divider /> : null}<ControlRow title={title} sub={line} on={!!r.tools[k]} locked={locked} onToggle={(v) => edit((x) => setTool(x, k, v))} /></View>)}</Card>
      </Sec>

      {!locked ? (
        <Sec title="Remove">
          <Card className="gap-s3">
            <Text tone="muted">{why || `Nobody holds ${role.name}, so it can go. This cannot be undone.`}</Text>
            {why ? <View className="flex-row"><Button kind="ghost" label={`Remove ${role.name}`} onPress={() => setNote(why)} /></View> : <View className="flex-row"><Button kind="hold" label={`Remove ${role.name}`} onPress={() => void src.remove(role.id).then(back).catch((e: unknown) => showToast(rolesRefusal((e as { code?: string }).code, (e as Error).message)))} /></View>}
            {note && note === why ? <Banner tone="warn"><Text>{note}</Text></Banner> : null}
          </Card>
        </Sec>
      ) : null}

      <Sheet open={renaming} onClose={() => setRenaming(false)} title="Rename role">
        <Field label="Name" name="Role name" value={name} onChangeText={(v) => { setName(v); setNote(""); }} error={note && note !== why ? note : undefined} />
        <View className="flex-row gap-s2"><Button kind="primary" label="Save" onPress={rename} /><Button kind="ghost" label="Cancel" onPress={() => setRenaming(false)} /></View>
      </Sheet>
    </Page>
  );
}
