---
title: Glass and agent computers
summary: Give an agent its own computer on your box, watch its screen live from the Deck, take the keyboard and hand it back, sign in to a site privately, browse its files, and change its limits.
audience: users
owner: polish-surfaces
status: draft
---

# Glass and agent computers

An agent can have its own computer on your box: a desktop with Chrome and a terminal, in its own
container. Glass lets you watch that screen live in the Vyre app, take over the keyboard,
and browse the computer's files. It also browses the box's own folders. Glass works only from your
own tailnet, and only you, the tailnet owner, can open it; a guest from another tailnet cannot.
The design is in [ADR 0005](../adr/0005-glass.md), and
how the screen is streamed in [ADR 0003](../adr/0003-glass-stream.md).

## Before you start

1. Turn agents' computers on. On a Docker box that is the `computers` profile: add
   `COMPOSE_PROFILES=computers` to `/srv/vyre/.env`, then run `vyre up`. See
   [Box care](box-care.md).
2. Nothing else. Taking the keyboard, handing it back and signing in privately ask for no
   passkey: they only pause kit. Agents and tailnet guests can't take the keyboard.

## Give an agent a computer

Open Agents, then the agent (kit). In the Computer panel, press **Give kit a computer**. Or run
`vyre call agents.update '{"name":"kit","computer":true}'`.

The panel then says:

```output
Not made yet. It is made the first time kit or you need it.
```

It also shows Processor 2 cores, Memory 3 GB and Screen 1440 × 900, the box's defaults. Nothing
runs yet. The computer is made the first time kit uses it or you open Glass.

## Watch kit's screen

Press **Open Glass** at the top of the agent page, or the screen picture in the Computer panel.
Other ways to the same page:

- The path `/agents/<name>/glass`, or `/glass/<name>`.
- In the [Lumen](capsule.md), type `glass kit`, or pick Open Glass on one of kit's threads.
- `/glass/box` opens the box itself, which has files and no screen.

The first time, the computer is made and starts, which takes a few seconds. Then the screen
appears with a LIVE badge, and the title reads "kit's computer" and "running". Below the screen:

```output
Watching kit's screen. Nothing you do here reaches it until you take over.
```

Watching keeps the computer awake. About a minute after nobody is watching or using it, the
computer rests: it is frozen and uses no processor time. The next time kit or you need it, it
wakes where it left off.

> [!SNAG] "No box is paired yet" or "kit's computer runs on your box"
> You opened Glass on a Deck that has no box behind it, such as your Mac's own. Agents' computers
> run on the box. Put Vyre on a server with `vyre box add you@your-server`, or open the box's
> Deck instead.

> [!SNAG] "The box is not answering."
> Vyre did not answer. Check the box with `vyre status` on it, or `vyre box` from the Mac.

## Take the keyboard, then hand it back

1. Press **Take over** (or `T`). Taking the keyboard pauses kit.
2. You see a green frame, "You have control", a timer, and **Hand back to kit**. While you drive,
   kit's hands wait. Your clicks and typing reach kit's screen, and other people watching can't
   type.
3. Optionally, leave kit a note (up to 280 characters).
4. Press **Hand back to kit** (or Ctrl+Enter when focus is outside the screen).

```output
You handed the keyboard back to kit. Your note is in its thread.
```

kit carries on from where it stopped and gets a note in its thread: who had the keyboard, for how
long, and your note. It never sees what you typed. The activity list shows "You took the
keyboard." and "You handed back to kit." If you close the tab, or the hold lapses on the box, the
keyboard goes back to kit on its own.

If you stop typing and moving for 5 minutes, the keyboard also goes back to kit. Ten seconds
before, the control bar says "Handing back to kit in 10 s. Type or move to keep control." Any
input keeps it. When the time runs out, kit's thread and the activity list say:

```output
Handed back to kit after 5 min idle.
```

To change the wait, open Settings, Network, **Glass hand-back** and pick Off, 2, 5 or 15 minutes.
The change applies to a take-over already running. From a terminal:
`vyre call computers.handback.set '{"minutes":15}'` (0 turns it off; config
`computers.handbackIdleMin`).

