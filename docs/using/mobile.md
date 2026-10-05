---
title: Mobile
summary: Use Vyre on your phone by installing the Vyre app from the browser, turning on notifications for the moments you are needed, and approving work from the lock screen tap.
audience: users
owner: mobile
status: draft
---

# Mobile

On a phone, Vyre is the Vyre app installed as a web app. You add it to your home screen
from the browser, it opens full screen like an app, and it can notify you when a session asks
permission, a draft waits at the Gate, a thread you watch finishes, or Vyre proposes a lesson.
The phone reaches your box through Vyre's own network, like every other device, and through
the relay when a direct path is not possible.

Installing the web app is the way to put Vyre on a phone in 0.2.0, and the rest of this page
describes it. Native iPhone and Android builds of the same app exist too (see
[Native builds](#native-builds)), but you build and install them yourself.

## Set up the phone

1. Open your box's address in Safari (iPhone) or Chrome (Android), for example
   `https://alex.vyre.run/now`. There is nothing to install or sign in to first.
2. Add it to the home screen. On an iPhone: the Share button, then Add to Home Screen. On Android:
   the browser menu, then Install app or Add to Home screen.
3. Open Vyre from the home screen icon. It opens at once, full screen, on the screen you
   last had open if that was within a day, else on Now.

Now then shows **Set up this phone**, three steps with what is left:

- **Install**: done once Vyre runs from the Home Screen. On Android, **Install** opens Chrome's
  install prompt.
- **Notifications**: **Turn on**, then allow the prompt (see
  [Turn on notifications](#turn-on-notifications)).
- **Passkey**: **Add**, then a code and a name for the phone (see
  [Approving from the phone](#approving-from-the-phone)).

**Not now** hides the card on that phone.

## What you can do from the phone

The header holds three pages, Now, Chats and Agents, which you swipe between. Your initial at
the top right opens the Places sheet: Projects, Planner, Memory, Vault, Devices and Settings.
Hold a tile for a moment to keep that place as a fourth page after Agents. A Lumen bar floats at
the bottom of the three pages; tap it, or pull down from the top of a screen, to open Find.

- **Now**: what needs you and what is running.
- **Approve or edit a held draft**: tap it in Now. It opens full screen; tap a field to edit it,
  then Send or Discard. Swiping a draft right opens it; swiping left discards it.
- **Answer a permission question**: swipe its row in Now right to allow or left to deny, or tap it
  and choose Allow or Deny. Neither asks for Face ID.
- **Chat**: your Claude Code sessions, including the ones you run in a terminal, mirrored a
  moment after each turn. With a Mac paired to the box, the Mac's sessions are listed too, each
  with the Mac's name on a chip; you can read them, and continue them on the Mac. If a session is
  busy in your Mac's terminal, what you send waits and the line above the box says "Queued for"
  the session's name; it goes in when that turn ends.
- **Find**: one box for sessions, files, agents, memory and projects, and for asking your
  assistant. It is the phone's Lumen: open it from the bar at the bottom or by pulling down. `@kit ...` asks an agent,
  `tell <session> to ...` types into a session, and `watch <session>` notifies you when it
  finishes or asks. The line under the box says what Enter will do.
- **Ask**: talk to your assistant or any agent, at `/ask`.
- **Drive**: browse the folders your box shares as Vyre Drive, at `/files`. A phone cannot mount a
  share, so it reads them: a preview for a picture, text or PDF up to 8 MB, otherwise a download.
- **Glass**: watch an agent's computer and take over. A tap is a click, a long press a right
  click, two fingers scroll, pinch zooms your view, and a keyboard button opens the soft
  keyboard. See [Glass](glass.md).

Memory, Vault, Planner and Settings open from the Places sheet or their paths (`/memory`,
`/vault`, `/planner`, `/settings`), laid out for a narrow screen.

## Turn on notifications

1. In the installed app, open **Settings**, then **Notifications**.
2. Press **Turn on notifications**, and allow the browser's prompt.
3. Choose which moments notify you: **Permission questions**, **Held drafts**, **Threads you're
   watching**, **Lessons**.
4. Set **Quiet hours** if you want them (22:00 to 07:00 by default once turned on, in your phone's
   time zone).
5. Press **Send a test**.

Other devices you turned on are listed with when a notification last reached them, and Remove.

> [!SNAG] On an iPhone there is no Turn on notifications button
> iOS delivers notifications only to an installed app (iOS 16.4 or later), not to a Safari tab.
> Settings shows the steps instead of the button: add Vyre to your Home Screen, open it from
> there, and come back to Settings.

Tapping a notification opens the app at the right place: the held item, the thread, or the
lessons in Settings.

## What a notification shows

Only that something needs you, and a link. The title is a fixed sentence per kind ("Something is
waiting for your approval"), and the link holds only an id. It never carries a draft's words, a
recipient, a tool's input or anything you typed: a push crosses Apple's, Google's or Mozilla's
servers, and a lock screen shows it to whoever holds the phone. The payload is encrypted end to
end. The details load after you tap, over your own connection to the box. The decision is
[ADR 0011](../adr/0011-web-push.md).

During quiet hours nothing is sent and nothing is queued; the moment stays in Now. A box that
cannot reach the internet cannot notify, but the app still shows everything when you open it.

## Approving from the phone

Send, Discard, Allow, Deny and taking over an agent's screen need proof that a person is at the
device. On the phone that is a passkey, with Face ID or Touch ID. If you made your first passkey
in Safari on your Mac, iCloud Keychain brings it to your iPhone, and the phone offers it when you
approve.

## Offline

When the box is out of reach, the installed app still opens. One line says "This phone is
offline." or "Your box is not answering.", with **Retry**. Now shows the counts from your last
visit and when they were taken, and Chat shows your recent session list. Nothing can be sent or
approved until the box answers.

## What it will not do

- It will not open for anyone but you. Only your own paired devices reach your box; if the
  address does not load, run `vyre doctor` on the box and read **Path to your server** and **Relay**.
- It will not show a draft's contents in a notification.

- The native builds do not get notifications yet. Notifications on the phone are the web app's
  push, so they need the installed web app.

## Native builds

The phone app is one app, in `apps/app`. It runs as the web app your box serves, and the same code
builds an Android APK and an iPhone app. The native builds keep the phone's signing key in the
phone's hardware (Secure Enclave on an iPhone, Keystore on Android), and approvals ask for Face ID
or a fingerprint. You type your box's name, and a passkey approves the phone once.

In 0.2.0 you build these yourself: [`apps/RELEASE.md`](https://github.com/vyre-ai/vyre/blob/main/apps/RELEASE.md)
has the steps for a cable install, TestFlight and an Android APK, and they need your own Apple or
Google developer account. Native push is not on the box yet, so the web app is the one that
notifies you.

## Next

- [Security](../security/index.md), passkeys and what a phone may approve.
