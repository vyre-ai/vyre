---
title: Sites and publishing
summary: A site or app goes from a draft to a private preview to a live address through one held yes from a person, with its own domain, secrets, history and isolated edge.
audience: builders, agents
owner: docs
status: stable
---

# Sites and publishing

## What it is

The Publish module (`core/publish`) puts a folder of ready files, a built site, a repo or a Dockerfile app on the internet from a Space. An agent builds the site, previews it at a private address and asks for one yes. The person says yes, and the site goes live. A business can serve it on its own domain, with Vyre showing the DNS record to add and checking it. Every version is kept, so a person can go back one. A model creates, previews and asks. Only a person's yes makes anything public.

## What a person sees

- **Sites** screen (`apps/app/screens/sites/`). Empty state: "Nothing published in this space" and "Put sites online". A site has tabs Pipeline, History, Domain, Secrets, Jobs and Logs (`RealSites.tsx`).
- **Pipeline**: a preview built says "Preview built. Nothing is public." The buttons walk Draft, Preview, Approved, Production, with "Go back one version" for rollback. The yes is taken on the card, with Face ID on a phone ("Go live with Face ID", "Not now"), and a decline reads "Declined."
- **From a chat**: a files preview's card has "Put it on the internet"; afterwards "It is live." with "Open it" and "Open the site page" (`apps/app/src/chat/PreviewPublish.tsx`).
- **Domain**: "Connect a domain" or "Add a domain". It shows "Add this record at your domain provider" with a Copy button, then "Check again" and "Not connected yet. DNS can take up to an hour to update."
- **Secrets**: "A site gets only the secrets you grant it, one by one." with "Grant one from the Vault" or "Pick from Vault". Granted ones read "Granted to this deployment. It can use it, not read it."
- **Jobs**: a scheduled job that fails shows "A job needs you" and a card in Needs you.
- **Publish from** offers a Files folder, a GitHub repo, or what an agent built in a chat.

## How it works

**Stages.** A deployment record has a stage from `STAGES` in `lib/publish/deployment.js`: Draft, Preview, Approved, Production, Retired. `TRANSITIONS` there says which moves are held: Preview to Approved is a human act (owner, admin or project manager); Approved to Production and Retired to Production (rollback) are held outward acts decided by an owner, admin or named person. Every version of a site shares its name and gets a version number; publishing a new version retires the live one, and rollback restores the previous retired version if it was once live.

**Held acts.** `publish.approve`, `publish.publish`, `publish.go`, `publish.quick`, `publish.rollback` and `publish.secret.grant` take two calls. The first call answers `{ held: true, task, plan }`, files an Ask and records a hold (tables `publish_holds`, `publish_tasks`). The plan names what goes public, at which address, with which secrets and which version it replaces, with a hash. A person then runs `publish.decide`, which has `presence: true`, refuses a caller that came through a model chain or MCP (`model_cannot_approve`), checks the person is a Space member, checks `plan_hash` against what they saw (`approval_mismatch`), and completes the act as that person.

**Preview.** `publish.preview` builds a draft and puts it at a private preview address. It is refused if the build output holds a sealed value or a secret (`lib/publish/secrets.js`). `publish.plan` shows what the next step would change. A files folder is checked by `lib/publish/folder-build.js` (secret-looking files and `.git` left out, links not followed, limits on files and size). Chat previews belong to a separate module; see [previews](../../using/previews.md).

**Domains.** `publish.domain.add` creates a pending record and returns a DNS challenge: a TXT at `_vyre-publish.<domain>` whose value is bound to the Space, the site and the host (`lib/publish/domains.js`), or, for a `<label>.vyre.run` name, a names-directory method. `publish.domain.verify` checks it through the resolver; only a verified domain ever reaches the Caddyfile. A Space holds up to 10 domains, 5 of them pending, and a challenge lasts 7 days. Verifying a domain puts nothing live.

**Secrets.** `publish.secret.grant` lets one deployment use one Vault secret under an environment name; a real secret is held for a person. The value is released through `vault.release` to Publish for a deployment holding its own grant; `publish.secret.revoke` deletes the file and restarts the app without it.

