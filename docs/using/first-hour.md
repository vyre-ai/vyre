---
title: Your first hour
summary: A 20-minute first run of Vyre, in order. Install on the Mac, sign in to Claude, pair your phone, ask the Capsule, send one email, let Vyre use the Mac, and make the Deck your own colour.
audience: users
owner: docs
status: draft
---

# Your first hour

Twenty minutes, eight steps, each one small enough to check before the next. You need a Mac,
your phone, a Claude subscription (or an Anthropic API key), and a Tailscale account. If a step
stops, [troubleshooting](../get-started/troubleshooting.md) has the fix, and `vyre doctor` says
what is wrong in under two seconds.

Use your own details throughout. Nothing here needs example data.

## 1. Install on the Mac (3 minutes)

```sh
npm install -g https://vyre.run/box/vyre.tgz
vyre up
```

`vyre up` asks where Vyre should run. Pick a server you reach over SSH if you have one, so Vyre
keeps working while the Mac sleeps, or this Mac to try it first. Then the browser opens for
onboarding: you, Claude Code, Tailscale, your address, your passkey, your history, your devices.
[Install](../get-started/install.md) walks every screen.

**Check:** `vyre status` says vyred is running.

## 2. Sign in to Claude (2 minutes)

In onboarding's **Claude Code** step, choose **Your Claude subscription**, then **Sign in with
Claude**. A browser tab asks you to approve; paste the code it shows back into onboarding. The
token goes straight into the vault, sealed on the box: you never copy it into a terminal or a
file. An Anthropic API key is the other choice on the same screen.

Skipped it? Deck **Settings**, **Claude Code**, **Re-connect** brings the same step back.

> [!GAP]
> Setting up every key from one "needs a credential" flow in the vault (ADR 0028) comes with the
> vault connections work. Until then, Claude signs in here, and other keys through their own
> screens.

**Check:** Deck **Settings**, **Claude Code** shows you as signed in.

## 3. Pair your phone (4 minutes)

1. Install Tailscale on the phone and sign in with the same account as the Mac.
2. Scan the QR code on onboarding's **Your devices** step, or open your box's address with `/now`
   at the end.
3. Add it to the home screen: on an iPhone, Share, then **Add to Home Screen**; on Android, the
   browser menu, then **Install app**.
4. Open it from the icon and turn on notifications when Now offers them.

If the box runs on a server, your Mac also asks to pair. The phone's Now shows "A Mac wants to
pair" with a code: type the code the Mac printed, press **Approve**, and confirm with Face ID.
A Mac can't approve itself, which is why the phone comes first
([known gaps](../known-gaps.md)).

**Check:** on the Mac, `vyre link` says "linked to" and names your box.

## 4. Ask the Capsule (3 minutes)

```sh
vyre capsule
```

The first run builds the Capsule on your Mac and opens it. Allow Input Monitoring when macOS asks
([Allow double-Control](capsule.md#allow-double-control)), then press Control twice anywhere.

Ask something about your own recent work, in your own words, and press Return. The reply comes
from your assistant, and facts marked in gold came from your memory, not a model.

To see the sources behind an answer, ask the same thing from the terminal:

```sh
vyre memory ask "what did I work on yesterday" --sources
```

It prints the answer, how sure it is, and the lines from your sessions it rests on.

> [!GAP]
> Answers that appear on their own when you pause, and Vyre Memory's answers with sources right in
> the Capsule (ADR 0034), arrive with the next Capsule and memory releases.

## 5. Send one email (3 minutes)

1. Deck **Settings**, **Connections**, **Add Google account**, **Sign in with Google**. Pick your
   account and allow what it asks. (From a terminal: `vyre connect add google <name> --sign-in`.)
2. In the Capsule or in Chat, ask your assistant to email you a one-line note, to your own
   address.
3. The email does not go. It waits at the Gate: Now shows it with the address it leaves from, the
   To line, the subject and the words. Change anything you like; editing asks for nothing.
4. Press **Send**, and confirm with Touch ID or your passkey. One proof covers the next 30
   minutes on that device.

**Check:** the note is in your inbox, and Now no longer shows it.
[Hold and approve a send](connectors.md#hold-and-approve-a-send) has the rules.

## 6. Let Vyre use the Mac (2 minutes)

> [!GAP]
> "do …" is in the next Capsule release. If your Capsule has it, try this step; if not, skip it.

In the Capsule, type `do` and a small task on this Mac, like opening an app you use every day,
and press Return. The first time, macOS asks for Accessibility and Screen Recording for Vyre:
allow both in System Settings, Privacy and Security. A pill shows while Vyre drives, each step on
screen. Press `Esc` to stop it at once. Anything that sends, pays or deletes still waits for you.

## 7. Open Deck Settings (1 minute)

Open the Deck (your box's address, or the phone icon) and go to **Settings**. Every section has
its own link, so `/settings#devices` jumps straight to your devices. Look at **Your devices**,
**Notifications** (quiet hours) and **Security** (your passkeys).

> [!GAP]
> The settings hub (ADR 0035) puts every setting in one place, at account or project level, the
> same in the Deck, on the phone and from the terminal. It lands with the native-core release.

## 8. Change a colour (2 minutes)

**Settings**, **Appearance** switches this browser between Dark and Paper.

To change a colour on every device, add a `theme` block to `config.json` on the box and reload
the Deck. For example, a different accent in the dark theme:

```json
{ "theme": { "colors": { "dark": { "signal": "#7FD1B9" } } } }
```

A value that is not a plain colour is dropped, so a typo never breaks the Deck.
[Change the colours](deck.md#change-the-colours) lists the names you can set.

> [!GAP]
> With the settings hub, colours, fonts and spacing become `appearance.tokens`, checked for
> contrast before they are saved, and every surface follows the change live.

## When you are done

- `vyre doctor` for a health check any time.
- `vyre tips` for short tips on every part of Vyre.
- [Your first day](../get-started/first-day.md) for what to try next.
