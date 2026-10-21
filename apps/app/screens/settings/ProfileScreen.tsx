// Your profile in this Space: one face (your photo, or your look), your name, your username and your role, then your assistant.
// A photo is chosen from this device, centre-cropped and scaled here, then saved through the Space's profiles (src/state/profiles.ts). setPhoto puts the
// picture in the photo cache and reloads the Space's faces, so the sidebar and every other face of you change on this render.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, EmptyState, ErrorState, LoadingState, PageHeader, Text, allowsMock, photoCache, showToast, usePersonLooks } from "@vyre/ui";
import { usePhone } from "../places/Page";
import { useSpaces } from "../shell/state";
import { useShell } from "../shell/shared";
import { showingName } from "../shell/real-model";
import { LookSheet } from "../assistants/AgentPage";
import { useKept } from "../../src/state/kept";
import { useProfiles } from "../../src/state/profiles";
import { encodePhoto, pickPhoto } from "../../src/state/profile-photo";
import { saveCentrePhoto } from "../../src/state/profile-photo-save.js";
import { useMyLook } from "../../src/state/my-look";
import { AssistantLookCard } from "./AssistantLookCard";
import { canSetName, identity as loadIdentity, setDisplayName } from "./real";
import { loadAccount } from "./data";
import type { Identity } from "./account-model";
import { profileHandle, profileRole } from "./profile-model.js";
import { ProfileIdentity } from "./ProfileIdentity";

const say = (e: unknown) => (e instanceof Error && e.message ? e.message : "That did not go through.");

/** The sample build has no Space to keep a photo in. The cache and the name key are what every face already reads. */
function rememberSample(name: string, pic: { mime: string; base64: string } | null) {
  const key = name.toLowerCase();
  const photos = usePersonLooks.getState().photos;
  if (!pic) {
    const { [key]: _gone, ...rest } = photos;
    usePersonLooks.getState().setPhotos(rest);
    return;
  }
  photoCache.put("sample:me", `data:${pic.mime};base64,${pic.base64}`);
  usePersonLooks.getState().setPhotos({ ...photos, [key]: "sample:me" });
}

function ProfileFrame({ children }: { children: React.ReactNode }) {
  const phone = usePhone();
  const router = useRouter();
  const goBack = () => (router.canGoBack() ? router.back() : router.replace("/u/settings" as never));
  if (phone) {
    return (
      <View className="w-full">
        <PageHeader title="Your profile" onBack={goBack} />
        <View className="w-full gap-s4 p-s4 pb-s12">{children}</View>
      </View>
    );
  }
  return (
    <View className="w-full max-w-page gap-s4 self-center px-gutter pt-s8 pb-s12">
      <Text size="page" strong accessibilityRole="header">Your profile</Text>
      {children}
    </View>
  );
}

export function ProfileScreen() {
  return <ProfileFrame>{allowsMock() ? <Sample /> : <Real />}</ProfileFrame>;
}

function Sample() {
  const space = useSpaces((s) => s.space);
  const data = useShell((s) => s.data);
  const showing = data.spaces.find((s) => s.id === space) ?? data.spaces[0];
  const name = data.me.name;
  const account = loadAccount();
  const deviceLook = useMyLook((s) => s.look);
  const hasPhoto = usePersonLooks((s) => Boolean(s.photos[name.toLowerCase()]));
  return (
    <Editor
      mock
      space={space}
      name={name}
      handle={profileHandle(name, data.me.vyreName)}
      role={profileRole(account.line, showing?.name)}
      spaceName={showing?.name || showingName(data, space)}
      look={deviceLook}
      canEditName={false}
      hasPhoto={hasPhoto}
      onRename={async () => {}}
    />
  );
}

