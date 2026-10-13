---
title: Apps
summary: The Vyre app on web, phone, Mac and Windows: one Expo codebase served by vyred, the native Mac shell with the Lumen command bar, the Windows shell, sideloaded phone builds and push.
audience: builders, agents
owner: docs
status: stable
---

# Apps

## What it is

There is one Vyre app, an Expo codebase in `apps/app`. It is the web app a server serves at /app/, the hosted app at app.vyre.run, the Android APK and the iPhone build. The Mac and Windows apps are thin native shells around the same pages, plus native pieces such as the Lumen command bar on the Mac.
The server checks everything the app does. Every read and write goes to a server over the app client, and the server's kernel decides.

## What a person sees

- Sidebar (`apps/app/screens/shell`): Now, Chat, Projects, Files; an AI group with Agents and Flows; and Settings with groups Space (Space, People and roles, Connections, Rules, Tags, Memory, Sites and publishing), Security (Vault, Devices, Permissions, Privacy) and System (Servers, This computer). Labels come from `apps/app/screens/shell/settings-items.js`.
- Routes live under /u/ (for example /u/now and /u/chats), with pair, join, onboard and devices as entry screens (the pair, join, onboard and devices files under `apps/app/app`).
- A held action opens an approval sheet (`apps/app/screens/shell/ApprovalSheet.tsx`); the Needs you row can be swiped to approve with a 4 second undo.
- The Engineer is opened from Playbooks, Objects, Flows and Agents pages (`apps/app/screens/engineer`).
- On a Mac, press Control twice for Lumen, the command bar (`docs/using/capsule.md`).
- On a phone the app approves with Face ID or a fingerprint after the phone is paired from a computer ("Add your phone").

## How it works

**Served by vyred.** `core/daemon/app.js` serves the web export of `apps/app` (built into apps/app/dist by CI and packed into the release, never committed) at /app/, or at the root when config `app.root` is set. It is a single-page app: any route that is not a file returns `index.html`. A packaged daemon serves a file only when it is on the release's signed list and its bytes match (`lib/app-build.js`). `core/daemon/app-sw.js` is the service worker, filled in per build with the base path and precache list; it never answers for the server's own paths (/v1, /onboard, /person, /release, /kernel, /lib) and never caches a /v1/ call. The CSP is `default-src 'self'` with `frame-ancestors 'none'`.

**Hosted app.** The same export is served from app.vyre.run. A page at another origin may call a box only if config `network.origins` allows it; the default is the app.vyre.run origin (`docs/reference/config.md`).

**Talking to a server.** `apps/app/src/api/client.ts` is the box client over `core/resilience`: events through a stream, every write through an outbox with an Idempotency-Key. Connection state is `live`, `reconnecting` or `offline`, and an outbox row is `sending`, gone on the server's answer, or `refused` with its reason (`apps/app/src/state/connection.ts`).

**Who the app is.** At the server's own origin the `__Host-vyre_person` cookie identifies the person. At another origin the app signs each request with a device key (`apps/app/src/auth`, PKCE and a signed `x-vyre-proof` header). On a phone the key lives in the Secure Enclave or Android Keystore (`apps/app/modules/vyre-signer`); a human-only call needs a strong biometric per signature. The kernel checks the person, grants and reach on every call, exactly as for a CLI or agent call; see [Identity and devices](./identity-and-devices.md).

**Mac.** `local/capsule/native` is a Swift app (folders under `local/capsule/native/Sources`: Host, UI, Providers, Agent, Vyred). `build.sh app` builds `Vyre.app`; `scripts/make-dmg.sh` and `scripts/mac-app-package.sh` make the dmg and zip. It is signed ad hoc or with a local identity; there is no Developer ID or notarization, so macOS asks the first time. `local/capsule/native/Sources/Host/BundledApp.swift` carries the web export inside the app so a Mac whose Vyre runs on a server has pages to show without a local vyred. The module `capsule` (`local/capsule/index.js`, role `local`) exposes `capsule.show`, `capsule.status`, `capsule.view` and `capsule.act`; `capsule.show` puts a `capsule.requested` event on the stream, which the app follows. With `capsule.autostart: true` in config.json vyred starts the app hidden in the menu bar.

