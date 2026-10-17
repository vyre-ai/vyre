---
title: "Onboarding: one first-run flow"
summary: Identity, an optional AI sign-in, a space, then Ready. One implementation in the app and the same registry tools everywhere else.
audience: builders
owner: launch
status: stable
---

# Onboarding: one first-run flow

There is a single live first run. The app route is `/onboard` (`apps/app/app/onboard.tsx` → `screens/first-run/FirstRun.tsx`). Every step calls a tool registered in `core/onboard/first-run.js`. The MCP server forwards those tools; nothing in the app reaches around the kernel.

## Phases

| Phase | What happens |
| --- | --- |
| Identity | Create a username and master password, save the recovery key, optionally continue with GitHub, then optionally sign in to an AI (Claude, Codex, Grok, …) through each provider's own login. Credentials stay in the person's vault; agents never receive them. |
| Space | Join with an invite, create a space (Linux or always-on Mac) and wait for the install line, or invite someone. |
| Ready | Pick a space when there are several, then open the app. |

Progress is stored per person (`onboard.first.progress` / `onboard.first.progress.save`), not on the box config alone, so a reload resumes on the same step.

## AI sign-in

After identity, the optional **Sign in to an AI** step lists every login-able adapter from `lib/agent-adapters.js` (`loginAdapters`). Each sign-in goes through `onboard.agent.signin`, which calls `sessions.accounts.signin` and never returns vault material.

## Approvals

Every outward first-run write (`onboard.person.create`, `onboard.space.*`, `onboard.member.link`, `onboard.github.finish`, `onboard.agent.signin`, …) is held for a one-tap approval when the caller is `mcp:agent:<name>`. Passwords and recovery keys are refused from model callers.

## What was removed

- Removed prototype screens: former `apps/app/screens/onboard` and `apps/app/screens/onboarding` trees (superseded by `screens/first-run`).
- The server-hosted wizard under `web/onboard/*` (the daemon now serves a short redirect into the app flow).
- The old STEPS box wizard in `core/onboard/index.js` is no longer the product path; first run is `registerFirstRun` only for people setting up identity and spaces.

## Related tools

- Shape and copy: `lib/first-run-shape.js`
- App door: `apps/app/screens/first-run/real.js`
- Mock/sample shots: `apps/app/screens/first-run/mock.js` (mock builds only, `?shot=`)
