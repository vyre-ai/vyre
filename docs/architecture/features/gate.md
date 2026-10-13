---
title: Gate
summary: The Gate holds every outward act that speaks, pays or deletes as the person, until a person approves the exact final words with proof they are present.
audience: builders, agents
owner: docs
status: stable
---

# Gate

## What it is

The Gate is the one path from "an agent wants this to go out" to "it went out". An agent asks, and the Gate keeps the request as a row. Only a person lets it go, and what goes out is exactly what that person approved, edits included.
Three rules sit behind it: the one-yes permission layer (`lib/one-yes.js`), the approvals queue that carries cards to a person's devices, and a single-use approval token the kernel gives a Flow's doer for exactly one act.

## What a person sees

- A held draft appears in Needs you, with where it is going. Click a field to edit it, and edits save as you type. Then choose Send exactly what is on screen, or Discard it. Command-Enter sends from the Capsule and from chat.
- Editing or discarding asks for nothing. Only Send asks you to prove you are there (Touch ID, a passkey, or Face ID on a paired phone). One proof opens a presence session on that device, and the sends after it ride it.
- A failed send goes back to held with the error above its fields, and Send tries again.
- From a terminal, `vyre call gate.approve '{"id":"h_12"}'` asks for Touch ID or a typed code.
- Settings lists what you have said may go out without asking each time (standing permissions) and lets you take one back. Adding one is a person-only act. Paying, or an allowance that names no agent, asks for proof.
- A phone shows a card for any act it can approve: what will happen, to what, and a Face ID button. See [Presence](../../concepts/presence.md).

## How it works

**What is held.** `gate.request` takes `{ kind, via, to, content }`. A kind is `send`, `spend`, `delete` or `act` (an outward computer-use act). `via` names a sender, and `gate.senders` lists them with what each takes and never a credential. `core/gate/senders.js` ships two types: `gmail` (send an email with subject, body, cc, bcc, in_reply_to) and `http` (a request to one of the sender's declared hosts). A module may offer its own sender with `gate.offer`, which the Gate calls through that module's tool after approval. The MCP hub also holds outward calls from connected tools at the Gate.

**Item states** (table `gate_items` in `core/gate/gate.js`): `held`, then `sending`, then `sent`, or `rejected`. The move from held to sending is one UPDATE guarded by state, so two surfaces pressing Send at once send once. A failed send returns to `held` with its error. If the server stops mid-send, those items go back to held, marked as possibly sent, and the person decides. `gate.settle` marks an approved-but-failed item sent when the words are found to have gone out, so nothing is sent twice.

**Who decides** (`core/gate/index.js`): `gate.request` is open to every caller including models. `gate.approve`, `gate.revise` and `gate.reject` refuse any model, guest or agent node. They accept a person's own surface (`isPerson` in `lib/caller.js`), or a module named under `gate.approvers` in config. The caller recorded as the approver is the verified one, and a `by` in the input is not read. The Gate fetches credentials from the vault at the moment of sending, so the agent never holds one.

**Presence.** Approving an item of kind send, spend, delete or act needs a presence proof. `presence.covered` says whether the device already has a live session, and every held item carries `presence: { required, covered }`. The proof summary names the kind, the sender, the destination and a 120-character preview of the final words.

**When a request does not hold.** Three paths send at once, each checked:
1. A person's own confirmation from a first-party surface (`asked`: surface, a hash of the exact request, less than 60 seconds old).
2. A card the person's phone already approved for this very call, redeemed once through `approvals.cover` within its life.
3. A saved intent in the vault (`vault.said.match`) whose kind, sender and every destination (cc and bcc too) match, or a standing permission. A plain ask is used up by the match.

**One yes** (`lib/one-yes.js`). Two questions: `isYou(subject)` (is this a verified person surface; an agent, model, module or guest never is) and `yes(moment, request, proof)`. There are three moments: `pair` (adding a device or widening reach), `vault` (revealing or filling a secret) and `outward` (any tool marked `outward` in its module.json, plus `gate.approve`, `apps.send` and `hands.commit`). The tool lists are in `lib/one-yes-ops.js`. A refusal reason is one of `no_proof`, `expired`, `replayed`, `wrong_request`, `software_key`, `unknown_key`. With no verifier configured every yes is refused. A software key counts only on builds that take one. A vault reveal, copy or code may reuse one yes for 5 minutes on the same device and person.

**Approvals queue** (`core/approvals`). A session that cannot prove presence (the web app) opens a card with `approvals.request`. The paired phone lists it, shows the sentence from `lineOfOp`, signs with Face ID, and the asker reads the proof back once and attaches it to its own act. The module checks no signature. Cards are bound to the exact op and fields, last 5 minutes, and at most 5 are open per asker. `approvals.items` is the one list of things waiting on a person (kinds: approval, ask, draft, access, run, task, eval, health, signing, signin).

**Flow holds.** A Flow send that needs a yes becomes a task with form kind `held_act`. The person's approval gives the Flows service (the task's doer) a single-use authority bound to that exact act. Another body, another doer, a second use and an unapproved task are all refused (`kernel/approval-token.test.js`).

