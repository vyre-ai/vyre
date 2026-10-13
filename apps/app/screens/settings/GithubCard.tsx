import { useEffect, useState } from "react";
import { Banner, Button, Card, Row, Text, showToast } from "@vyre/ui";
import { Group } from "../places/Frame";
import { changeGithubDevice, githubAccount, githubDevices, linkGithub, signInWithGithub, type GithubDevice } from "../onboard/real-github";

/** Settings > Account: link or unlink GitHub. GitHub proves who you are on a new device; the master password still opens your vault. Unlinking deletes the stored copy of your key at once. */
export function GithubCard() {
  const [linked, setLinked] = useState<{ login: string; since: number } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [devs, setDevs] = useState<GithubDevice[]>([]);
  const loadDevs = () => { void githubDevices().then(setDevs); };
  useEffect(() => { void githubAccount("status").then((r) => setLinked(r.ok ? r.linked : null)); loadDevs(); }, []);
  const change = async (action: "confirm" | "remove", eid: string) => {
    setBusy(true); setSay("");
    const r = await changeGithubDevice(action, eid);
    setBusy(false);
    if (!r.ok) { setSay(r.say); return; }
    showToast(action === "confirm" ? "That device is confirmed." : "That device is off your list.");
    loadDevs();
  };
  const link = async () => {
    setBusy(true); setSay("");
    const s = await signInWithGithub({ signin: false });
    if (!s.ok) { setBusy(false); setSay(s.say); return; }
    const r = await linkGithub(s.session, s.user);
    setBusy(false);
    if (!r.ok) { setSay(r.say); return; }
    showToast(`GitHub account ${s.user.login} is linked.`);
    const st = await githubAccount("status");
    setLinked(st.ok ? st.linked : null);
  };
  const unlink = async () => {
    setBusy(true); setSay("");
    const r = await githubAccount("unlink");
    setBusy(false);
    if (!r.ok) { setSay(r.say); return; }
    setLinked(null);
    showToast("GitHub is unlinked and your stored key is deleted.");
  };
  return (
    <Group title="GitHub" note="On a new device, signing in with GitHub and then your master password gets you in. Anyone who controls your GitHub account can add a device the same way, so protect it with two-factor sign-in. Update every server of yours before linking. Unlinking also deletes the stored key; remove any device below that you do not know.">
      <Card className="gap-s3">
        {linked === undefined ? <Text tone="muted">Checking.</Text> : linked
          ? <Row title={`Linked to ${linked.login}`} sub={`Since ${new Date(linked.since).toLocaleDateString()}`} end={<Button size="sm" kind="secondary" label="Unlink" loading={busy} disabled={busy} onPress={() => { void unlink(); }} />} className="px-0" />
          : <Row title="Not linked" sub="Link your GitHub account to sign in with it on new devices." end={<Button size="sm" label="Link GitHub" loading={busy} disabled={busy} onPress={() => { void link(); }} />} className="px-0" />}
        {devs.map((d) => (
          <Row key={d.eid} title={d.confirmed ? "Signed in with GitHub" : "Signed in with GitHub, waiting for you"} sub={`${new Date(d.since).toLocaleString()} · ${d.confirmed ? "confirmed" : "it cannot change who speaks for you until you confirm it"}`} className="px-0"
            end={<>{d.confirmed ? null : <Button size="sm" label="Confirm" disabled={busy} onPress={() => { void change("confirm", d.eid); }} />}<Button size="sm" kind="secondary" label="Remove" disabled={busy} onPress={() => { void change("remove", d.eid); }} /></>} />
        ))}
        {say ? <Banner tone="warn" icon="info">{say}</Banner> : null}
      </Card>
    </Group>
  );
}