**Windows.** `local/capsule/native-win` holds a Tauri shell (`local/capsule/native-win/app/tauri.conf.json` and the Rust files in `local/capsule/native-win/src`): tray, hotkey, device key (`local/capsule/native-win/src/devicekey.rs`) and bundled first-run pages. Installed with `scripts/install-windows.ps1`. A Windows PC is a device, never the home, and Lumen is Mac-only.

**Phone.** Android ships as an APK from the release page. iPhone is built with `apps/app/scripts/ios-sideload.sh` (free personal team, 7 day profile, install again within the week); that build leaves out App Attest, push, associated domains, app groups and iCloud, and the presence key stays a Secure Enclave key, unattested.

**Push.** `core/push` sends Web Push: tools `push.key`, `push.subscribe`, `push.unsubscribe`, `push.devices`, `push.settings`, `push.seen`, `push.test`, `push.receipt`. Push is for "needs you" only and is held while a screen is in use (`push.seen`). A notification carries a kind, a fixed title and the app path to open, never content or a name the person typed; details are fetched after the tap over the person's own connection. Events: `push.subscribed`, `push.delivered`, `push.seen`, `push.capped`.

## Where the code lives

- `apps/app/package.json`, `apps/app/app`, `apps/app/screens`, `apps/app/src`, `apps/app/ui`: the Expo app. Routes, one screens folder per area, api and auth and state and session code, UI components. `apps/app/modules` holds the native signer and `apps/app/scripts/ios-sideload.sh` the iPhone sideload build.
- `core/daemon/app.js`, `core/daemon/app-sw.js`, `lib/app-build.js`: serving, service worker, signed file list.
- `local/capsule/index.js`, `local/capsule/native`, `local/capsule/native-win`: the `capsule` module, the Mac Swift shell and the Windows Tauri shell.
- `local/hands-mac`, `local/screen-mac`, `local/voice`, `local/sideview`: other Mac-only helpers.
- `core/push/index.js`: web push. `web/manifest.webmanifest`: the install manifest.
- `scripts/make-dmg.sh`, `scripts/mac-app-package.sh`, `scripts/install-windows.ps1`, `scripts/install-mac-server.sh`: packaging and installers.
- `apps/test` and `.github/workflows/app.yml`: app tests and the CI build.

## How agents use it

- Agents use tools, not the app. The tools that touch app surfaces: `capsule.show` and `capsule.status` (local role), `push.test` and `push.settings` (person surfaces). Push and capsule tools take a person caller, not a model.
- An agent shows the person something by posting a card or a preview through chat and previews, not by driving the app. See [Chats](./chats.md) and [Tasks and Needs you](./tasks-and-needs-you.md).
- Docs: Tools (agent doc "tools"), Outward acts (agent doc "outward-acts").

## Extend it

- In 0.5 push goes out as web push. Native push waits for Apple and Google push accounts. The Windows app is unsigned, so Windows asks for **More info**, then **Run anyway**. A Windows PC is a device and runs no sessions of its own, and CSV export is in the web app. Real iPhone and Android walks are still to come.
- A business that wants its own screen or action adds a custom module: a folder with `module.json` and an entry file that registers tools and emits events (see [MODULES](../../MODULES.md), [the module contract](../../build/module-contract.md) and [writing a module](../../build/writing-a-module.md)). core/modules loads it, kernel/modules supervises it, and its tools reach Flows and agents. An agent can write it on the business's own server.
- For an outside app, an Integration is planned (docs/roadmap.md R051-01). It wraps the app's API and brings its own Flow steps, triggers, connection and agent tools.
- The full list is in [known gaps](../../known-gaps.md).

## Related

- [Identity and devices](./identity-and-devices.md), [Relay and networking](./relay-and-networking.md), [Sessions and models](./sessions-and-models.md), [Gate](./gate.md), [Chats](./chats.md), [Spaces and members](./spaces-and-members.md)
- [Architecture map](../map.md), [Architecture overview](../overview.md)
- [Mobile](../../using/mobile.md), [Windows](../../using/windows.md), [Lumen](../../using/capsule.md), [Configuration](../../reference/config.md)