**Events:** `gate.held`, `gate.revised`, `gate.released`, `gate.failed`, `gate.rejected`, `gate.settled`. They say that something happened and where, and never the content. What a person changes before approving is taught to Memory as `draft.edited`.

## Where the code lives

- `core/gate/gate.js`: the held-item store, states, send, revise, reject, settle, route.
- `core/gate/index.js`: the `gate.*` tools, caller rules, presence, the three no-hold paths.
- `core/gate/senders.js`: sender types and the outbound request check.
- `core/approvals/index.js`, `core/approvals/items.js`: cards, the phone's answer, the one waiting list.
- `lib/one-yes.js`, `lib/one-yes-ops.js`, `lib/one-yes-sign.js`: `isYou`, `yes`, the moment tool lists.
- `lib/hold-fields.js`, `lib/caller.js`: fields a yes is bound to, who counts as a person.
- `core/presence/index.js`: proofs and live sessions.
- `kernel/approval-token.test.js`: the single-use approval contract. `kernel/flows/runner.js`: where a Flow holds an act.
- `apps/app/ui/tasks/TaskActions.tsx`: edit, send and discard in the app.

## How agents use it

An agent calls `gate.request` and gets back a held result with an id. It sends no other way and does not retry the same draft. Open to models: `gate.request` and `gate.senders`. `gate.get` and `gate.held` list the caller kinds `cli`, `local`, `module`, `deck`, `capsule`, `tailnet`, `device`, `space` and `agent`, not MCP. `gate.said.list` is for the person's surfaces and modules. Person-only or held: `gate.approve`, `gate.revise`, `gate.reject`, `gate.settle`, `gate.said.add`. `gate.said.revoke` belongs to the person, or to the assistant only on the person's own words in the thread. Inside an agent thread a direct sending MCP tool is denied and the agent is pointed at the Gate (`gate.route`). A model cannot file a draft under another session's thread. See outward acts (agent doc "outward-acts") and authority (agent doc "authority").

## Extend it

- In 0.5, the Gate holds what Vyre recognises as a send, a payment, a delete or a computer-use act. A message sent from a shell, such as `curl` to a mail API, is not recognised as a send, and files a shell command changes are not recorded. An agent works through `gate.request` and the senders for that reason.
- An interactive artifact made by a session that read outside content and touched private data opens without a hold. Vyre shows "Runs its own code and can reach the internet" on the frame and logs a second load. Open such an artifact when you trust what the session read.
- A Flow email has no CC, BCC or attachments in 0.5 ([Flows](./flows.md)), though the `gmail` sender itself takes cc and bcc.
- A Windows PC with no Hello keeps its key in the app, which a team's server does not accept ([Identity and devices](./identity-and-devices.md)).
- For another way out, such as a fax service or a case system, build a custom module that offers a sender with `gate.offer`. The Gate calls the module's tool after a person approves. [How to extend Vyre](../../../ARCHITECTURE.md#how-to-extend-vyre) covers modules and Integrations for outside apps. Open items: [known gaps](../../known-gaps.md).

## Related

- [Flows](./flows.md), [Tasks and Needs you](./tasks-and-needs-you.md), [Vault](./vault.md), [Identity and devices](./identity-and-devices.md), [Kernel](./kernel.md)
- [Architecture map](../map.md), [Architecture overview](../overview.md)
- [Connectors](../../using/connectors.md), [Presence](../../concepts/presence.md), [The security floor](../../concepts/floor.md)
- Outward acts (agent doc "outward-acts"), Authority (agent doc "authority"), [Tools reference](../../reference/tools.md), [Events reference](../../reference/events.md)
