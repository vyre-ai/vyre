import { useEffect, useState } from "react";
import { Banner, Button, Card, Row, Text, showToast } from "@vyre/ui";
import { Group } from "../places/Frame";
import { dayOf } from "../../src/time/show.js";
import { getHost, hostWanted } from "../../src/host";
import { changeGithubDevice, githubAccount, githubDevices, githubReturnWaiting, linkGithub, signInWithGithub, type GithubDevice } from "../../src/real/github";

/** Settings > Account: link or unlink GitHub. GitHub proves who you are on a new device; the password still opens your vault. Unlinking deletes the stored copy of your key at once. */
export function GithubCard() {
  const [linked, setLinked] = useState<{ login: string; since: number } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [say, setSay] = useState("");
  const [devs, setDevs] = useState<GithubDevice[]>([]);
  const loadDevs = () => { void githubDevices().then(setDevs); };
  // A page with its own host (the Mac and web app, no daemon): the person's name and keys are the host's, and the link is made at each of their spaces through the sign-in door (host-core identity.github.link).
  const viaHost = hostWanted();
  const hostStatus = () => getHost().call("identity.status").then((s) => { const l = (s as { github?: string | null }).github; setLinked(l ? { login: l, since: Date.now() } : null); }).catch(() => setLinked(null));
  useEffect(() => { if (viaHost) void hostStatus(); else { void githubAccount("status").then((r) => setLinked(r.ok ? r.linked : null)); loadDevs(); } }, []);
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
    // in a browser the tab goes to GitHub and comes back here, where the effect below finishes the link
    if (!s.ok) { setBusy(false); if ((s as { code?: string }).code !== "redirect") setSay(s.say); return; }
    if (viaHost) {
      try { await getHost().call("identity.github.link", { session: s.session, user: s.user }); } catch (e) { setBusy(false); setSay(String((e as Error)?.message || "GitHub could not be linked. Try again.")); return; }
      setBusy(false); showToast(`GitHub account ${s.user.login} is linked.`); await hostStatus(); return;
    }
    const r = await linkGithub(s.session, s.user);
    setBusy(false);
    if (!r.ok) { setSay(r.say); return; }
    showToast(`GitHub account ${s.user.login} is linked.`);
    const st = await githubAccount("status");
    setLinked(st.ok ? st.linked : null);
  };
  // Back from GitHub in this tab: finish the link it started.
  useEffect(() => { if (githubReturnWaiting()) void link(); }, []);
  const unlink = async () => {
    setBusy(true); setSay("");
    const r = await githubAccount("unlink");
    setBusy(false);
    if (!r.ok) { setSay(r.say); return; }
    setLinked(null);
    showToast("GitHub is unlinked and your stored key is deleted.");
  };
  return (
    <Group title="GitHub" note="On a new device, signing in with GitHub and then your password gets you in. Anyone who controls your GitHub account can add a device the same way, so protect it with two-factor sign-in. Update every server of yours before linking. Unlinking also deletes the stored key; remove any device below that you do not know.">
      <Card className="gap-s3">
        {linked === undefined ? <Text tone="muted">Checking.</Text> : linked
          ? <Row title={`Linked to ${linked.login}`} sub={`Since ${dayOf(linked.since)}`} end={viaHost ? undefined : <Button size="sm" kind="secondary" label="Unlink" loading={busy} disabled={busy} onPress={() => { void unlink(); }} />} className="px-0" />
          : <Row title="Not linked" sub="Link your GitHub account to sign in with it on new devices." end={<Button size="sm" label="Link GitHub" loading={busy} disabled={busy} onPress={() => { void link(); }} />} className="px-0" />}
        {devs.map((d) => (
          <Row key={d.eid} title={d.confirmed ? "Signed in with GitHub" : "Signed in with GitHub, waiting for you"} sub={`${dayOf(d.since)} · ${d.confirmed ? "confirmed" : "it cannot change who speaks for you until you confirm it"}`} className="px-0"
            end={<>{d.confirmed ? null : <Button size="sm" label="Confirm" disabled={busy} onPress={() => { void change("confirm", d.eid); }} />}<Button size="sm" kind="secondary" label="Remove" disabled={busy} onPress={() => { void change("remove", d.eid); }} /></>} />
        ))}
        {say ? <Banner tone="warn" icon="info">{say}</Banner> : null}
      </Card>
    </Group>
  );
}
