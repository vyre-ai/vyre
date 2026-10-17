import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Field, PasswordField, Text } from "@vyre/ui";
import { Page } from "../places/Frame";
import { said, tool } from "../../src/real/box";
import { type DeviceKind } from "./wink.js";
import { useDevices } from "./state";

/**
 * Add a computer, a phone or a server with the same onboard tools the first run uses.
 * A computer signs in with the space address and the master password. A phone gets a link. A server gets the one install command.
 */
export function RealAdd({ kind, onBack, onDone, first }: { kind: DeviceKind; onBack: () => void; onDone: () => void; first?: { title: string; sub: string; skipLabel: string; onSkip: () => void } }) {
  const load = useDevices((s) => s.load);
  const [said1, setSaid] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phoneLink, setPhoneLink] = useState("");
  const [place, setPlace] = useState<"linux" | "mac">("linux");
  const [command, setCommand] = useState("");
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // A phone's key is signed onto the name's list by this app (the server holds no identity): asked while this screen is up and again on the wink events, so a typed code's yes is served too.
  useEffect(() => {
    if (kind === "server") return;
    const run = () => { void import("../../src/real/enrol-phone").then((m) => m.serveEnrol()).catch(() => {}); };
    const t = setInterval(run, 2000);
    return () => clearInterval(t);
  }, [kind]);

  const finish = () => { setDone(true); void load(); };
  const noun = kind === "phone" ? "phone" : kind === "server" ? "server" : "computer";
  const addComputer = () => {
    setBusy(true);
    tool("onboard.computer.add", { url: url.trim(), password, ...(username.trim() ? { username: username.trim() } : {}) })
      .then(() => { if (live.current) { setSaid(""); finish(); } })
      .catch((e) => { if (live.current) setSaid(said(e)); })
      .finally(() => { if (live.current) setBusy(false); });
  };
  const addPhone = () => {
    setBusy(true);
    tool<{ spaces?: { id?: string; name?: string }[]; current?: string | null }>("onboard.space.list", {})
      .then((list) => {
        const rows = Array.isArray(list?.spaces) ? list.spaces : [];
        const hit = rows.find((s) => s.id && s.id === list?.current) || rows[0];
        if (!hit) throw Object.assign(new Error("Create or join a space first."), { code: "no_space" });
        return tool<{ link?: string }>("onboard.phone.add", { space: hit.name || hit.id });
      })
      .then((r) => { if (live.current) { setPhoneLink(String(r?.link || "")); setSaid(""); finish(); } })
      .catch((e) => { if (live.current) setSaid(said(e)); })
      .finally(() => { if (live.current) setBusy(false); });
  };
  const openServer = () => {
    setBusy(true);
    tool<{ command?: string }>("onboard.space.open", { kind: place })
      .then((r) => { if (live.current) { setCommand(String(r?.command || "")); setSaid(""); } })
      .catch((e) => { if (live.current) setSaid(said(e)); })
      .finally(() => { if (live.current) setBusy(false); });
  };

  let body: React.ReactNode;
  if (done && kind !== "server") {
    body = (
      <Card className="items-center gap-s3">
        <Chip tone="ok" icon="check">Done</Chip>
        <Text strong>{`The ${noun} is added`}</Text>
        {phoneLink ? <Text mono selectable className="w-full text-center">{phoneLink}</Text> : null}
        <Button size="sm" label="Done" onPress={onDone} />
      </Card>
    );
  } else if (kind === "server") {
    body = (
      <Card className="gap-s3">
        <Text strong>Linux server or always-on Mac</Text>
        <View className="flex-row gap-s2">
          <Button size="sm" kind={place === "linux" ? "primary" : "secondary"} label="Linux" onPress={() => setPlace("linux")} />
          <Button size="sm" kind={place === "mac" ? "primary" : "secondary"} label="Mac" onPress={() => setPlace("mac")} />
        </View>
        <Button kind="primary" label={busy ? "Asking" : "Show the install command"} onPress={busy ? () => {} : openServer} />
        {command ? <Text mono selectable>{command}</Text> : null}
      </Card>
    );
  } else if (kind === "phone") {
    body = (
      <Card className="gap-s3">
        <Text strong>Add your phone</Text>
        <Text tone="muted">The phone opens a link and joins the space.</Text>
        <Button kind="primary" label={busy ? "Asking" : "Make the link"} onPress={busy ? () => {} : addPhone} />
      </Card>
    );
  } else {
    body = (
      <Card className="gap-s3">
        <Text strong>Add this computer</Text>
        <Text tone="muted">It connects to every space you belong to. The master password unlocks the vault.</Text>
        <Field label="Space address" value={url} onChangeText={setUrl} placeholder="https://juniper.vyre.run" />
        <Field label="Username" value={username} onChangeText={setUsername} />
        <PasswordField label="Master password" meter value={password} onChangeText={setPassword} />
        <Button kind="primary" label={busy ? "Adding" : "Add this computer"} onPress={busy ? () => {} : addComputer} />
      </Card>
    );
  }
  if (first) {
    return (
      <View className="gap-s4">
        <View className="gap-s1"><Text size="page" strong>{first.title}</Text><Text tone="muted">{first.sub}</Text></View>
        {said1 ? <Banner tone="warn">{said1}</Banner> : null}
        {body}
        {done ? null : <Button kind="ghost" label={first.skipLabel} onPress={first.onSkip} />}
      </View>
    );
  }
  return (
    <Page title={`Add a ${noun}`} sub={kind === "server" ? "One install command" : kind === "phone" ? "A link the phone opens" : "The space address and your master password"}>
      {said1 ? <Banner tone="warn">{said1}</Banner> : null}
      {body}
      <View className="flex-row justify-center"><Button kind="ghost" size="sm" icon="chevron-left" label="Back" onPress={onBack} /></View>
    </Page>
  );
}
