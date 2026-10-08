import { useEffect, useRef, useState } from "react";
import { spaceName as spaceNameOf } from "../../src/state/space-name.js";
import { Linking, Platform, ScrollView, Share, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Divider, Field, Row, Ring, Segmented, Text, showToast, type IconName, spaceRef, IconTile } from "@vyre/ui";
import { FaceIdSheet, type FaceAsk } from "../shell/FaceIdSheet";
import { loadInstall } from "./data";
import { MyCloudCard } from "../settings/MyCloudCard";
import { AddServerCard } from "../settings/AddServerCard";
import { AFTER_HOME, CONTINUE_HERE, SERVER_FAILED, serverSay, RECOVERY_CODE, SERVER_LONG_CODE, backOf, connectedLine, isResumable, nextSetup, packProgress, unpackProgress, homeLine, nameNote, nameStatus, slug, startStep } from "./flow.js";
import { PairEntry, PairServer, PairWords, openPairing, type LongCode } from "../devices/PairParts";
import { RealAdd } from "../devices/RealAdd";
import { TypeCode, redeemInvite, redeemPairing } from "../devices/TypeCode";
import { RealInvite } from "../devices/RealInvite";
import { isWindowsShell, shell } from "../../src/shell/shell";
import { pairSayHere } from "../../src/real/pair-say";
import { FIRST, firstChoices, codeLooksRight, codeRoute, ADD_PHONE, BROWSER, NO_VYRE, WELCOME, WHO, deviceKind, firstStep, isPhone, isWho, offersNoVyre, whoLine } from "./first-run.js";
import { COPY } from "../devices/wink.js";
import { inviteRefusal } from "../devices/invite.js";
import { parseWinkCode } from "../../src/api/wink-code";
import { readProgress, writeProgress, writeSkipped } from "../../src/state/setup-progress";
import { wordsLine, type PairingSession } from "../../src/api/pairing-session";
import { MOCK, said, tool } from "../../src/real/box";
import { ConnectClaude } from "../settings/ConnectClaude";
import { hadIdentity, recoverIdentity } from "../../src/identity/restore";
import { addDeviceToName, addSay } from "../../src/identity/add-device";
import { payloadOf } from "../devices/real.js";
import { recoveryKeyOptions } from "../../src/keys";
import { HAVE, nameOf, recoverCheck, recoverRefusal, successToast } from "./have-model.js";
import { clearJoin } from "../../src/shell/join-hold.js";
import { acceptInvite, checkName, claimSetup, createIdentity, reservedName, createSpace, kitChoices, makeServerSpace, listSpaces, previewInvite, proposeKitFor, readIdentity, resumeSpace, saveSetup } from "../../src/real/install";
import { serversOf } from "../settings/my-cloud.js";
import { applyClaim, createInput, inviteFrom, nameNoteReal, pendingLines, nameStatusReal, savesAt, setupElsewhere, setupFrom } from "./real.js";
import { claimBlocked } from "../shell/rc";
import { setupElsewhere as setupElsewhereLine } from "./flow.js";

type Made = { name: string; look: string; addr: string; line: string };
const DATA = loadInstall();
const parseSample = () => parseWinkCode(SERVER_LONG_CODE) as LongCode;

function Page({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <View className="gap-s4">
      <View className="gap-s1"><Text size="page" strong>{title}</Text>{sub ? <Text tone="muted">{sub}</Text> : null}</View>
      {children}
    </View>
  );
}

function Choice({ icon, title, sub, onPress }: { icon: IconName; title: string; sub: string; onPress: () => void }) {
  return <Row lead={<IconTile name={icon} />} title={title} sub={sub} onPress={onPress} />;
}

function Terminal({ lines, cursor }: { lines: string[]; cursor?: string }) {
  return (
    <Card className="gap-s1 bg-surface-1">
      {lines.map((l, i) => <Text key={i} mono size="caption">{l || " "}</Text>)}
      {cursor !== undefined ? <Text mono size="caption">{cursor}_</Text> : null}
    </Card>
  );
}

function CopyLine({ text, big }: { text: string; big?: boolean }) {
  return (
    <Card className="flex-row items-center gap-s3">
      <Text mono size={big ? "title" : "body"} className="flex-1">{text}</Text>
      <Button size="sm" label="Copy" onPress={() => { Clipboard.setStringAsync(text).catch(() => {}); showToast("Copied"); }} />
    </Card>
  );
}

function NameField({ value, onChange, label, also, space, real, onRetry }: { value: string; onChange: (v: string) => void; label: string; also?: string[]; space?: boolean; real?: ReturnType<typeof nameStatusReal>; onRetry?: () => void }) {
  const st = real ?? nameStatus(value, also);
  const note = real ? nameNoteReal(real, !!space) : nameNote(st as ReturnType<typeof nameStatus>, !!space);
  return (
    <View className="gap-s2">
      <Field label={label} value={value} onChangeText={onChange} placeholder="name" help=".vyre.run goes after it" />
      <View className="min-h-s6">{st.state === "empty" ? null : <View className="flex-row flex-wrap items-center gap-s2"><Chip tone={st.state === "ok" ? "ok" : st.state === "taken" || st.state === "unknown" ? "warn" : "plain"} icon={st.state === "ok" ? "check" : undefined}>{note}</Chip>{st.state === "unknown" && onRetry ? <Button kind="ghost" size="sm" label="Check again" onPress={onRetry} /> : null}</View>}</View>
    </View>
  );
}

