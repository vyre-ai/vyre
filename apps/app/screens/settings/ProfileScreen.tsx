// Your profile in this Space: the name shown here, your look and your avatar. They belong to the Space showing (owner, 21 Oct 2026); only the username and password are the same everywhere (Sign-in and recovery).
import { useState } from "react";
import { View } from "react-native";
import { Avatar, Button, Card, EmptyState, ErrorState, Field, LoadingState, Row, allowsMock, markRef, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useSpaces } from "../shell/state";
import { useShell } from "../shell/shared";
import { showingName } from "../shell/real-model";
import { useKept } from "../../src/state/kept";
import { AssistantLookCard } from "./AssistantLookCard";
import { displayNameOk, identityLine, type Identity } from "./account-model";
import { canSetName, identity as loadIdentity, setDisplayName } from "./real";
import { loadAccount } from "./data";

const say = (e: unknown) => (e instanceof Error && e.message ? e.message : "That did not go through.");

export function ProfileScreen() {
  const space = useSpaces((s) => s.space);
  const name = showingName(useShell((s) => s.data), space);
  return <Page title={`Your profile in ${name}`} sub="How you show up in this Space. Switch Space to see your profile in another." back="/u/settings">{allowsMock() ? <Sample /> : <Real />}</Page>;
}

function Sample() {
  const A = loadAccount();
  return <><Card><Row lead={<Avatar of={markRef("person", A.name)} size={40} />} title={A.name} sub={A.line} className="px-0" /></Card><AssistantLookCard person={A.name} /></>;
}

function Real() {
  const k = useKept<Identity>("profile", loadIdentity, "Your profile did not answer.");
  const id = k.data;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (k.err) return <Card flush><ErrorState title="Your profile did not load" reason={k.err} retry={k.reload} /></Card>;
  if (!id) return <LoadingState rows={3} />;
  if (!id.exists) return <Card><EmptyState title="No Vyre name on this device yet" body="Choose your Vyre name during setup." /></Card>;
  const shown = id.label || id.name || "You";
  return (
    <>
      <Card className="gap-s3">
        <Row lead={<Avatar of={markRef("person", shown)} size={40} />} title={shown} sub={identityLine(id)} className="px-0"
          end={canSetName() && !editing ? <Button kind="ghost" size="sm" icon="edit" label="Change name" onPress={() => { setDraft(id.label || ""); setEditing(true); }} /> : undefined} />
        {editing ? (
          <View className="gap-s2">
            <Field label="Your name here" value={draft} onChangeText={setDraft} help="One line of up to 60 characters. Your username stays the same." />
            <View className="flex-row gap-s2">
              <Button kind="primary" size="sm" label="Save" disabled={!displayNameOk(draft)} onPress={() => void setDisplayName(draft.trim()).then(() => { setEditing(false); showToast("Saved."); k.reload(); }).catch((e) => showToast(say(e)))} />
              <Button kind="ghost" size="sm" label="Cancel" onPress={() => setEditing(false)} />
            </View>
          </View>
        ) : null}
      </Card>
      <AssistantLookCard person={shown} />
    </>
  );
}
