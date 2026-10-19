// @ts-check
// The owner's walk on a FRESH real box, in a real browser (the release gate for 0.6.2, scripts/proof-first-run.mjs --owner-walk). Everything here runs after the first run has made the box and the
// app has reached Ready: a real installer's server (no sample world), a brand-new owner, and the app's own screens driven the way a person drives them. Each walk does a real thing and checks the
// SERVER's state afterwards (the box's own tools through srv.operator, the names directory, the page text), never only that a screen drew.
//
// A walk whose screen is not on this build yet is PENDING, not passed: it is reported as SKIP with the reason, and with OWNER_WALK_STRICT=1 (the gate on the final candidate) any pending walk fails
// the run. So the lane is honest about what it has proved, and nothing ships until all ten walks pass with nothing pending.
import fs from "node:fs";
import path from "node:path";

/** @typedef {{ run: any, drv: any, srv: any, ins: any, S: (n: string) => string, READY: string[], USERNAME: string, PASSWORD: string, until: (f: () => any, ms: number, what: string) => Promise<any>, wait: (ms: number) => Promise<void>, out: string, spaceName: () => string, cleanups: (() => any)[] }} Ctx */

/** Names of an object's keys (never values), for logs. */
const keysOf = (/** @type {any} */ o) => (o && typeof o === "object" ? Object.keys(o).join(",") || "(none)" : typeof o);
const errOf = (/** @type {any} */ e) => String(e?.code ?? e?.message ?? e).slice(0, 120);
const rowsOf = (/** @type {any} */ o) => (Array.isArray(o) ? o : ["spaces", "items", "rows", "devices", "keys"].map((k) => o?.[k]).find(Array.isArray) ?? []);
/** What the box says about presence keys and devices, as counts and kinds only (ids cut to 6 characters). */
async function boxFacts(/** @type {(t: string, i?: any) => Promise<any>} */ op) {
  /** @type {string[]} */ const out = [];
  try { const k = rowsOf(await op("presence.keys", {})); out.push(`presence.keys: ${k.length} (${k.map((x) => String(x?.kind ?? x?.type ?? "?")).join(",")})`); } catch (e) { out.push(`presence.keys: ${errOf(e)}`); }
  try { const d = rowsOf(await op("spaces.devices.list", {})); out.push(`devices: ${d.map((x) => `${String(x?.id ?? "").slice(0, 6)}/${x?.kind ?? "?"}/removed=${!!x?.removed}/owner=${!!(x?.owner ?? x?.is_owner)}`).join(" ")}`); } catch (e) { out.push(`spaces.devices.list: ${errOf(e)}`); }
  try { out.push(`network.wink.status keys: ${keysOf(await op("network.wink.status", {}))}`); } catch (e) { out.push(`network.wink.status: ${errOf(e)}`); }
  try { out.push(`presence.person.status keys: ${keysOf(await op("presence.person.status", {}))}`); } catch (e) { out.push(`presence.person.status: ${errOf(e)}`); }
  out.push("caller label: the browser's label is not exposed by a box tool I tried");
  return out;
}
/** @param {Ctx} c */
export async function ownerWalkReal(c) {
  const { run, drv, srv, ins, READY, USERNAME, until, wait } = c;
  const W = (/** @type {number} */ n, /** @type {string} */ t) => `owner walk ${n}: ${t}`;
  /** A walk that cannot run on this build says so; it is a SKIP, and a failure under OWNER_WALK_STRICT. @param {string} why */
  const pending = (why) => { throw Object.assign(new Error(`PENDING: ${why}`), { skip: true }); };
  const shot = (/** @type {string} */ n) => drv.shot(`ow-${n}`).catch(() => {});
  const text = async () => String(await drv.text()).replace(/\s+/g, " ");
  const show = async (/** @type {number} */ n = 400) => (await text()).slice(0, n);
  /** A phone-approval sheet stays over every later screen for five minutes (the walk has no phone): close it. */
  const stopWaiting = async () => { if (/Approve on your phone/.test(await text())) { try { await drv.click("Stop waiting"); await wait(500); } catch { /* it ended */ } } };
  /** Open a route and wait for words that only that screen says. */
  const screen = async (/** @type {string} */ route, /** @type {RegExp} */ re, /** @type {string} */ what, ms = 60_000) => {
    await drv.go(route);
    await stopWaiting();
    try { await until(async () => re.test(await text()), ms, what); } catch (e) { await shot(`failed-${route.replace(/\W+/g, "-")}`); throw new Error(`${/** @type {Error} */ (e).message}. The screen says: ${await show(500)}`); }
  };
  /** Press the first of these that is on the screen. @param {string[]} names */
  const press = async (names) => {
    for (const n of names) { try { await drv.click(n); return n; } catch { /* the next */ } }
    throw new Error(`none of ${names.map((n) => `"${n}"`).join(", ")} is on the screen: ${await show(400)}`);
  };
  /** The box's own answer, as the operator. */
  const op = (/** @type {string} */ tool, /** @type {any} */ input = {}) => srv.operator(tool, input);
  const has = async (/** @type {RegExp} */ re) => re.test(await text());
  /** What the SERVER holds, read the way the person reads it: leave the screen and open it again, so it is fetched from the box, not drawn from what the page already had. The box's operator tools cannot stand in for the owner here (they answer "not from a signed-in person"). @param {string} route @param {RegExp} re @param {string} what */
  const fresh = async (route, re, what) => { await drv.go("/u/now"); await wait(1500); await screen(route, re, `${what} after a fresh read`); };
  /** Fill the first field of these labels that exists. @param {string[]} labels @param {string} v */
  const fillAny = async (labels, v) => {
    for (const l of labels) { if (await drv.fieldReady(l)) { await drv.fill(l, v); return l; } }
    throw new Error(`none of the fields ${labels.map((l) => `"${l}"`).join(", ")} is on the screen: ${await show(400)}`);
  };

  const JOINED = W(4, "People: a second browser joins with the link and shows in the list with its role");
  const ROLE_MADE = W(5, "Roles: New role with the defaults makes the role and it is listed");
  // ---- 1. a fresh first run: identity, then name; the device entry has `agree`; Account shows the name and the device
  await run.step(W(1, "the identity chain's device entry carries the key-agreement point (agree)"), async () => {
    const r = await fetch(`${ins.names}/v1/ids/resolve?name=${USERNAME}`);
    const j = /** @type {any} */ (await r.json());
    /** @type {any[]} */ const devices = [];
    (function scan(/** @type {any} */ v) { if (Array.isArray(v)) v.forEach(scan); else if (v && typeof v === "object") { if (v.kind === "device") devices.push(v); Object.values(v).forEach(scan); } })(j);
    if (!devices.length) throw new Error(`the chain has no device entry: ${JSON.stringify(j).slice(0, 300)}`);
    const withAgree = devices.filter((d) => typeof d.agree === "string" && d.agree.length > 40);
    if (!withAgree.length) throw new Error(`no device entry has agree (${devices.length} device entries, keys ${[...new Set(devices.flatMap((d) => Object.keys(d)))].join(", ")})`);
    return `${withAgree.length} of ${devices.length} device entries carry agree`;
  }, { needs: READY });
  await run.step(W(1, "Account shows the name and the device"), async () => {
    await screen("/u/settings/account", /Proof Walker/, "Account showing the name");
    const t = await text();
    if (!new RegExp(USERNAME, "i").test(t)) throw new Error(`Account does not show the username ${USERNAME}: ${t.slice(0, 300)}`);
    if (!/This (phone|device|computer|browser)/i.test(t)) throw new Error(`Account shows no device marked as this one: ${t.slice(0, 400)}`);
    await shot("01-account");
  }, { needs: READY });

  // ---- 2. chats: a new thread; a message gets a real Assistant reply
  let threadsBefore = 0;
  /** The thread's own address, read from the URL after Start chat. /u/chats redirects to the new-thread page on a phone-wide window. */
  let threadPath = "";
  await run.step(W(2, "Chats opens a new thread with the Assistant, and the server has the thread"), async () => {
    await screen("/u/chats/new", /Start chat|Search people and agents/i, "the new chat screen");
    await press(["Juno", "juno"]);
    await fillAny(["First message (optional)", "First message"], "Say hello in five words.");
    await shot("02-new-chat");
    await press(["Start chat"]);
    let t = "";
    try { await until(async () => { t = await text(); return /\/u\/chats\/(?!new)[^/]+/.test(String(drv.url?.() || "")) || !/Starting/.test(t); }, 90_000, "the thread opening (the button leaving Starting)"); }
    catch (e) { await shot("failed-02-starting"); throw new Error(`${/** @type {Error} */ (e).message}. url ${drv.url?.()}. The screen says: ${await show(400)}`); }
    await shot("02-thread");
    const id = /\/u\/chats\/([^/?#]+)/.exec(String(drv.url?.() || ""))?.[1];
    if (!id || id === "new") throw new Error(`the app did not open a thread (url ${drv.url?.()})`);
    threadPath = `/u/chats/${id}`;
    return `the app opened ${drv.url?.()}`;
  }, { needs: READY });
  await run.step(W(2, "the first message typed in New chat is in the thread, and the server holds it"), async () => {
    if (!threadPath) pending("no thread was opened");
    await fresh("/u/chats?list=1", /Juno/, "the thread list");
    await fresh(threadPath, /Say hello|Message|Juno|Assistant/, "the thread");
    try { await until(async () => (await has(/Say hello in five words/)), 30_000, "the first message in the thread"); }
    catch (e) { await shot("failed-02-first-message"); throw new Error(`${/** @type {Error} */ (e).message}: the thread with Juno shows only "${await show(300)}"`); }
    await shot("02-first-message");
    // Log what the Assistant says back to this first message (never fails the step: the reply step below asserts a reply to a typed message).
    const base = await text(); const mark = base.indexOf("Say hello in five words");
    const tail = (/** @type {string} */ x) => x.slice(mark + "Say hello in five words.".length).replace(/\b\d{1,2}:\d{2}\s?(am|pm)\b/gi, "").trim();
    try {
      const after = await until(async () => { const x = await text(); const t = tail(x); return t.length > tail(base).length + 4 && !/Thinking|Working on it|Sending/.test(x) ? t : ""; }, 120_000, "a new assistant bubble");
      console.log(`owner walk 2 first reply: ${after.slice(0, 200)}`);
    } catch { console.log(`owner walk 2 first reply: none in 120 s; the thread says: ${tail(await text()).slice(0, 200)}`); }
    await shot("02-first-reply");
  }, { needs: READY });
  await run.step(W(2, "the Assistant sends a real reply to a message typed in the thread"), async () => {
    if (!process.env.OWNER_WALK_OPENROUTER_KEY) pending("no model key in this run (OWNER_WALK_OPENROUTER_KEY is not set), so there is no real reply to check");
    if (!threadPath) pending("no thread was opened");
    await screen(threadPath, /Say hello|Message|Juno|Assistant/, "the thread");
    await fillAny(["Message Juno", "Message"], "Please answer with the single word: ready");
    // While the first answer is still streaming the button is a stop square, so wait for Send to come back (up to 2 minutes).
    await until(async () => { try { await press(["Send"]); return true; } catch { return false; } }, 120_000, "the Send button");
    const before = (await text()).length;
    let t = "";
    try { t = await until(async () => { const x = await text(); return x.includes("single word") && x.length > before + 8 && !/Thinking|Working on it|Sending/.test(x) ? x : ""; }, 240_000, "the Assistant's reply"); }
    catch (e) { await shot("failed-02-reply"); throw new Error(`${/** @type {Error} */ (e).message}. The thread says: ${await show(700)}`); }
    if (/could not|couldn't|sign in again|no AI account|didn't answer|did not answer/i.test(t.replace("single word", ""))) throw new Error(`the thread shows an error instead of a reply: ${t.slice(0, 500)}`);
    await shot("02-reply");
    return `the thread grew by ${t.length - before} characters`;
  }, { needs: READY });

  // ---- 3. files: a new folder, an upload into it, a move into it; project folders show names
  await run.step(W(3, "Files: New folder"), async () => {
    await drv.viewport?.(1280, 900);   // the file manager (760 px and wider); a narrower window draws the older Drive screen
    await screen("/u/files", /Files|Upload|Nothing here/i, "the Files screen");
    await until(async () => (await has(/New folder|Upload/)), 30_000, "the Files toolbar").catch(() => {});
    if (!(await has(/New folder/))) pending("the Files screen has no New folder yet (files-move is not on this build)");
    await press(["New folder"]);
    await fillAny(["Folder name", "Name", "New folder name"], "Walk");
    await press(["Create", "Make the folder", "Make folder"]);
    await until(async () => (await has(/\bWalk\b/)), 30_000, "the folder showing");
    await fresh("/u/files", /\bWalk\b/, "the Files screen listing the folder");
    await shot("03-folder");
  }, { needs: READY });
  await run.step(W(3, "Files: upload a file, and the server holds it"), async () => {
    await drv.viewport?.(1280, 900);   // the web file manager (a phone has no Upload button)
    await screen("/u/files", /Upload|Nothing here|Files/i, "the Files screen");
    await drv.upload?.("Upload", "walk-note.txt", "owner walk upload\n");
    await until(async () => (await has(/walk-note\.txt/)), 45_000, "the file showing");
    await fresh("/u/files", /walk-note\.txt/, "the Files screen listing the upload");
    await shot("03-upload");
  }, { needs: READY });
  await run.step(W(3, "Files: move the file into the folder"), async () => {
    await screen("/u/files", /Files|Upload/i, "the Files screen");
    await until(async () => (await has(/\bWalk\b|walk-note/)), 30_000, "the Files list").catch(() => {});
    if (!(await has(/\bWalk\b/))) pending("there is no folder to move into (New folder is not on this build)");
    await drv.rightClick?.("walk-note.txt");
    await wait(800); await shot("03-menu");
    await press(["Move to…", "Move to...", "Move"]);
    await wait(1500); await shot("03-move-dialog");
    await press(["Walk"]);
    await press(["Move here", "Move"]);
    await wait(1500);
    await fresh("/u/files", /\bWalk\b/, "the Files screen");
    await press(["Walk"]);
    await until(async () => (await has(/walk-note\.txt/)), 30_000, "the file inside the folder");
  }, { needs: READY });
  await run.step(W(3, "Files: a project's folder shows its name"), async () => {
    await screen("/u/files", /Files/i, "the Files screen");
    const t = await text();
    if (/\b(prj|per|spc)_[a-z2-7]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(t)) throw new Error(`Files shows a raw id: ${t.slice(0, 300)}`);
    if (!/Personal/.test(t)) pending("Files does not list the project folders yet");
  }, { needs: READY });

  await drv.viewport?.(520, 1000);

  // ---- 4. people: invite (a link), a second browser joins with it and shows in the list with its role
  /** @type {string} */ let inviteLink = "";
  await run.step(W(4, "People: Invite someone makes a link"), async () => {
    await screen("/u/wink/invite", /Invite someone|Make the invitation/i, "the invite screen");
    await fillAny(["Their name or email, for your own list", "Their name, for your own list"], "Walker Two");
    await press(["Make invite", "Make the invitation"]);
    let t = "";
    try { t = await until(async () => { const x = await text(); return /(https?:\/\/|vyre:\/\/)\S+|\b[a-z0-9-]+\.vyre\.run\/\S+/i.test(x) && !/Making/.test(x) ? x : ""; }, 60_000, "the invitation link showing"); }
    catch (e) {
      await shot("failed-04-invite");
      const said = `${/** @type {Error} */ (e).message}. The screen says: ${await show(600)}`;
      // The screen refused (a passkey is asked for). Say what the box knows (counts, kinds, short ids: no secrets), then make the link from the box so walks 4b and 5b still run, and fail this step honestly.
      const facts = await boxFacts(op);
      try {
        let id = "";
        for (const tool of ["onboard.space.list", "spaces.list"]) {
          try { const sp = await op(tool, {}); const rows = rowsOf(sp); facts.push(`${tool}: keys ${keysOf(sp)}, ${rows.length} rows, row keys ${keysOf(rows[0])}`); id = id || String(rows[0]?.id ?? rows[0]?.space ?? ""); } catch (e3) { facts.push(`${tool}: ${errOf(e3)}`); }
        }
        const r = await op("onboard.member.link", { space: id, role: "member", ttlDays: 7 });
        facts.push(`onboard.member.link: keys ${keysOf(r)}`);
        inviteLink = String([r?.link, r?.url, r?.invite?.link, r?.data?.link, ...Object.values(r ?? {})].find((v) => typeof v === "string" && /^(https?|vyre):\/\//.test(v)) ?? "");
      } catch (e2) { facts.push(`onboard.member.link: ${errOf(e2)}`); }
      console.log(`owner walk 4 box facts: ${facts.join(" | ")}`);
      console.log(`owner walk 4 refused calls: ${(drv.refused?.() || []).join(" || ") || "none seen"}`);
      throw new Error(`${said} (link made from the box instead: ${inviteLink ? "yes" : "no"}; box facts: ${facts.join(" | ").slice(0, 900)})`);
    }
    inviteLink = String(/(https?:\/\/|vyre:\/\/)\S+|\b[a-z0-9-]+\.vyre\.run\/\S+/i.exec(t)?.[0] || "").replace(/[.,;)]+$/, "");
    await shot("04-invite-made");
    if (!inviteLink) throw new Error(`no link on the screen: ${await show(300)}`);
    return inviteLink;
  }, { needs: READY });
  await run.step(JOINED, async () => {
    if (!inviteLink) pending("no invitation link");
    const two = await drv.second?.();
    if (!two) pending("this client cannot open a second person");
    c.cleanups.push(() => two.stop());
    await two.open();
    await two.waitFor("Get started", 60_000);
    await two.click("New here? Get started");
    await two.waitFor("What should we call you?");
    await two.fill("First name", "Walker"); await two.fill("Last name", "Two");
    await two.click("Continue");
    await two.waitFor("Pick a username.");
    await two.fill("Username", `${USERNAME}c`);
    await two.click("Continue");
    await two.waitFor("Make your password.");
    await two.fill("Password", c.PASSWORD); await two.fill("Confirm password", c.PASSWORD);
    await two.click("Create");
    await two.waitFor("Save your recovery key", 400_000);
    await two.turnOn("I saved it");
    await two.click("Continue");
    await two.waitFor("Your space", 60_000);
    await two.click("Join a space");
    await two.waitFor("Join a space");
    await two.fill("Invite link", inviteLink);
    await two.click("Continue");
    await two.waitFor("You are invited", 120_000).catch(async (e) => { await two.shot("ow-fail-04-invitee"); throw new Error(`${e.message} | the invitee's screen: ${(await two.text()).replace(/\s+/g, " ").slice(0, 300)}`); });
    await two.click("Join");
    await two.waitFor("Connect your AI", 120_000);
    await two.click("Skip for now");
    await two.waitFor("You're all set", 120_000);
    // the owner's list shows the new person with a role
    await screen("/u/settings/roles", /roles/i, "the roles screen");
    const l = await op("spaces.members", {}).catch(() => null);
    const seen = JSON.stringify(l);
    if (!new RegExp(`${USERNAME}c|Walker Two|Walker`, "i").test(seen) && !(await has(new RegExp(`${USERNAME}c|Walker`, "i")))) throw new Error(`the new person is not listed: ${seen.slice(0, 300)} ${await show(300)}`);
    await shot("04-people");
  }, { needs: READY });

  // ---- 5. roles: New role with the defaults succeeds, and the role appears
  await run.step(ROLE_MADE, async () => {
    await screen("/u/settings/roles", /roles/i, "the roles screen");
    await press(["New role"]);
    await fillAny(["Role name", "Name"], "TestRole");
    await shot("05-new-role");
    await press(["Make the role"]);
    try { await until(async () => !(await has(/Make the role/)) || (await has(/Take it out|is wider/)), 30_000, "the dialog closing"); }
    catch (e) { await shot("failed-05-after-make"); throw new Error(`${/** @type {Error} */ (e).message}. The screen says: ${await show(600)}`); }
    if (await has(/is wider than a role that starts from Member|Take it out/)) throw new Error(`the box refused the default role: ${await show(500)}`);
    await until(async () => (await has(/TestRole/)), 30_000, "the role listed");
    await fresh("/u/settings/roles", /TestRole/, "the Roles screen listing the role");
    await shot("05-role-listed");
  }, { needs: READY });

  await run.step(W(5, "People and roles: the joined person is given the custom role, and the list shows it"), async () => {
    await screen("/u/settings/roles", /People/, "the People list on the roles screen");
    await press(["Walker Two"]);
    await until(async () => (await has(/A role of your own|TestRole/)), 20_000, "the role sheet");
    await press(["TestRole"]);
    await press(["Save"]);
    await wait(2000);
    await fresh("/u/settings/roles", /Walker Two[^]*TestRole|TestRole[^]*Walker Two/, "the People list showing the person with TestRole");
    await shot("05-person-has-role");
  }, { needs: [JOINED, ROLE_MADE] });

  // ---- 6. apps: install Documents with no phone
  await run.step(W(6, "Apps: Documents installs with no phone, and is installed and listed"), async () => {
    // the owner's own path: Build, Documents, Setup, "Install the Documents app" (no phone is paired on this box)
    await screen("/u/documents", /Documents/i, "the Documents screen");
    try { await press(["Setup"]); } catch { /* the tab is already open or named otherwise */ }
    await until(async () => (await has(/Install the Documents app|Running|Stopped|Start it/)), 60_000, "the Documents setup card");
    if (await has(/Install the Documents app/)) {
      await press(["Install the Documents app"]);
      // the app does not redraw this card by itself: read it again every minute, the way a person reopens the screen
      let ok = false;
      for (let i = 0; i < 6 && !ok; i++) {
        if (await has(/Approve on your phone|no way to approve/i)) { await shot("failed-06-phone"); throw new Error(`installing Documents asks for a phone: ${await show(500)}`); }
        await wait(60_000);
        await drv.go("/u/apps"); await wait(2000); await screen("/u/documents", /Documents/i, "the Documents screen");
        try { await press(["Setup"]); } catch { /* open */ }
        ok = await has(/Running/);
      }
      if (!ok) { await shot("failed-06-install"); throw new Error(`Documents is not shown running after six minutes and six fresh reads: ${await show(600)}`); }
    }
    await shot("06-documents-running");
    // what the box holds, read fresh: the Documents setup and the Apps screen both show it running
    await fresh("/u/apps", /Documents[^]*Running/i, "the Apps screen listing Documents as running");
    await shot("06-apps-listed");
  }, { needs: READY });

  // ---- 7. watchers: a Feed watcher on a real public RSS URL
  await run.step(W(7, "Watchers: a Feed watcher on a public RSS feed tests, turns on and Run now files items"), async () => {
    await screen("/u/flows", /Flows|Watchers/i, "the Flows screen");
    try { await press(["Watchers"]); } catch { pending(`the Flows screen has no Watchers tab on this build: ${await show(160)}`); }
    await until(async () => (await has(/New watcher/)), 30_000, "the Watchers tab");
    await press(["New watcher"]);
    try { await drv.choose?.("Where should it look?", "Feed"); } catch (e) { await shot("failed-07-new-watcher"); throw new Error(`${/** @type {Error} */ (e).message.split("\n")[0]}. The screen says: ${await show(500)}`); }
    await fillAny(["Feed address"], "https://github.com/vyre-ai/vyre/releases.atom");
    await shot("07-new-watcher");
    await press(["Write it and test it"]);
    let t = "";
    try { t = await until(async () => { const x = await text(); return /Turn on/.test(x) && !/Writing and testing/.test(x) ? x : ""; }, 120_000, "the test result"); }
    catch (e) { await shot("failed-07-test"); throw new Error(`${/** @type {Error} */ (e).message}. The screen says: ${await show(700)}`); }
    await shot("07-tested");
    if (/did not|could not|failed|no items/i.test(t) && !/item|found|new/i.test(t)) throw new Error(`the test shows no items: ${t.slice(0, 500)}`);
    await press(["Turn on"]);
    await until(async () => (await has(/Run now/)), 60_000, "the watcher listed with Run now");
    await press(["Run now"]);
    let after = "";
    for (let i = 0; i < 6; i++) {
      await wait(20_000);
      await screen("/u/flows", /Watchers|Flows/i, "the Flows screen"); try { await press(["Watchers"]); } catch { /* open */ }
      await until(async () => (await has(/Run now|Pause/)), 30_000, "the watcher row").catch(() => {});
      after = await text();
      if (/\b[1-9]\d* filed/.test(after)) break;
    }
    await shot("07-ran");
    const filed = /\b([1-9]\d*) filed/.exec(after);
    if (!filed) throw new Error(`Run now filed nothing: the watcher row says "${after.slice(0, 500)}"`);
    return `${filed[1]} items filed`;
  }, { needs: READY });

  // ---- 8. a webhook Flow
  let hookSecret = "";
  const ROUTE = "walk-orders";
  await run.step(W(8, "Webhook: open a route, turn the listener on and read the signing secret in the Vault"), async () => {
    await screen("/u/flows/new", /Name|When|What starts/i, "the new Flow screen");
    await press(["Choose what starts it", "When"]);
    await drv.choose?.("What starts the Flow", "A webhook is called");
    await until(async () => (await has(/Which route/)), 20_000, "the webhook fields");
    await drv.choose?.("Which route", "Open a new route");
    await drv.fillPlaceholder?.("northwind-orders", ROUTE);
    try { await drv.fillPlaceholder?.("x-signature", "x-signature"); } catch { /* the scheme asks for no header */ }
    await shot("08-open-route");
    await press(["Open the route"]);
    try { await until(async () => (await has(/listener is off|Turn the listener on|Signing secret/i)), 60_000, "the route opening"); }
    catch (e) {
      await shot("failed-08-open");
      console.log(`owner walk 8 refused calls: ${(drv.refused?.() || []).join(" || ") || "none seen"}`);
      const said = `${/** @type {Error} */ (e).message}. The screen says: ${await show(900)}`;
      // A phone approval sheet stays over every later screen for five minutes: close it so walks 9 and 10 are not blocked by it.
      const phone = /Approve on your phone/.test(await text());
      await stopWaiting();
      throw new Error(phone ? `the route asks for a PHONE approval ("Approve on your phone") and the walk has none; ${said}` : said);
    }
    if (await has(/Turn the listener on/)) { await press(["Turn the listener on"]); await until(async () => !(await has(/listener is off/)), 60_000, "the listener turning on"); }
    await shot("08-route-open");
    await press(["Reveal the secret"]);
    await until(async () => (await has(/Reveal/)), 30_000, "the Vault item");
    await press(["Reveal"]);
    const found = await until(async () => { const m = (await drv.monospaces?.()) || []; const c = m.filter((x) => x.length >= 24 && !/\s/.test(x)).sort((a, b) => b.length - a.length)[0]; return c || ""; }, 30_000, "the revealed secret").catch(async (e) => { await shot("failed-08-secret"); throw new Error(`${e.message}. The screen says: ${await show(500)}`); });
    hookSecret = found;
    await shot("08-secret-revealed");
    return `route ${ROUTE}, a ${hookSecret.length}-character secret read back`;
  }, { needs: READY });
  const FLOW_MADE = W(8, "Webhook Flow: 'A webhook is called' with an If on trigger.amount and one record step, approved");
  await run.step(FLOW_MADE, async () => {
    await screen("/u/flows/new", /Name|When|What starts/i, "the new Flow screen");
    await fillAny(["Name"], "Walk webhook");
    await press(["Choose what starts it", "When"]);
    await drv.choose?.("What starts the Flow", "A webhook is called");
    await until(async () => (await has(/Which route/)), 20_000, "the webhook fields");
    await drv.choose?.("Which route", `/hooks/${ROUTE}`);
    await press(["Add the first step"]);
    await press(["If / else"]);
    await drv.choose?.("Field", "amount").catch(async () => { await fillAny(["Field"], "amount"); });
    await drv.choose?.("Is", ">").catch(() => {});
    await fillAny(["Value"], "50");
    await press(["Add a step here"]);
    await press(["Create a record"]);
    await shot("08-flow-built");
    pending(`the Create step's object and fields are not driven yet; the screen says: ${await show(500)}`);
  }, { needs: [W(8, "Webhook: open a route, turn the listener on and read the signing secret in the Vault")] });
  await run.step(W(8, "Webhook: a delivery signed with the revealed secret is taken, a bad signature is refused (401) and starts nothing"), async () => {
    if (!hookSecret) pending("no signing secret was read");
    /** One delivery to the loopback listener inside the box, signed (or not) as the sender would. */
    const post = async (/** @type {number} */ amount, /** @type {boolean} */ good) => {
      const code = `const c=require("crypto"),h=require("http");const b=process.argv[1],good=process.argv[2]==="1",k=process.argv[3];const mac=good?c.createHmac("sha256",k).update(b).digest("hex"):"00".repeat(32);const r=h.request({host:"127.0.0.1",port:7310,path:"/hooks/${ROUTE}",method:"POST",headers:{"content-type":"application/json","x-signature":mac}},x=>{let d="";x.on("data",c=>d+=c);x.on("end",()=>console.log(x.statusCode));});r.on("error",e=>console.log("error "+e.message));r.end(b);`;
      const r = await srv.shell(["node", "-e", code, JSON.stringify({ amount, email: `a${amount}-${Date.now()}@b.test` }), good ? "1" : "0", hookSecret]);
      return r.stdout.split("\n").pop() || r.stderr.slice(0, 200);
    };
    const bad = await post(80, false);
    if (bad !== "401") throw new Error(`a delivery with a bad signature answered ${bad}, not 401`);
    const ok = await post(80, true);
    if (ok !== "200") throw new Error(`a delivery signed with the revealed secret answered ${ok}, not 200`);
    return "bad signature 401, signed delivery 200";
  }, { needs: [W(8, "Webhook: open a route, turn the listener on and read the signing secret in the Vault")] });
  await run.step(W(8, "Webhook Flow: amount 80 starts a run and makes one record, amount 20 makes none"), async () => {
    pending("the Flow's Create step (its object and fields) is not driven yet");
  }, { needs: [FLOW_MADE] });

  // ---- 9. playbooks
  await run.step(W(9, "Playbooks: create, add a stage and a to-do, rename, Go live, start a project"), async () => {
    await screen("/u/playbooks", /Playbooks|Start blank/i, "the Playbooks screen");
    if (!(await has(/Start blank/))) pending(`the Playbooks screen has no Start blank on this build: ${await show(160)}`);
    await press(["Start blank"]);
    await until(async () => (await has(/Untitled|Add stage|Add to-do/i)), 45_000, "the new playbook opening");
    await shot("09-new-playbook");
    // rename: the name is an inline edit
    await press(["Untitled playbook", "the playbook"]);
    await fillAny(["the playbook", "Name"], "Walk playbook");
    await press(["Save"]);
    await until(async () => (await has(/Walk playbook/)), 30_000, "the rename showing");
    await fillAny(["Add stage"], "Review");
    await press(["Add stage"]);
    await until(async () => (await has(/Review/)), 30_000, "the stage listed");
    await fillAny(["Add to-do"], "Send the welcome email");
    await press(["Add to-do"]);
    await until(async () => (await has(/Send the welcome email/)), 30_000, "the to-do listed");
    await shot("09-edited");
    await press(["Go live"]);
    await until(async () => !(await has(/Go live/)) || (await has(/Live/)), 45_000, "the playbook going live");
    await shot("09-live");
    // start a project from it: the playbook page's own button
    await press(["Start a project"]);
    await until(async () => (await has(/Start project/)), 30_000, "the new project sheet");
    await fillAny(["Name", "Project name"], "Walk project");
    await press(["Start project"]);
    await until(async () => !(await has(/Start project/)) || (await has(/Walk project/)), 60_000, "the project starting");
    await fresh("/u/projects", /Walk project/, "the Projects list showing the project");
    await shot("09-project");
  }, { needs: READY });

  // ---- 10. settings
  await run.step(W(10, "Settings: no raw ids, prompts or lowercase names, and every external link opens"), async () => {
    const bad = /\b(per|spc|prj|thr|tsk)_[a-z2-7]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}|You are an? [A-Za-z ]+ assistant/i;
    /** @type {string[]} */ const links = [];
    for (const r of ["/u/settings", "/u/settings/assistants", "/u/settings/account", "/u/settings/ai", "/u/settings/roles", "/u/settings/devices", "/u/settings/privacy", "/u/settings/system"]) {
      await drv.go(r); await wait(2500);
      const t = await text();
      const m = bad.exec(t);
      if (m) { await shot(`failed-10-${r.replace(/\W+/g, "-")}`); throw new Error(`${r} shows "${m[0]}": ${t.slice(0, 300)}`); }
      for (const h of (await drv.links?.()) || []) if (/^https?:\/\//.test(h) && !/127\.0\.0\.1|localhost/.test(h)) links.push(h);
    }
    const uniq = [...new Set(links)];
    const dead = [];
    for (const h of uniq) { try { const x = await fetch(h, { redirect: "follow", signal: AbortSignal.timeout(15_000) }); if (x.status >= 400 && x.status !== 403 && x.status !== 429) dead.push(`${h} ${x.status}`); } catch (e) { dead.push(`${h} ${/** @type {Error} */ (e).message}`); } }
    if (dead.length) throw new Error(`external links that do not open: ${dead.join(", ")}`);
    return `${uniq.length} external links open`;
  }, { needs: READY });
  await run.step(W(10, "Settings: the agent rows open real pages"), async () => {
    await screen("/u/settings/assistants", /Assistants|Juno|Engineer/i, "the assistants screen");
    const t = await text();
    for (const name of ["Juno", "Engineer"]) {
      if (!new RegExp(name, "i").test(t)) continue;
      await drv.click(name);
      await wait(2000);
      const page = await text();
      if (/not found|something went wrong|did not load/i.test(page) || page.length < 80) throw new Error(`the ${name} row opens nothing real: ${page.slice(0, 300)}`);
      await shot(`10-${name}`);
      await screen("/u/settings/assistants", /Assistants|Juno|Engineer/i, "back to the assistants screen");
    }
  }, { needs: READY });

  await run.step(W(10, "Settings: names show as the person gave them (Juno, Engineer), not in lower case"), async () => {
    /** @type {string[]} */ const bad = [];
    for (const r of ["/u/chats/new", "/u/settings/assistants", "/u/agents"]) {
      await drv.go(r); await wait(2500);
      const t = await text();
      for (const [shown, given] of [["juno", "Juno"], ["engineer", "Engineer"]]) if (new RegExp(`(^|[^A-Za-z])${shown}([^A-Za-z]|$)`).test(t) && !new RegExp(`(^|[^A-Za-z])${given}([^A-Za-z]|$)`).test(t)) bad.push(`${r} shows "${shown}", not "${given}"`);
    }
    if (bad.length) { await shot("failed-10-names"); throw new Error(bad.join("; ")); }
  }, { needs: READY });

  // ---- the gate: nothing pending
  await run.step(W(0, "the gate: all ten walks passed with nothing pending"), async () => {
    const pend = run.results.filter((/** @type {any} */ r) => r.ok === null && /^owner walk/.test(r.name));
    if (pend.length && process.env.OWNER_WALK_STRICT === "1") throw new Error(`${pend.length} walks are pending: ${pend.map((/** @type {any} */ r) => `${r.name} (${r.why})`).join("; ")}`);
    return pend.length ? `${pend.length} walks pending (not strict)` : "nothing pending";
  }, { needs: READY });
}
