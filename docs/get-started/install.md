---
title: Install
summary: Reserve your name, put the Vyre app on your Mac or Windows PC, paste the code, then join a team, add a server, or use your Mac as your home, and add your phone.
audience: users, operators
owner: integrator
status: stable
---

# Install

You set Vyre up from the Vyre app. There is no browser setup and no terminal on your own computer. The only
terminal is on the server, and only for one line the app gives you.

## Before you start

- [ ] A Mac or a Windows PC for the app. A phone alone cannot start: you reserve your name on a computer first.
- [ ] A Claude account (the app offers to connect it during setup), and a ChatGPT (Codex) or Grok account if you want them.
- [ ] If you will add a server: a Linux server (a cloud machine is fine) or a Mac that stays on, and a terminal on it.
  See [What size of server](#what-size-of-server): 8 GB of memory is recommended, 4 GB is the least, and a small server can run
  without Records on 2 GB.
- [ ] If you are joining a team: the invite your team sent you.

## What size of server

Records is where your contacts, projects and tasks live. It is a full database, and by itself it uses about 2.2 GB of memory. Vyre needs room beside it.

| Choice | Memory | Good for |
| --- | --- | --- |
| **With Records** | 8 GB recommended, 4 GB at the least | Contacts, projects, tasks, [Flows and Kits](../using/flows.md), a team. |
| **Without Records** | 2 GB | A small server, or a first try. Vyre keeps your data in a smaller built-in store, so it runs on less. |

On a server with 4 to 6 GB, Vyre uses a smaller Records setup and tells you, when it installs, how many spaces fit. If the server has less than Records needs, the installer says so and uses the small built-in store instead.

## 1. Reserve your name

Open <https://vyre.run/setup> on any computer and type the name you want. It becomes `yourname.vyre.run`.
If the name is free, press **Reserve this name**. The page shows a code that starts with `VYRE-`. Copy it.

The code is held for you for 24 hours and works once. If it runs out, reserve the name again.

## 2. Install the Vyre app

- **Mac.** Download the dmg for your Mac from the [latest release](https://github.com/vyre-ai/vyre/releases/latest):
  `Vyre-Lumen-aarch64.dmg` for Apple silicon, `Vyre-Lumen-x86_64.dmg` for an Intel Mac. Open it and drag
  Vyre Lumen to Applications. The app is not yet signed with an Apple Developer ID, so you sideload it:
  open it once, and if macOS says it cannot check the app, go to System Settings, Privacy and Security,
  and choose **Open Anyway**.
- **Windows.** Download `VyreSetup.exe` from the [latest release](https://github.com/vyre-ai/vyre/releases/latest) and
  run it. It is not code-signed yet, so if Windows says it does not recognize the app, choose **More info**,
  then **Run anyway**.

The release lists a checksum for every file, and `SHA256SUMS` is signed, so you can check what you downloaded.

## 3. Paste the code

Open the app and choose **Start**. It asks for the reservation code. Paste it. The app shows the name it holds for
you and makes your key on this computer. The key stays here.

On a Windows PC the key is made with Windows Hello, which asks for your face, fingerprint or PIN. If Windows Hello is not set up, Vyre keeps the key on this PC instead.

The app then shows a recovery code, once. It is the only way back in if you lose every device, so keep it
somewhere only you can reach, then choose **I saved it**.


## 4. Choose how you will use Vyre

The app asks how you will use it:

- **Join a team.** Paste the invite your team sent. You run on your team's server and need none of your own. This is
  the choice for most people who work at a company that uses Vyre.
- **Add a server.** A computer that stays on, like a Linux server or a Mac. Vyre runs there, and your phone and your teammates can
  reach it. Go to step 5. On a Mac this upgrades My Home to My Cloud, and on Windows it sets up My Cloud.
- **Use My Home** (Mac only). Vyre runs on this Mac while it is awake. Nothing else to set up. You can add a server later
  from Settings, and Vyre moves everything across: that is the upgrade from My Home to My Cloud.

On Windows the app offers **Join a team** and **Add a server**. A home on Windows is coming.

## 5. Add a server

1. Choose what the server is: **A Linux server or cloud machine**, or **A Mac that stays on**.
2. Choose **With Records** (recommended) or **Without Records** (a small server). Records is where your contacts, projects and
   tasks live, so pick it unless the server is small.
3. The app shows one line. Copy it, then paste it into a terminal on the server and run it as yourself, not as root.
   - On Linux it looks like `curl -fsSL vyre.run/i | VYRE_CODE=... VYRE_STORE=auto sh`.
   - On a Mac it looks like `curl -fsSL vyre.run/box/install-mac-server.sh | VYRE_CODE=... VYRE_STORE=auto sh`. It asks for the
     Mac's password once, to set Vyre up to start when the Mac starts, even with nobody signed in. On a Mac server, the Mac app's
     Touch ID key approves new devices.

   The line is good for one hour and works once. It carries a one-time code made by the app, so nobody at the server has to
   answer a question.
4. The installer checks the release's signature before it installs anything, and prints four words when it is up. The
   app finds the server by itself and shows four words too. If they are the same, choose **Same**. If they are not, choose
   **Not the same** and nothing is connected. If the words scrolled away or did not show on the server, run `vyre words` there
   (on a Mac server, `~/.vyre-server/bin/vyre words`) to see them again.
5. The app connects, and your Cloud is ready. Choose what to move across from Personal if you have anything there.


## 6. Add your phone

From the app on your computer, choose **Add your phone** and follow the code it shows.

- **Android.** Download `Vyre-android.apk` from the [latest release](https://github.com/vyre-ai/vyre/releases/latest) on the phone, open
  it, and allow installs from your browser or Files app when Android asks. The app is not on a store yet, so you sideload it.
  The same key signs every release, so a newer file installs over an older one.
- **iPhone.** There is no App Store app yet. Build the app from the source and install it on your phone with Xcode; the steps are
  in [On your phone](../using/mobile.md).

Open the app on the phone, scan the code from your computer, and check that both screens show the same words.

## A Windows PC

A Windows PC is a device, not a home: Join a team, or add a server that runs elsewhere. The app and the command line are in
[Windows](../using/windows.md).

## Your server comes back by itself

A server must be online with nobody at the keyboard: after a restart, a power cut or a logout. Vyre needs no VPN and no login to any other network
product, on the server or on your computers, so there is no sign-in that can be lost on a restart. The server rejoins the Vyre network on its own.

- **Linux server.** The containers carry a restart policy (`unless-stopped`), and the installer makes sure Docker itself starts at boot.
  After `sudo reboot` the server is back with no one signed in.
- **Mac server (a Mac mini that stays on).** The installer sets the Mac to start when power returns and never to sleep
  (`pmset autorestart 1`, `sleep 0`, `disksleep 0`, `womp 1`, `powernap 0`), and checks that Vyre's system services start at boot and are kept running.
  `vyre doctor` checks the same settings and `vyre doctor --repair` puts them right (it asks for your Mac password once).
- **FileVault.** If FileVault is on, a Mac waits at the login window after any unplanned restart, and nothing runs until someone types the password. No service can start before that.
  The Mac installer checks this before it installs anything and stops: "FileVault is on. After a power cut or a restart this Mac will wait for someone to type the password, and Vyre will be offline until then.
  For a server, turn FileVault off in System Settings, Privacy and Security, then run this line again. To keep FileVault anyway, run the line with VYRE_ACCEPT_FILEVAULT=1."
  The app's Add a server shows the same words, and `vyre doctor` reports it ("Stops after a restart until someone signs in"). Vyre never changes FileVault itself.
  For a planned restart with FileVault on, Vyre uses `fdesetup authrestart` where the Mac supports it, so the Mac comes back to the desktop without a person.

## Looking after the server

Updates, logs, moving to a new server and removing Vyre are in [Box care](../using/box-care.md).
How the server and the Mac fit together is in [The box and the Mac](../concepts/box-and-mac.md). The server can also run without Docker,
from the package: see [Without Docker](without-docker.md).

### Backup

On the server, `vyre backup` writes `vyre-backup-YYYY-MM-DD.vyre`, one file sealed with a passphrase you type (12 characters or more).
It holds your settings, the store, the sealed vault, watchers, modules, certificates, names and the artifacts your agents made, plus your project
files and session transcripts unless you leave them out with `--skip-projects` or `--skip-transcripts`. It leaves out the search model, the logs and your
Claude, Codex and Grok sign-ins (you sign in again after a restore). It opens only with that passphrase: keep the two apart. The steps are in
[Box care](../using/box-care.md).

## If setup stops partway

> [!SNAG] The app says the reservation code is not valid
> The code lasts 24 hours, works once, and a newer reservation of the same name replaces it. Reserve the name again at
> <https://vyre.run/setup> and paste the new code.

> [!SNAG] The app never finds the server
> The line is good for one hour. In the app choose **Start again**, then run the new line. Check that the server can reach the internet.
> If the installer says `Vyre is already running`, run `vyre uninstall --keep-data` on the server first, then paste the new line. Your data stays.

> [!SNAG] The four words do not match
> Choose **Not the same**. Nothing is connected. Run a fresh line from the app, and make sure you are looking at the server you just ran it on.

More failures, and the message each one prints, are in [Troubleshooting](troubleshooting.md).