function Real() {
  const space = useSpaces((s) => s.space);
  const data = useShell((s) => s.data);
  const showing = data.spaces.find((s) => s.id === space);
  const k = useKept<Identity>("profile", loadIdentity, "Your profile did not answer.");
  const load = useProfiles((s) => s.load);
  const entry = useProfiles((s) => s.bySpace[space]);
  const mine = entry?.me ? entry.byPerson[entry.me] ?? null : null;
  const deviceLook = useMyLook((s) => s.look);
  useEffect(() => { if (space) void load(space, true); }, [space, load]);
  const id = k.data;
  if (k.err) return <ErrorState title="Your profile did not load" reason={k.err} retry={k.reload} />;
  if (!id) return <LoadingState rows={3} />;
  if (!id.exists) return <EmptyState title="No Vyre name on this device yet" body="Choose your Vyre name during setup." />;
  const name = id.label || data.me.name || id.name || "You";
  return (
    <>
      {entry?.error && !mine ? <Banner icon="refresh"><Text tone="warn">{`Your profile in this Space did not load: ${entry.error}`}</Text></Banner> : null}
      <Editor
        space={space}
        name={name}
        handle={profileHandle(name, id.name || data.me.vyreName)}
        role={profileRole(showing?.sub || "", showing?.name)}
        spaceName={showing?.name || showingName(data, space)}
        look={mine?.look || deviceLook}
        personId={entry?.me || undefined}
        canEditName={canSetName()}
        hasPhoto={Boolean(mine?.photo)}
        onRename={async (v) => {
          const shown = await setDisplayName(v);
          const next = shown || v;
          const cur = useShell.getState().data;
          useShell.getState().set({ ...cur, me: { ...cur.me, name: next } });
          if (space) await useProfiles.getState().save(space, { name: next });
          showToast("Saved.");
          k.reload();
        }}
      />
    </>
  );
}

function Editor({ mock, space, name, handle, role, spaceName, look, personId, canEditName, hasPhoto, onRename }: {
  mock?: boolean; space: string; name: string; handle: string; role: string; spaceName: string; look: string; personId?: string;
  canEditName: boolean; hasPhoto: boolean; onRename: (next: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const face = picked ?? look;
  const leftover = useProfiles((s) => Boolean(s.leftover[space]));
  const retryLeftover = useProfiles((s) => s.retryLeftover);
  const upload = async () => {
    try {
      const pick = await pickPhoto();
      if (!pick) return;
      setBusy(true);
      await saveCentrePhoto(pick, space, name, encodePhoto, mock
        ? async (_s, pic, n) => { if (n) rememberSample(n, pic); }
        : (s, pic, n) => useProfiles.getState().setPhoto(s, pic, n));
      showToast("Saved.");
    } catch (e) { showToast(say(e)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      if (mock) rememberSample(name, null);
      else await useProfiles.getState().setPhoto(space, null, name);
      showToast("Your photo is removed. Your look shows instead.");
    } catch (e) { showToast(say(e)); }
    finally { setBusy(false); }
  };
  const keepLook = async (next: string) => {
    if (mock) {
      const cur = usePersonLooks.getState();
      usePersonLooks.getState().set({ ...cur.looks, [name.toLowerCase()]: next });
      useMyLook.getState().set(next);
      if (hasPhoto) rememberSample(name, null);
      return;
    }
    await useProfiles.getState().save(space, { name, look: next });
    useMyLook.getState().set(next);
    if (hasPhoto) await useProfiles.getState().setPhoto(space, null, name);
  };
  return (
    <>
      <ProfileIdentity
        name={name} handle={handle} role={role} spaceName={spaceName} look={face} personId={personId}
        canEditName={canEditName} hasPhoto={hasPhoto} busy={busy}
        onChangePhoto={() => void upload()} onRemovePhoto={() => void remove()} onUseLook={() => setPicking(true)} onRename={onRename}
      />
      {leftover ? (
        <View className="flex-row flex-wrap items-center gap-s2">
          <Text size="caption" tone="muted">The old photo couldn't be removed. Try again.</Text>
          <Button kind="ghost" size="sm" icon="refresh" label="Try again" disabled={busy} onPress={() => { setBusy(true); void retryLeftover(space).then(() => showToast("The old photo is removed."), (e) => showToast(say(e))).finally(() => setBusy(false)); }} />
        </View>
      ) : null}
      <AssistantLookCard />
      <LookSheet person a={{ name, look: face || null }} open={picking} onClose={() => setPicking(false)}
        onSave={keepLook}
        onSaved={(next) => { setPicked(next); setPicking(false); showToast(hasPhoto ? "Your look shows instead." : "Saved."); }} />
    </>
  );
}
