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

Install the app with the steps below, then open it on the phone and choose **Sign in**: type the Space, your
username and your password, or press **Continue with GitHub**.

**Android**

1. On the phone, open the [latest release](https://github.com/vyre-ai/vyre/releases/latest) and download `Vyre-android.apk`.
2. Open the file. Android asks you to allow installs from your browser or Files app. Allow it, then install.
3. Open Vyre, then open the link from your computer, or choose **Sign in** and type the Space, your username and your password, or **Continue with GitHub**.

The same key signs every release, so a newer APK installs over an older one and keeps your data. Because it does not come from a
store, Android does not update it for you: download the new file when a release comes out.

**iPhone**

There is no App Store app yet. You build the app with Xcode and install it on your phone over a cable:

1. Install Xcode and sign in to it with your Apple ID. A free account is enough.
2. In a copy of the Vyre source, run `apps/app/scripts/ios-sideload.sh --install` with your iPhone plugged in and unlocked. The script
   builds the app and installs it. [`apps/RELEASE.md`](https://github.com/vyre-ai/vyre/blob/main/apps/RELEASE.md) has the details.
3. On the phone, trust your developer profile (Settings, General, VPN and Device Management), then open Vyre.
4. Open the link from your computer, or choose **Sign in** and type the Space, your username and your password, or **Continue with GitHub**.

A build signed with a free Apple account stops working after seven days. Run the script again to install it afresh; your data stays.

## What you can do from the phone

The places are the same five as on a computer: Home, Chats, Projects, Records and Files. Vault and Settings sit at the foot. There is no Planner page and no Apps grid.

- **Home**: what needs you, and the task field. See [Home](home.md).
- **Approve or edit a held draft**: tap it on Home. It opens full screen; tap a field to edit it,
  then Send or Discard. Swiping a draft right opens it; swiping left discards it.
- **Answer a permission question**: swipe its row on Home right to allow or left to deny, or tap it
  and choose Allow or Deny. Neither asks for Face ID.
- **Chats**: one row per agent. Every chat with an agent is one of its threads. A session you run in a terminal is mirrored a
  moment after each turn. If a session is
  busy in a terminal on your computer, what you send waits and the line above the field says "Queued for"
  the session's name; it goes in when that turn ends.
- **Find**: one box for sessions, files, agents, memory and projects, and for asking your
  assistant. It is the phone's Lumen: open it from the bar at the bottom or by pulling down. `@kit ...` asks an agent,
  `tell <session> to ...` types into a session, and `watch <session>` notifies you when it
  finishes or asks. The line under the field says what Enter will do.
- **Watch a computer's screen**: when an agent works on a computer for you, the card in the chat shows its screen live, and you can take over, sign in privately and hand back, as on the web. On the phone the screen comes from your server directly when the phone is on the same network or the tailnet; away from both it says so and tries again (the same screen over the relay is built but not proven on a phone yet).
- **Ask**: talk to your assistant or any agent, at `/ask`.
- **Files**: the Space, projects and each agent's folder, at `/u/files`. Word, Excel and PowerPoint open as a page of their text. A phone reads a picture, text or PDF up to 8 MB, otherwise a download.

Vault and Settings open from the foot of the sidebar. Memory is on a project's Memory tab. There is no `/planner` page.

## Notifications

Notifications to a closed app are not set up yet. Apple and Google need push accounts that Vyre does not have, and Vyre sends nothing
to a central server. Until then, open the app to see what is waiting for you: **Home** lists the held drafts, the permission questions and
the threads you watch. Nothing is lost while the app is closed; it waits on Home.

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
