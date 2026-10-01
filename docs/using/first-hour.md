---
title: Your first hour
summary: A first run of Vyre, in order. Set up your server, sign in to Claude, open Vyre on your phone, put the Lumen on your Mac and ask it, send one email, and make the Deck your own colour.
audience: users
owner: docs
status: draft
---

# Your first hour

Eight steps, each one small enough to check before the next. You need a Linux server you can open
a terminal on (or a Mac that stays on), your Mac, your phone, a Claude, ChatGPT or Grok account,
and a Tailscale account. If a step stops, [troubleshooting](../get-started/troubleshooting.md) has
the fix, and `vyre doctor` says what is wrong in under two seconds.

Use your own details throughout. Nothing here needs example data.

## 1. Set up your server (about 15 minutes)

Open <https://vyre.run/setup>, choose where Vyre will live, and paste the one line it shows into
a terminal on that server. The page watches the install, checks four words with you, helps you
claim an address such as `alex.vyre.run`, and connects Tailscale. [Install](../get-started/install.md)
walks every screen.

**Check:** the page says **You're in** at your own address, and `vyre status` on the server says
Vyre is running.

## 2. Sign in to your AI (2 minutes)

On setup's **Sign in to your AI** screen, press **Sign in with Claude** (or ChatGPT or Grok). A
page on the provider asks you to approve, and the page shows a code to enter or a box to paste the
code the provider gives you. The token goes straight into the vault, sealed on your server: you
never copy it into a terminal or a file.

Skipped it? Deck **Settings**, **Claude Code**, **Re-connect** brings the same step back.

**Check:** Deck **Settings**, **Claude Code** shows you as signed in.

## 3. Open Vyre on your phone (4 minutes)

1. Install Tailscale on the phone and sign in with the same account as your computer.
2. Open your address with `/now` at the end, for example `https://alex.vyre.run/now`, in Safari
   (iPhone) or Chrome (Android).
3. Add it to the home screen: on an iPhone, Share, then **Add to Home Screen**; on Android, the
   browser menu, then **Install app**.
4. Open it from the icon and turn on notifications when Now offers them.

Step 4 pairs your Mac with the server. The phone's Now then shows "A Mac wants to pair" with a
code: type the code the Mac printed, press **Approve**, and confirm with Face ID. A Mac can't
approve itself, which is why the phone comes first ([known gaps](../known-gaps.md)).

**Check:** on the Mac, once step 4 is done, `vyre link` says "linked to" and names your server.

## 4. Put Lumen on your Mac and ask it (5 minutes)

On the Mac, install the `vyre` command and pair it with your server:

```sh
npm install -g https://vyre.run/box/vyre.tgz
vyre up --connect https://alex.vyre.run
```

Approve the pairing on your phone, as step 3 says. `vyre up` then builds Lumen on your Mac and
opens it. To build it yourself, or if it did not open:

```sh
vyre capsule
```

Allow Input Monitoring when macOS asks
([Allow double-Control](capsule.md#allow-double-control)), then press Control twice anywhere.

Ask something about your own recent work, in your own words, and press Return. The reply comes
from your assistant, and facts marked in gold came from your memory, not a model.

To see the sources behind an answer, ask the same thing from the terminal:

```sh
vyre memory ask "what did I work on yesterday" --sources
```

It prints the answer, how sure it is, and the lines from your sessions it rests on.

## 5. Send one email (3 minutes)

1. Deck **Settings**, **Connections**, **Add Google account**, **Sign in with Google**. Pick your
   account and allow what it asks. (From a terminal: `vyre connect add google <name> --sign-in`.)
2. In Lumen or in Chat, ask your assistant to email you a one-line note, to your own
   address.
3. The email does not go. It waits at the Gate: Now shows it with the address it leaves from, the
   To line, the subject and the words. Change anything you like; editing asks for nothing.
4. Press **Send**, and confirm with Touch ID or your passkey. One proof covers the next 30
   minutes on that device.

**Check:** the note is in your inbox, and Now no longer shows it.
[Hold and approve a send](connectors.md#hold-and-approve-a-send) has the rules.

## 6. Let Vyre use the Mac (2 minutes)

In Lumen, type `do` and a small task on this Mac, like opening an app you use every day,
and press Return. The first time, macOS asks for Accessibility and Screen Recording for Vyre:
allow both in System Settings, Privacy and Security. A pill shows while Vyre drives, each step on
screen. Press `Esc` to stop it at once. Anything that sends, pays or deletes still waits for you.

## 7. Open Deck Settings (1 minute)

Open the Deck (your box's address, or the phone icon) and go to **Settings**. Every section has
its own link, so `/settings#devices` jumps straight to your devices. Look at **Your devices**,
**Notifications** (quiet hours) and **Security** (your passkeys).

## 8. Change a colour (2 minutes)

**Settings**, **Appearance** switches this browser between Dark and Paper.

To change a colour on every device, add a `theme` block to `config.json` on the box and reload
the Deck. For example, a different accent in the dark theme:

```json
{ "theme": { "colors": { "dark": { "signal": "#7FD1B9" } } } }
```

A value that is not a plain colour is dropped, so a typo never breaks the Deck.
[Change the colours](deck.md#change-the-colours) lists the names you can set.

## When you are done

- `vyre doctor` for a health check any time.
- `vyre tips` for short tips on every part of Vyre.
- [Your first day](../get-started/first-day.md) for what to try next.