/** The install flow, one thing per screen. `start` is the route: first run, create a space, or join one. */
export function InstallScreen({ start, link: linkIn, external }: { start?: "create" | "join" | "phone" | "connect" | "server"; link?: string; external?: boolean }) {
  const router = useRouter();
  const first = !start;
  // Each device offers only what it can do: a phone holds the key and connects, a Mac can host Vyre, a browser holds nothing (DESIGN-first-run-per-platform).
  const dk = deviceKind(Platform.OS, !!shell());
  const canClaim = MOCK || !claimBlocked();
  const [step, setStep] = useState(start === "connect" && dk === "web" && !canClaim ? "browser" : start ? startStep(start) : firstStep(dk, canClaim));
  // A Mac's first run chooses where Vyre runs before the space is named; set when it did.
  const [who, setWho] = useState("team");
  // Adding this device to a name by its long code: the three words this device derived, shown for the person to check on the other device.
  const [addWords, setAddWords] = useState("");
  const [name, setName] = useState("");
  const [spaceName, setSpaceName] = useState(DATA.defaultSpaceName);
  const [addr, setAddr] = useState<string | null>(null);
  const [look, setLook] = useState("amber");
  const where = "server" as const;
  const [made, setMade] = useState<Made[]>([]);
  const [face, setFace] = useState<FaceAsk | null>(null);
  const [wrong, setWrong] = useState("");
  const [session, setSession] = useState<PairingSession | null>(null);
  const [pairTo, setPairTo] = useState("me");
  const [pickConnectors, setPickConnectors] = useState<string[]>([]);
  const [pickKit, setPickKit] = useState<string | null>(null);
  const [reserveCode, setReserveCode] = useState("");
  const [reservedAddress, setReservedAddress] = useState("");
  const [recName, setRecName] = useState("");
  const [recCode, setRecCode] = useState("");
  const [recPass, setRecPass] = useState("");
  const [lostKey, setLostKey] = useState(false);
  // Real box: the Kits it offers (null: it offers none) and what asking for the picked one came to, for the done page.
  const [kitList, setKitList] = useState<{ id: string; label: string; sub: string }[] | null | undefined>(undefined);
  const [kitResult, setKitResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [inviteLine, setInviteLine] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Real box only: what the directory said about each name, the space being made, the recovery code (shown once, never kept), another device's setup, the invite.
  const [taken, setTaken] = useState<Record<string, "free" | "taken" | "unknown">>({});
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [owned, setOwned] = useState(0);
  const noId = useRef(false);
  const [recheck, setRecheck] = useState(0);
  const [elsewhere, setElsewhere] = useState<ReturnType<typeof setupElsewhere>>([]);
  const [link, setLink] = useState(linkIn ?? "");
  // A link that opened the app (vyre://join?link=... or /join?link=...): read the card at once, no paste.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (MOCK || !linkIn || opened.current === linkIn) return;
    opened.current = linkIn;
    setLink(linkIn); setBusy(true); setWrong("");
    previewInvite(linkIn.trim()).then((p) => { setInvite(inviteFrom(p, linkIn.trim())); setStep((s) => (noId.current ? s : "invite")); }).catch((e) => setWrong(inviteRefusal((e as { code?: string }).code, said(e)))).finally(() => setBusy(false));
  }, [linkIn]);
  const [invite, setInvite] = useState<ReturnType<typeof inviteFrom> | null>(null);
  const device = Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "phone" : dk === "mac" ? "Mac" : "computer";
  const me = MOCK ? nameStatus(name) : nameStatusReal(name, taken[slug(name)] ?? null);
  const spaceSlug = addr ?? slug(spaceName);
  const spaceSt = MOCK ? nameStatus(spaceSlug, [name]) : nameStatusReal(spaceSlug, taken[slug(spaceSlug)] ?? null, [name]);
  const sn = spaceName.trim() || DATA.defaultSpaceName;
  // Opened from Spaces on Create or Join, the first step has nothing behind it: Close goes back to Spaces.
  const back = !first && step === startStep(start) ? null : backOf(step, { have: !MOCK && !claimBlocked(), welcome: first && !lostKey, browser: dk === "web" && !canClaim, first });
  // The empty states open Add your phone and Connect: when they end the person is back on Now, not on Spaces.
  const startAdd = (payload: string) => {
    setWrong(""); setAddWords(""); setStep("adding");
    void addDeviceToName({ payload, deviceLabel: device, onWords: setAddWords })
      .then((r) => { noId.current = false; setName(r.name); setStep(invite ? "invite" : "spaces"); })
      .catch((e) => { setWrong(addSay((e as { code?: string }).code)); setStep(scanStep); });
  };
  const finish = () => router.replace((first || start === "phone" || start === "connect" ? "/u/now" : "/u/spaces") as never);
  const scanStep = dk === "web" && !canClaim ? "browser" : "scan";
  // After a name is made, a Mac chooses where Vyre runs; everything else goes to the spaces.
  const afterName = () => (invite ? "invite" : "spaces");
  const afterIdentity = () => (invite ? "invite" : first ? "choose" : afterName());
  // The space has its home (the server is paired, or it lives here): setup carries on by itself on this device, with no refresh and no second sign-in.
  const make = (w: "server") => {
    setMade((m) => [...m, { name: sn, look, addr: `${spaceSt.slug}.vyre.run`, line: homeLine(w) }]);
    // A Mac's first run adds the phone that approves, once Vyre has a home to pair it to.
    setStep(AFTER_HOME);
  };
  // The real box makes the space first (spaces.create), then setup carries on. A failure stays on the step with the box's words.
  const makeReal = async (w: "server") => {
    setBusy(true); setWrong("");
    try {
      // On a server this device is paired to, the device makes the space itself and the directory claim follows (claimServerSpace); a browser says "Make this space in Vyre on your phone".
      if (w === "server" && (await readIdentity().catch(() => null))) {
        const id = await makeServerSpace(spaceSt.slug, sn);
        setSpaceId(id);
        make(w);
        return;
      }
      let r = await createSpace(createInput({ slug: spaceSt.slug, name: sn, where: w }));
      if (r.state === "running" && r.id) r = await resumeSpace(r.id);
      if (r.state !== "done") { setWrong(r.say || "Setting up the space did not finish."); if (r.id) setSpaceId(r.id); return; }
      setSpaceId(r.id);
      make(w);
    } catch (e) { setWrong(said(e)); } finally { setBusy(false); }
  };
  const doMake = (w: "server") => (MOCK ? make(w) : void makeReal(w));
  // The invite token lives only as long as the join steps: leaving them (cancel, done, any other step) forgets it.
  useEffect(() => {
    if (MOCK || !codeLooksRight(reserveCode)) { setReservedAddress(""); return; }
    let live = true;
    void reservedName(reserveCode.trim().toUpperCase()).then((n) => { if (live) setReservedAddress(n ? `${n}.vyre.run` : ""); });
    return () => { live = false; };
  }, [reserveCode]);
  useEffect(() => { if (step !== "join" && step !== "invite") clearJoin(); }, [step]);
  const advance = (from: string) => {
    if (from === "kit" && !MOCK && spaceId && pickKit) {
      setBusy(true);
      void proposeKitFor(spaceId, pickKit).then((r) => { setKitResult(r); setStep(nextSetup(from, who)); }).finally(() => setBusy(false));
      return;
    }
    setStep(nextSetup(from, who));
  };
  useEffect(() => { if (!MOCK && step === "kit" && kitList === undefined) void kitChoices().then(setKitList); }, [step]);

  // Closing and reopening resumes at the same step: read what was kept once, then keep every resumable step.
  useEffect(() => {
    readProgress().then((raw) => {
      const p = unpackProgress(raw);
      if (p && start !== "join") {
        setName(p.name); setSpaceName(p.spaceName); setAddr(p.addr); setLook(p.look); setPairTo(p.pairTo);
        setPickConnectors(p.picks?.connectors ?? []); setPickKit(p.picks?.kit ?? null); setWho(isWho(p.who) ? p.who : "team");
        setStep(p.step);
      }
      setLoaded(true);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Real box: who this device already is, and setups other devices left unfinished.
  useEffect(() => {
    if (MOCK) return;
    void (async () => {
      try {
        const me0 = await readIdentity();
        if (me0) { setName(me0.label); setStep((s) => (first && (s === "name" || s === "welcome") ? "choose" : s)); }
        // Identity first: a device with no name cannot create or join a space, so any other way in starts at the name. A kept invite waits for it.
        else {
          noId.current = true;
          // A phone that once held a name and lost its key (after a restart) opens where it can bring the name back, saying so.
          const lost = !claimBlocked() && (await hadIdentity().catch(() => false));
          if (lost) setLostKey(true);
          setStep((s) => (["scan", "scanwords", "recovery", "have", "recover", "browser", "nosetup"].includes(s) ? s : lost ? "have" : s === "welcome" ? s : !canClaim ? "browser" : "name"));
        }
        // The box names the device a setup is on but the app does not know its own device id: a setup this device began is the one whose name matches the progress it kept.
        const kept = unpackProgress(await readProgress());
        const all = await listSpaces();
        setOwned(all.length);
        // A first run with a name and no space yet (closed after the name) carries on at the three choices.
        if (first && all.length === 0) setStep((s) => (s === "spaces" ? "choose" : s));
        const mine = kept ? all.find((r) => r.setup && spaceNameOf(r) === kept.spaceName)?.id ?? null : null;
        if (mine) setSpaceId(mine);
        setElsewhere(setupElsewhere(all, mine));
      } catch (e) {
        // First run, naming yourself: there is no box yet, and none is needed (the name goes to the directory). Say nothing about it.
        if (!(first && (step === "name" || step === "welcome" || step === "browser"))) setWrong(said(e));
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Each name the person types is asked of the directory once it is long enough, after they stop typing.
  const asked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (MOCK) return;
    const want = [step === "name" ? slug(name) : "", step === "create" ? slug(spaceSlug) : ""].filter((n) => n.length >= 3 && !asked.current.has(n));
    if (!want.length) return;
    const t = setTimeout(() => want.forEach((n) => { asked.current.add(n); void checkName(n).then((a) => { if (a === "unknown") asked.current.delete(n); setTaken((m) => ({ ...m, [n]: a })); }); }), 400);
    return () => clearTimeout(t);
  }, [step, name, spaceSlug, recheck]);
  // Every setup step is kept on the box so another device can carry on; the last one clears it.
  useEffect(() => {
    if (MOCK || !spaceId) return;
    if (savesAt(step)) void saveSetup(spaceId, setupFrom({ step, name: sn, addr: spaceSt.slug || null, look, where, connectors: pickConnectors, kit: pickKit, who })).catch((e) => setWrong(said(e)));
    else if (step === "done") void saveSetup(spaceId, null).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, spaceId, look, who, pickConnectors, pickKit]);
  const lastKept = useRef("");
  useEffect(() => {
    if (!loaded) return;
    const raw = isResumable(step) ? packProgress({ step, name, spaceName, addr, look, where, pairTo, device, who, picks: { connectors: pickConnectors, kit: pickKit } }) : null;
    if (raw === lastKept.current) return;
    lastKept.current = raw ?? "";
    // A step that is not resumable (done, spaces, join) means setup is over or not begun: forget it.
    if (raw !== null || step === "done" || step === "spaces") writeProgress(raw);
  }, [loaded, step, name, spaceName, addr, look, where, pairTo, device, who, pickConnectors, pickKit]);
  const retryName = (n: string) => () => { asked.current.delete(slug(n)); setTaken((m) => { const { [slug(n)]: _gone, ...rest } = m; return rest; }); setRecheck((x) => x + 1); };
  const canClose = !first || made.length > 0 || owned > 0;
  const last = made[made.length - 1];
  const inv = MOCK ? DATA.invite : invite ?? { ...DATA.invite, space: "", address: "", from: "", role: "", roleLine: "", sees: "", link: "" };

  // "Set up My Cloud" on a Mac that can be the server: the person sees what it means, confirms, and only then does the Mac set itself up (at the end of this flow, never on a press elsewhere).
  const [macSure, setMacSure] = useState(false);
  const [macOther, setMacOther] = useState(false);
  let body: React.ReactNode = null;
  if (step === "welcome") {
    body = (
      <Page title={WELCOME.title} sub={WELCOME.line}>
        <Button kind="primary" label={WELCOME.start} onPress={() => setStep("name")} />
        <Button kind="ghost" label={WELCOME.have} onPress={() => setStep(MOCK || claimBlocked() ? "scan" : "have")} />
      </Page>
    );
  } else if (step === "choose") {
    const pick = (id: string) => () => {
      setWrong("");
      if (id === "join") return setStep("join");
      if (id === "server") return setStep("mycloud");
      // My Home: this Mac runs Vyre itself (the light login-only setup, no password); the Mac app does the install, then setup is done here.
      const make = shell()?.identity?.makeServer;
      if (MOCK || !make) return finish();
      setBusy(true);
      void make().then(finish).catch((e) => setWrong(said(e))).finally(() => setBusy(false));
    };
    const rows = firstChoices(dk);
    body = (
      <Page title={FIRST.title}>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <Card flush>
          {rows.map((id, i) => {
            const c = FIRST[id as "join" | "server" | "home"];
            const extra = id === "server" ? (isWindowsShell() ? FIRST.server.upgrades.windows : dk === "mac" ? FIRST.server.upgrades.mac : "") : "";
            return <View key={id}>{i ? <Divider /> : null}<Choice icon={id === "join" ? "share" : id === "server" ? "server" : "laptop"} title={c.title} sub={extra ? `${c.line} ${extra}` : c.line} onPress={pick(id)} /></View>;
          })}
        </Card>
        {isWindowsShell() ? <Text tone="muted">{FIRST.windows}</Text> : null}
      </Page>
    );
  } else if (step === "mycloud") {
    // Upgrade to My Cloud (Settings has the same card): what a server unlocks, the two choices, the install line, the words, then the move.
    body = (
      <Page title="My Cloud" sub="Add a server and move what you have onto it.">
        <MyCloudCard />
        {first ? <Button kind="ghost" label="Skip for now" onPress={finish} /> : null}
      </Page>
    );
  } else if (step === "browser" || (step === "name" && !MOCK && claimBlocked())) {
    // A browser holds no key, so it cannot claim a name (screens/shell/rc.ts): it connects from a phone that has one.
    body = (
      <Page title={BROWSER.title} sub={BROWSER.line}>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <PairEntry onCode={(c: LongCode) => { setWrong(""); if (!MOCK && codeRoute(c) === "add-device") { startAdd(payloadOf(c)); return; } setSession(openPairing(c)); setStep("scanwords"); }} />
        {MOCK ? null : <TypeCode redeem={redeemPairing} onDone={() => { noId.current = false; setStep("spaces"); }} />}
        <Button kind="ghost" label={BROWSER.notSet} onPress={() => setStep("nosetup")} />
      </Page>
    );
  } else if (step === "nosetup") {
    body = (
      <Page title={BROWSER.notSetTitle} sub={BROWSER.notSetLine}>
        <Button kind="primary" label={BROWSER.openSite} onPress={() => { Linking.openURL(BROWSER.site).catch(() => {}); }} />
      </Page>
    );
  } else if (step === "name") {
    // A person's first name is reserved on the web (vyre.run/setup) and finished here with the key this device makes: paste the code the page gave.
    const held = MOCK ? "alex.vyre.run" : reservedAddress;
    body = (
      <Page title="Paste your code" sub={isWindowsShell() ? "You reserved your name at vyre.run/setup. Paste the code it gave you. Vyre makes your key with Windows Hello. It asks for your face, fingerprint or PIN." : MOCK ? "You reserved your name at vyre.run/setup. Paste the code it gave you. Vyre makes your key on this Mac, and the key never leaves it." : `You reserved your name at vyre.run/setup. Paste the code it gave you. Vyre makes your key on this ${device}, and the key never leaves it.`}>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <Field label="Code" value={reserveCode} onChangeText={(v: string) => { setReserveCode(v); setWrong(""); }} placeholder="VYRE-XXXX-XXXX-XXXX-XXXX" help="It works once, for 24 hours." />
        {held ? <Text tone="muted">{held} is yours.</Text> : null}
        <Button kind="primary" label={busy ? "Creating your name" : "Continue"} disabled={!codeLooksRight(reserveCode) || busy}
          onPress={() => { if (MOCK) return setStep("recovery"); setBusy(true); setWrong(""); void createIdentity(reserveCode, device).then((r) => { setRecovery(r.recoveryCode); setStep("recovery"); }).catch((e) => setWrong(said(e))).finally(() => setBusy(false)); }} />
        <Button kind="ghost" label="I need a code" onPress={() => { Linking.openURL("https://vyre.run/setup").catch(() => {}); }} />
        <Button kind="ghost" label={WELCOME.have} onPress={() => setStep(MOCK || claimBlocked() ? "scan" : "have")} />
      </Page>
    );
  } else if (step === "have") {
    body = (
      <Page title={lostKey ? HAVE.lostKeyTitle : HAVE.title} sub={lostKey ? HAVE.lostKeyLine : HAVE.line}>
        <Card flush>
          <Choice icon="share" title={HAVE.addTitle} sub={HAVE.addLine} onPress={() => setStep("scan")} />
          <Divider />
          <Choice icon="key" title={HAVE.codeTitle} sub={HAVE.codeLine} onPress={() => { setWrong(""); setStep("recover"); }} />
        </Card>
      </Page>
    );
  } else if (step === "recover") {
    body = (
      <Page title={HAVE.recoverTitle}>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <Field label={HAVE.nameLabel} value={recName} onChangeText={setRecName} help={HAVE.nameHelp} />
        <Field label={HAVE.codeLabel} value={recCode} onChangeText={setRecCode} help={HAVE.codeHelp} mono />
        <Field label={HAVE.passwordLabel} value={recPass} onChangeText={setRecPass} kind="password" help={HAVE.passwordHelp} />
        <Button kind="primary" label={busy ? HAVE.busy : HAVE.go} disabled={busy || !recName.trim() || !recCode.trim()} onPress={() => {
          const bad = recoverCheck({ name: recName, code: recCode });
          if (bad) { setWrong(bad.say); return; }
          setBusy(true); setWrong("");
          void recoveryKeyOptions().then((k) => recoverIdentity({ name: nameOf(recName), code: recCode, password: recPass || undefined, deviceLabel: device, ...k }))
            .then((r) => { setName(r.name); setRecCode(""); setRecPass(""); setLostKey(false); noId.current = false; showToast(successToast(r.name)); setStep(invite ? "invite" : "spaces"); })
            .catch((e) => setWrong(recoverRefusal((e as { code?: string }).code)))
            .finally(() => setBusy(false));
        }} />
        <Button kind="ghost" label={HAVE.rather} onPress={() => { setWrong(""); setStep("scan"); }} />
      </Page>
    );
  } else if (step === "scan") {
    body = (
      <Page title={MOCK ? "Scan from your other device" : HAVE.scanTitle} sub={MOCK ? "Open Vyre on a device that has your name and scan this, or paste the long code on it." : HAVE.scanLine}>
        {MOCK ? <View className="w-ring self-center"><Ring seed={4} /></View> : null}
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        {MOCK ? <Button kind="primary" label="Simulate the scan" onPress={() => { setSession(openPairing(parseSample())); setStep("scanwords"); }} /> : <>
          <PairEntry onCode={(c: LongCode) => { if (claimBlocked() && codeRoute(c) === "pair-server") { setSession(openPairing(c)); setStep("scanwords"); return; } startAdd(payloadOf(c)); }} />
          {claimBlocked() ? null : <TypeCode redeem={(code, onAck) => addDeviceToName({ code, deviceLabel: device, onAck }).then((r) => { noId.current = false; setName(r.name); return {}; })} onDone={() => setStep(invite ? "invite" : "spaces")} />}
        </>}
        {offersNoVyre(dk, MOCK) ? <Button kind="ghost" label={NO_VYRE.have} onPress={() => setStep("novyre")} /> : null}
      </Page>
    );
  } else if (step === "novyre") {
    // Phone only. A phone connects to a Vyre that runs on a computer or a server; with none yet it can send itself the setup link. No install line, no server choice here.
    body = (
      <Page title={NO_VYRE.title} sub={NO_VYRE.line}>
        <Button kind="primary" label={NO_VYRE.send} onPress={() => { Share.share({ message: NO_VYRE.share }).catch(() => {}); }} />
        <Button kind="ghost" label={NO_VYRE.notNow} onPress={() => { void writeSkipped(true).finally(() => router.replace("/u/now" as never)); }} />
      </Page>
    );
  } else if (step === "adding") {
    body = (
      <Page title="Check the three words" sub="Say yes on your other device only if it shows the same three words.">
        {addWords ? <Card className="items-center"><Text mono strong size="title" className="text-center">{addWords}</Text></Card> : <Text tone="muted">Reaching your other device.</Text>}
      </Page>
    );
  } else if (step === "scanwords") {
    body = session ? (
      <Page title="Check the three words" sub="Your other device shows the same three words.">
        <PairServer session={session} who={dk === "web" || isPhone(dk) ? "Your phone" : "Your other device"} onConfirmed={() => { noId.current = false; if (MOCK) setName("alex"); else void readIdentity().then((w) => w && setName(w.label)).catch(() => {}); setStep(invite ? "invite" : "spaces"); }} onRejected={(say) => { setSession(null); setWrong(say ?? pairSayHere(COPY.rejected)); setStep(scanStep); }} />
      </Page>
    ) : null;
  } else if (step === "recovery") {
    body = (
      <Page title="Save your recovery code" sub="If you lose every device, this is the only way back in.">
        <CopyLine text={MOCK ? RECOVERY_CODE : recovery ?? ""} big />
        {MOCK ? <Banner>You can add a PIN you memorise later, so the paper alone is useless.</Banner> : <Banner>You will not see it again. Anyone who has it can use your name, so keep it somewhere only you can reach.</Banner>}
        <Button kind="primary" label="I saved it" onPress={() => { noId.current = false; setRecovery(null); const next = afterIdentity(); setStep(next); }} />
      </Page>
    );
  } else if (step === "spaces") {
    body = (
      <Page title="Your spaces" sub="A space is where a team or a part of your life keeps its work.">
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        {elsewhere.map((e) => (
          <Card key={e.space} className="gap-s2">
            <Text strong>{e.spaceName}</Text>
            <Text tone="muted">{setupElsewhereLine(e.device)}</Text>
            <Button kind="primary" label={CONTINUE_HERE} onPress={() => void claimSetup(e.space).then((c) => {
              const a = applyClaim(c);
              if (!a) return;
              setSpaceId(a.space); setSpaceName(a.name || e.spaceName); setAddr(a.addr); setLook(a.look); setWho(a.who); setPickConnectors(a.connectors); setPickKit(a.kit); setElsewhere((l) => l.filter((x) => x.space !== e.space)); setStep(a.step);
            }).catch((err) => setWrong(said(err)))} />
          </Card>
        ))}
        <Card flush>
          <Choice icon="plus" title="Create a team space" sub="Name it and pick a look. It runs on a server." onPress={() => setStep("create")} />
          <Divider />
          <Choice icon="share" title="Join a team" sub="Paste the invite link you were sent." onPress={() => setStep("join")} />
        </Card>
        {made.length ? (
          <View className="gap-s2">
            <Text size="caption" strong tone="label">Added</Text>
            <Card flush>{made.map((m, i) => <View key={m.addr + i}>{i ? <Divider /> : null}<Row lead={<Avatar of={spaceRef(m.name)} />} title={m.name} sub={m.line} /></View>)}</Card>
            <Button kind="primary" label="Done" onPress={finish} />
          </View>
        ) : null}
      </Page>
    );
  } else if (step === "create") {
    body = (
      <Page title="Create a team space">
        <Field label="Name" value={spaceName} onChangeText={(v) => { setSpaceName(v); }} />
        <NameField label="Its address" value={spaceSlug} onChange={(v) => setAddr(v)} onRetry={retryName(spaceSlug)} also={[name]} space real={MOCK ? undefined : (spaceSt as ReturnType<typeof nameStatusReal>)} />
        <View className="gap-s2">
          <Text size="caption" strong tone="label">{WHO.label}</Text>
          <Segmented label={WHO.label} value={who} onChange={setWho} options={WHO.options} />
          <Text size="caption" tone="muted">{whoLine(who)}</Text>
        </View>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <Button kind="primary" label={busy ? "Creating it" : "Continue"} disabled={spaceSt.state !== "ok" || busy} onPress={() => {
          // Every space runs on a server: one already paired takes it; if there is none, the add-a-server step runs first, then the space is made on it.
          if (MOCK) return setStep("cmd");
          setBusy(true); setWrong("");
          void tool("spaces.servers").then((r) => { if (serversOf(r).length) doMake("server"); else setStep("cmd"); }).catch((e) => setWrong(said(e))).finally(() => setBusy(false));
        }} />
      </Page>
    );
  } else if (step === "addphone") {
    const done = () => (start === "phone" ? finish() : setStep(AFTER_HOME));
    body = MOCK ? (
      <Page title={ADD_PHONE.title} sub={ADD_PHONE.line}>
        <View className="w-ring self-center"><Ring seed={4} /></View>
        <Text size="caption" tone="muted">{ADD_PHONE.android}</Text>
        <Text size="caption" tone="muted">{ADD_PHONE.iphone}</Text>
        <Text size="caption" tone="muted" className="text-center">{ADD_PHONE.orPaste}</Text>
        <Button kind="primary" label="Simulate the scan" onPress={done} />
        <Button kind="ghost" label={ADD_PHONE.skip} onPress={done} />
      </Page>
    ) : <RealAdd kind="phone" first={{ title: ADD_PHONE.title, sub: ADD_PHONE.line, skipLabel: ADD_PHONE.skip, onSkip: done }} onBack={done} onDone={done} />;
  } else if (step === "cmd") {
    // The one add-a-server piece (screens/settings/AddServerCard.tsx), then the space is made on the server it paired.
    body = (
      <Page title="Add a server" sub="Your team space is made on it.">
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <AddServerCard onDone={() => doMake("server")} />
      </Page>
    );
  } else if (step === "look") {
    body = (
      <Page title={`Give ${sn} a look`} sub="This is how its mark shows on every screen. You can change it later.">
        {MOCK ? <Terminal lines={[connectedLine(sn, device)]} /> : <Chip tone="ok" icon="check">{`${sn} is paired. Setup carries on here.`}</Chip>}
        <View className="items-center gap-s3"><Avatar of={spaceRef(sn)} size={56} /></View>
        <Segmented label="Look" value={look} onChange={setLook} options={DATA.looks.map((l) => [l.id, l.label] as [string, string])} />
        <Button kind="primary" label="Continue" onPress={() => advance("look")} />
      </Page>
    );
  } else if (step === "members") {
    body = (
      <Page title="Invite your team" sub="Add people now, or later from Members. You are the owner.">
        <Row lead={<Avatar of={{ kind: "person", id: "me", name: name || "You" }} size={40} />} title={name || "You"} sub="Owner, this device" />
        {MOCK ? <Field label="Invite someone" value={inviteLine} onChangeText={setInviteLine} placeholder="Their email" /> : <RealInvite />}
        <View className="flex-row gap-s2">
          {MOCK ? <>
            <Button kind="primary" label={inviteLine.trim() ? "Send the invite and continue" : "Continue"} onPress={() => { if (inviteLine.trim()) showToast(`Invite sent to ${inviteLine.trim()}.`); setInviteLine(""); advance("members"); }} />
            <Button kind="ghost" label="Later" onPress={() => advance("members")} />
          </> : <Button kind="ghost" label="Skip for now" onPress={() => advance("members")} />}
        </View>
      </Page>
    );
  } else if (step === "ai") {
    body = (
      <Page title="Connect your AI accounts" sub="Your assistant works on your own AI account. Connect Claude now, or later from Settings.">
        {MOCK ? <Card><Row dense title="Claude" sub="Connected with your Claude subscription" /></Card> : <ConnectClaude />}
        <View className="flex-row gap-s2">
          <Button kind="primary" label="Continue" onPress={() => advance("ai")} />
          <Button kind="ghost" label="Later" onPress={() => advance("ai")} />
        </View>
      </Page>
    );
  } else if (step === "connectors") {
    const on = (id: string) => pickConnectors.includes(id);
    body = (
      <Page title="Connect your tools" sub={MOCK ? "Each one asks for its own sign-in, and only what you pick is connected." : "Pick the ones you will use. Nothing connects yet: each asks for its own sign-in when you set it up."}>
        <Card flush>
          {DATA.connectors.map((c, i) => (
            <View key={c.id}>{i ? <Divider /> : null}<Row dense title={c.label} sub={c.sub} end={<Chip tone={on(c.id) ? "ok" : "plain"} icon={on(c.id) ? "check" : undefined}>{on(c.id) ? "Chosen" : "Choose"}</Chip>} onPress={() => setPickConnectors((l) => (on(c.id) ? l.filter((x) => x !== c.id) : [...l, c.id]))} /></View>
          ))}
        </Card>
        <View className="flex-row gap-s2">
          <Button kind="primary" label="Continue" onPress={() => advance("connectors")} />
          <Button kind="ghost" label="Later" onPress={() => { setPickConnectors([]); advance("connectors"); }} />
        </View>
      </Page>
    );
  } else if (step === "kit") {
    body = (
      <Page title="Start with a Kit" sub="A Kit adds record types, Flows and views in one step. Pick one, or start empty.">
        <Card flush>
          {(MOCK ? DATA.kits : kitList ?? []).map((k) => (
            <Row key={k.id} dense lead={<IconTile name="box" />} title={k.label} sub={k.sub} end={<Chip tone={pickKit === k.id ? "ok" : "plain"} icon={pickKit === k.id ? "check" : undefined}>{pickKit === k.id ? "Chosen" : "Choose"}</Chip>} onPress={() => setPickKit(pickKit === k.id ? null : k.id)} />
          ))}
          {!MOCK && kitList === undefined ? <Row dense title="Looking for Kits" /> : null}
          {!MOCK && kitList !== undefined && !(kitList ?? []).length ? <Row dense title="No Kits to pick here yet" sub="You can add one later from Kits." /> : null}
        </Card>
        <View className="flex-row gap-s2">
          <Button kind="primary" label={busy ? "Asking" : "Finish setup"} onPress={busy ? () => {} : () => advance("kit")} />
          <Button kind="ghost" label="Start empty" onPress={() => { setPickKit(null); advance("kit"); }} />
        </View>
      </Page>
    );
  } else if (step === "done") {
    body = (
      <View className="items-center gap-s3">
        <Avatar of={spaceRef(last?.name ?? sn)} size={56} />
        <Text size="page" strong className="text-center">{`${last?.name ?? sn} is ready`}</Text>
        <Text tone="muted" className="text-center">{last?.line}</Text>
        <Text mono size="caption" tone="label">{last?.addr}</Text>
        {MOCK ? null : pendingLines({ kit: pickKit ? { id: pickKit, label: kitList?.find((k) => k.id === pickKit)?.label ?? pickKit } : null, kitResult, connectors: pickConnectors.map((id) => DATA.connectors.find((c) => c.id === id)?.label ?? id) }).map((l) => <Text key={l} tone="muted" className="text-center">{l}</Text>)}
        {MOCK || start !== "server" ? null : <MyCloudCard />}
        <Button kind="primary" label="Continue" onPress={() => setStep("spaces")} />
      </View>
    );
  } else if (step === "join") {
    body = (
      <Page title="Join a team" sub="Paste the invite link you were sent.">
        <View className="w-ring self-center"><Ring seed={6} /></View>
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <Field label="Invite link" value={link} onChangeText={setLink} placeholder="Paste it here" />
        {MOCK ? null : <TypeCode redeem={redeemInvite} onDone={(t) => { if (!t.invite) { setWrong("The code worked but gave no invitation."); return; } const l = t.invite.link; setLink(l); setBusy(true); setWrong(""); previewInvite(l).then((p) => { setInvite(inviteFrom(p, l)); setStep("invite"); }).catch((e) => setWrong(inviteRefusal((e as { code?: string }).code, said(e)))).finally(() => setBusy(false)); }} />}
        <View className="flex-row gap-s2">
          <Button kind="primary" label="Continue" disabled={!MOCK && (busy || !link.trim())} onPress={() => {
            if (MOCK) return setStep("invite");
            setBusy(true); setWrong("");
            previewInvite(link.trim()).then((p) => { setInvite(inviteFrom(p, link.trim())); setStep("invite"); }).catch((e) => setWrong(inviteRefusal((e as { code?: string }).code, said(e)))).finally(() => setBusy(false));
          }} />
          {MOCK ? <Button label="Simulate the scan" onPress={() => setStep("invite")} /> : null}
        </View>
      </Page>
    );
  } else if (step === "invite") {
    body = (
      <Card className="gap-s3">
        {wrong ? <Banner tone="warn">{wrong}</Banner> : null}
        <Row lead={<Avatar of={spaceRef(inv.space)} size={56} />} title={inv.space} sub={inv.address} />
        {inv.from ? <Text tone="muted">{`${inv.from} invited you.`}</Text> : null}
        {external ? <Banner tone="warn">This invitation came from a link outside Vyre. Check that the space name is the one you expect before you join.</Banner> : null}
        <Text mono size="caption" tone="label">{inv.link.replace(/\/join\/.*$/, "/join/…")}</Text>
        {"words" in inv && inv.words ? <View className="gap-s1"><Text size="caption" strong tone="label">Read these four words to the person who invited you. They should see the same ones.</Text><Text mono strong>{inv.words}</Text></View> : null}
        <View className="gap-s1"><Text size="caption" strong tone="label">You join as</Text><View className="flex-row"><Chip tone="accent">{inv.role}</Chip></View><Text size="caption" tone="muted">{inv.roleLine}</Text></View>
        <View className="gap-s1"><Text size="caption" strong tone="label">What you can see</Text><Text size="caption" tone="muted">{inv.sees}</Text></View>
        <Button kind="primary" icon="faceid" label={`Join ${inv.space}`}
          onPress={() => setFace({ title: `Join ${inv.space}`, body: `Face ID adds this device to ${inv.space}.`, label: "Join with Face ID", onApprove: () => {
            const joined = () => { setMade((m) => [...m, { name: inv.space, look: "amber", addr: inv.address, line: `Joined as ${inv.role}` }]); setStep("joined"); };
            if (MOCK) return joined();
            void acceptInvite(link.trim()).then((r) => (r?.joined === false && !r?.pending ? setWrong("This device could not join yet.") : joined())).catch((e) => setWrong(said(e)));
          } })} />
      </Card>
    );
  } else if (step === "joined") {
    body = (
      <View className="items-center gap-s3">
        <Chip tone="ok" icon="check">Joined</Chip>
        <Text size="page" strong className="text-center">{`You joined ${inv.space}.`}</Text>
        <Text tone="muted" className="text-center">{`This computer is now part of ${inv.space}.`}</Text>
        <Button kind="primary" label="Continue" onPress={() => setStep("spaces")} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-bg">
      <View className="flex-row items-center gap-s2 px-s4 py-s3">
        {back ? <Button kind="ghost" size="sm" icon="chevron-left" label="Back" onPress={() => { setWrong(""); setSession(null); setStep(back); }} /> : null}
        <View className="flex-1" />
        {canClose ? <Button kind="ghost" size="sm" label="Close" onPress={finish} /> : null}
      </View>
      <ScrollView contentContainerClassName="p-s4 w-full max-w-read self-center grow justify-center">{body}</ScrollView>
      <FaceIdSheet ask={face} onClose={() => setFace(null)} />
    </View>
  );
}
