// Your profile, one per Space: your face here (picked with the same look picker as Account and agents), your name, and a line or two About me. It is kept in the showing Space as a member-profile
// record (src/state/profiles.ts): the people of the Space read it in People and in chats, and only you change it. Your name is your account's name (identity.display.set), the same in every Space.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Avatar, Banner, Button, Card, EmptyState, Field, LoadingState, Row, Text, allowsMock, markRef, showToast } from "@vyre/ui";
import { Footnote, Group, Page } from "../places/Frame";
import { LookSheet } from "../assistants/AgentPage";
import { useShell } from "../shell/shared";
import { useSpaces } from "../shell/state";
import { useProfiles } from "../../src/state/profiles";
import { useMyLook } from "../../src/state/my-look";
import { ABOUT_MAX, aboutProblem } from "../../src/state/profiles-model.js";
import { accountHeader } from "../../ui/shell/switcher-model.js";
import { canSetName, setDisplayName } from "../settings/real";
import { displayNameOk } from "../settings/account-model";

const say = (e: unknown) => (e instanceof Error && e.message ? e.message : "That did not save. Try again.");

export function ProfileScreen() {
  const space = useSpaces((s) => s.space);
  const data = useShell((s) => s.data);
  const showing = data.spaces.find((s) => s.id === space);
  const entry = useProfiles((s) => s.bySpace[space]);
  const load = useProfiles((s) => s.load);
  const save = useProfiles((s) => s.save);
  const deviceLook = useMyLook((s) => s.look);
  const mock = allowsMock();
  const one = Boolean(showing) && space !== "all";
  useEffect(() => { if (one && !mock) void load(space, true); }, [one, mock, space, load]);
  const mine = entry && entry.me ? entry.byPerson[entry.me] ?? null : null;
  const { name, handle } = accountHeader({ name: data.me.name, sub: data.me.vyreName });
  const [about, setAbout] = useState("");
  const [look, setLook] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  useEffect(() => { setAbout(mine?.about ?? ""); setLook(mine?.look ?? ""); }, [mine?.about, mine?.look, space]);
  const face = look || mine?.look || deviceLook || "";
  const problem = aboutProblem(about);
  const changed = (mine?.about ?? "") !== about.trim();

  const keep = async (next: { about?: string; look?: string; name?: string }, done: string) => {
    if (mock) { showToast(done); return; }
    setBusy(true);
    try { await save(space, { name, ...next }); showToast(done); } catch (e) { showToast(say(e)); } finally { setBusy(false); }
  };
  const rename = async () => {
    const v = nameDraft.trim();
    try {
      const shown = await setDisplayName(v);
      useShell.getState().set({ ...data, me: { ...data.me, name: shown || v } });
      setEditingName(false);
      if (!mock && one) await save(space, { name: shown || v });
      showToast("Your name is changed in every Space.");
    } catch (e) { showToast(say(e)); }
  };

  if (!one) {
    return (
      <Page title="Your profile" back="/u/settings">
        <Card><EmptyState title="Pick a Space" body="You have a profile in each Space. Pick one with the Space name at the top of the sidebar, and its profile opens here." /></Card>
      </Page>
    );
  }
  return (
    <Page title="Your profile" sub={`In ${showing?.name ?? "this Space"}. The people of this Space see it.`} back="/u/settings">
      {entry?.error && !mine ? <Banner icon="refresh"><Text tone="warn">{`Your profile in this Space did not load: ${entry.error}`}</Text></Banner> : null}
      {!mock && !entry ? <LoadingState rows={2} /> : (
        <>
          <Card className="gap-s3">
            <Row className="px-0" lead={<Avatar of={markRef("person", name, entry?.me ?? undefined, face || undefined)} size={56} />} title={name} sub={handle || undefined}
              end={<Button kind="ghost" size="sm" icon="spark" label="Change your look" onPress={() => setPicking(true)} />} />
            {editingName ? (
              <View className="gap-s2">
                <Field label="Your name" value={nameDraft} onChangeText={setNameDraft} help="One line of up to 60 characters. It is your name in every Space. Your username stays the same." />
                <View className="flex-row gap-s2">
                  <Button kind="primary" size="sm" label="Save name" disabled={!displayNameOk(nameDraft)} onPress={() => void rename()} />
                  <Button kind="ghost" size="sm" label="Cancel" onPress={() => setEditingName(false)} />
                </View>
              </View>
            ) : canSetName() ? <View className="flex-row"><Button kind="ghost" size="sm" icon="edit" label="Change name" onPress={() => { setNameDraft(data.me.name); setEditingName(true); }} /></View> : null}
          </Card>
          <Group title="About me" note="A sentence or two: your role, or what you work on.">
            <Card className="gap-s3">
              <Field name="About me" value={about} onChangeText={setAbout} multiline lines={3} placeholder="For example: I look after new clients and the calendar." error={problem || undefined} help={problem ? undefined : `${about.trim().length} of ${ABOUT_MAX}`} />
              <View className="flex-row"><Button kind="primary" size="sm" label={busy ? "Saving" : "Save"} disabled={busy || !changed || Boolean(problem)} onPress={() => void keep({ about: about.trim() }, "Saved. The people of this Space see it.")} /></View>
            </Card>
          </Group>
          <Footnote icon="shield">Your profile is kept in this Space. Its people can read it. Only you can change it, not the owner and not an agent.</Footnote>
        </>
      )}
      <LookSheet person a={{ name, look: face || null }} open={picking} onClose={() => setPicking(false)}
        onSave={async (l) => { if (!mock) await save(space, { name, look: l }); }}
        onSaved={(l) => { setLook(l); setPicking(false); showToast("Saved. This is how the people of this Space see you."); }} />
    </Page>
  );
}