**Edge.** `publish.edge` writes, under `<home>/publish/<space>/`, a compose project, a Caddyfile and the Dockerfile of the Caddy image, plus runtime secret files. `publish.edge.up` builds and starts it only when `VYRE_PUBLISH_DOCKER=1` is set; otherwise it answers `not_available` with the plan. The edge (`lib/publish/edge.js`) is Caddy as the only public service, a rootless BuildKit with no published ports, and one service per workload on its own internal network. `assertIsolated` rejects a workload that has a Docker socket, host network, privileged mode, a bind mount, a volume shared with the Space, a capability left on, a writable root or no resource limits. The box has no public port: a relay tunnel hands TLS bytes to Caddy's loopback port (`lib/publish/tunnel.js`, see [relay and networking](./relay-and-networking.md)).

**Jobs.** A Dockerfile app can be a scheduled job (`publish.job.run`, `publish.job.runs`, `publish.job.attention`). `publish.job.run` is person-only.

**Events.** `deployment.built`, `deployment.previewed`, `deployment.approved`, `deployment.published`, `deployment.restarted`, `deployment.job-ran`, `deployment.rolled-back`, `deployment.retired`, `deployment.held`, `deployment.decided`. Setting: `publish.servers`.

## Where the code lives

- `core/publish/index.js`: tools, held acts, `publish.decide`, edge writing; `core/publish/module.json`: tool list.
- `core/publish/builder-plan.js`: BuildKit arguments for a build.
- `lib/publish/deployment.js`: stages, transitions, deployment type and actions.
- `lib/publish/domains.js`, `lib/publish/hostname.js`, `lib/publish/certs.js`: domains, DNS challenge, names.
- `lib/publish/edge.js`, `lib/publish/runner.js`, `lib/publish/proxy.js`, `lib/publish/tunnel.js`: edge files, running it, tunnel end.
- `lib/publish/folder-build.js`, `lib/publish/site-write.js`, `lib/publish/dockerfile.js`, `lib/publish/repo-source.js`: sources and builds.
- `lib/publish/grants.js`, `lib/publish/secrets.js`: secret grants and the sealed-value check.
- `lib/publish/flow.js`: the pipeline as a Flow definition (`publish.flow`).
- `apps/app/screens/sites/`, `apps/app/src/chat/PreviewPublish.tsx`: the screens.

## How agents use it

- Open to models (the `WITH_MODELS` list in `core/publish/index.js`): `publish.create`, `publish.preview`, `publish.plan`, `publish.status`, `publish.list`, `publish.quick`, `publish.approve`, `publish.publish`, `publish.go`, `publish.rollback`, `publish.domain.add`, `publish.domain.verify`, `publish.domain.status`, `publish.holds`, `publish.secret.grant`. A held tool returns a task and plan, and the model tells the person where to say yes.
- Person-only: `publish.decide`, `publish.job.run`, `publish.retire`, `publish.domain.remove` (reach `person` in `module.json`); `publish.edge`, `publish.edge.up` and `publish.edge.down` are callable only from the person's surfaces and modules, not `mcp`.
- `publish.quick` with a `preview` id is refused unless a person pressed Publish on the card; a model never names a server folder itself.
- See outward acts (agent doc "outward-acts") and [Gate](./gate.md).

## Extend it

- In 0.5 a build from a Drive folder is not available, and a scheduled job has no network. Apps with their own server publish only where the setting `publish.servers` is on (see docs/using/publish.md).
- Until the public door is on, `publish.quick` answers "Public once the public door is on", and the address works on the person's own devices.
- A business that needs another target, such as a hosting service of its own or a build step Publish does not know, adds a custom module: a folder with `module.json` and an entry file that registers tools and emits events. See [MODULES](../../MODULES.md), [the module contract](../../build/module-contract.md) and [writing a module](../../build/writing-a-module.md). An agent can write it on the business's own server, and kernel/modules runs it under the supervisor.
- For an outside service, an Integration is planned (docs/roadmap.md R051-01) with its own Flow steps, connection and agent tools.
- The full list is in [known gaps](../../known-gaps.md).

## Related

- [Vault](./vault.md), [Gate](./gate.md), [Tasks and Needs you](./tasks-and-needs-you.md), [Files](./files.md), [Relay and networking](./relay-and-networking.md), [Apps](./apps.md)
- [Map](../map.md), [Overview](../overview.md)
- [Publish](../../using/publish.md), [Previews](../../using/previews.md), Outward acts (agent doc "outward-acts"), [Modules reference](../../reference/modules.md)
- [Known gaps](../../known-gaps.md)
