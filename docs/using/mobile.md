---
title: Mobile
summary: Put the Vyre app on your phone from a file (the Android APK, or an iPhone build you install with Xcode), pair it from your computer, and approve work with Face ID or a fingerprint.
audience: users
owner: mobile
status: draft
---

# Mobile

On a phone, Vyre is the Vyre app, installed from a file. It is not on the App Store or Google Play yet, so you sideload it:
Android from the APK on the release page, iPhone from a build you install with Xcode. The app approves things for you with
Face ID or a fingerprint, and it reaches your server through Vyre's own network, like every other device, and through the relay
when a direct path is not possible.

## Set up the phone

You add the phone from the Vyre app on your computer: choose **Add your phone**, then follow the steps below. The app on the
computer shows a code. The phone and the computer each show the same words, and you confirm they match.

**Android**

1. On the phone, open the [latest release](https://github.com/vyre-ai/vyre/releases/latest) and download `Vyre-android.apk`.
2. Open the file. Android asks you to allow installs from your browser or Files app. Allow it, then install.
3. Open Vyre and scan the code on your computer. Check that both screens show the same words.

The same key signs every release, so a newer APK installs over an older one and keeps your data. Because it does not come from a
store, Android does not update it for you: download the new file when a release comes out.

**iPhone**

There is no App Store app yet. You build the app on a Mac with Xcode and install it on your phone over a cable:

1. Install Xcode and sign in to it with your Apple ID. A free account is enough.
2. In a copy of the Vyre source, run `apps/app/scripts/ios-sideload.sh --install` with your iPhone plugged in and unlocked. The script
   builds the app and installs it. [`apps/RELEASE.md`](https://github.com/vyre-ai/vyre/blob/main/apps/RELEASE.md) has the details.
3. On the phone, trust your developer profile (Settings, General, VPN and Device Management), then open Vyre.
4. Scan the code on your computer, and check that both screens show the same words.

A build signed with a free Apple account stops working after seven days. Run the script again to install it afresh; your data stays.

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
- **Watch a computer's screen**: when an agent works on a computer for you, the card in the chat shows its screen live, and you can take over, sign in privately and hand back, as on the web. On the phone the screen comes from your server directly when the phone is on the same network or the tailnet; away from both it says so and tries again (the same screen over the relay is built but not proven on a phone yet).
- **Ask**: talk to your assistant or any agent, at `/ask`.
- **Drive**: browse the folders your box shares as Vyre Drive, at `/files`. A phone cannot mount a
  share, so it reads them: a preview for a picture, text or PDF up to 8 MB, otherwise a download.

Memory, Vault, Planner and Settings open from the Places sheet or their paths (`/memory`,
`/vault`, `/planner`, `/settings`), laid out for a narrow screen.

## Notifications

Notifications to a closed app are not set up yet. Apple and Google need push accounts that Vyre does not have, and Vyre sends nothing
to a central server. Until then, open the app to see what is waiting for you: **Now** lists the held drafts, the permission questions and
the threads you watch. Nothing is lost while the app is closed; it waits in Now.

## Approving from the phone

Send, Discard, Allow, Deny and taking over an agent's screen need proof that a person is at the device. On the phone that is Face ID,
Touch ID or your fingerprint, using a key the phone keeps in its secure hardware.

## Offline

When the server is out of reach, the app still opens. One line says "This phone is
offline." or "Your box is not answering.", with **Retry**. Now shows the counts from your last
visit and when they were taken, and Chat shows your recent session list. Nothing can be sent or
approved until the box answers.

## What it will not do

- It will not open for anyone but you. Only your own paired devices reach your server; if it does not connect, run `vyre doctor` on the server and read **Path to your server** and **Relay**.
- It will not notify you while it is closed, yet.
- It will not update itself. Download the new APK, or build the iPhone app again, when a release comes out.

## Next

- [Security](../security/index.md), passkeys and what a phone may approve.