> [!SNAG] "This box still asks for a passkey to take the keyboard."
> The box runs an older Vyre. Update it with `vyre box update` from the Mac (see
> [Box care](box-care.md#upgrade)). Take-over needs no passkey now.

## Sign in to a site in kit's Chrome

Take over leaves kit's link to Chrome open, so it could read the page. For a password, use
**Sign in privately** instead. It also hides the page from kit while you type.

1. Press **Sign in privately**, then **Start**.
2. In kit's Chrome, go to the site's sign-in page (for example `accounts.example.com`) and sign
   in.
3. Hand back. kit sees the page again and can use the signed-in session.

Chrome keeps the sign-in in kit's home folder, so it survives a rest, a restart and changed
limits. Chrome's own password saving is off, because passwords belong in the
[Vault](vault.md).

## Browse and move files

Open the **Files** tab in Glass. It shows "kit's home": its folders and files, with size and
date. On `/glass/box` it shows the box's folders you chose for Glass.

- Choose a file to preview it (text and images), then download, rename or trash it.
- Drop files onto the list to upload them into the folder you are in.
- **New folder** and **Upload** are at the top.

Every change says what happened. Downloads and uploads use a one-time ticket, so a link cannot be
reused. Trash goes to a `.vyre-trash` folder, not away, so you can take a file back out.

Secret places are hidden and refused at any depth, whatever their case. Among them: `.vyre`,
`.claude`, `.ssh`, `.gnupg`, `.aws`, `.docker`, `.kube`, `.netrc`, `.npmrc`, `.env` and `.env.*`,
`*.pem`, `*.key`, `*.kdbx`, `id_*`, `credentials.json`, and browser cookie and login stores. Glass
never opens or moves a file whose first bytes are a private key, whatever its name.

## Change kit's limits, then restart

1. In the Computer panel, press **Change limits**.
2. Set **Cores** (1 to 16) and **Memory GB** (1 to 64), then press **Save limits**.

   ```output
   Saved. Restart kit's computer to apply them.
   ```

3. Press **Restart computer**, then **Restart now**.

Restarting closes what is open on kit's screen. Its files and signed-in sites stay. The new limits
then appear in the panel. Only you or your assistant can change limits, never the agent itself.

## If a computer does not start

When an agent's computer fails as it boots, Glass stops trying and says so, and the Computer
panel says Stopped:

```output
kit's computer did not start
kit's computer stopped as soon as it started (exit code 3). Press Restart computer on kit's page, then Retry. If it fails again, the box's log says why.
```

Under it are **Retry** and **Open kit's page**. Retry starts the same computer again. **Restart
computer** on kit's page makes a new one from the current image, so press it first when the box's
software was fixed, then Retry.

To see the full reason, run this on the box:

```sh
vyre call computers.checkout '{"agent":"kit"}'
```

```output
kit's computer stopped as soon as it started (exit code 3); its image (vyre/computer:0.1) may be broken: see docker logs vyre-computer-kit on the box
```

The same message is in Vyre's log on the box. Run the `docker logs` command it names for the
details.

## On a phone

Below 600 px wide, or on a touch screen, Glass lays out for the phone: the screen fits the width,
with the same Take over and Hand back. See [Mobile](mobile.md).

## What it will not do

- An agent cannot open Glass, take or release a keyboard. Those are for people.
- Let an agent undo a pause. An agent can pause its own hands, but only you resume them.
- Let an agent use another agent's computer. Each agent's hands reach its own computer only.
- It does not show your Mac's screen. Glass is for agents' computers and the box.
- It never lets two people type at once.
- The Terminal tab is not in this version.

Coming: a cap of four viewers per computer, and filling a login from your vault into the agent's
Chrome.

## Next

- [Agents](agents.md), for the rest of the agent page.
- [Vault](vault.md), for credentials an agent uses without seeing.
- [ADR 0005](../adr/0005-glass.md), for why take-over and sign-in work this way.
