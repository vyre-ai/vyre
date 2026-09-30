# Vyre for Chrome: GoHighLevel playbook

In Claude Code every tool name has an underscore where this page writes a dot: `chrome.ghl` is `chrome_ghl`, `chrome.act` is `chrome_act`.

Read this before you build or edit a workflow in the person's own Chrome. It is written for you, the model, and it is short on purpose.

## Ground rules

1. Never open a tab to do a step. The person already has GoHighLevel open. `chrome.ghl section` and every page tool reuse that tab. The only time a tab gets opened is `chrome.ghl section` with a `locationId` when no GoHighLevel tab exists at all, and the trace says `newTab: true` when it happens. Do not call `chrome.tabs open` for GoHighLevel.
2. One `chrome.ghl run` per whole job. A flow runs as one batch inside the browser: no model turn between steps, so it is fast and it does not lose its place. Use single `chrome.act` and `chrome.fill` calls only to look around, to recover from a failure, or for a step no flow covers.
3. Every step waits for the page. You do not add sleeps. If you need to wait for something yourself, use `chrome.wait`.
4. Outward acts are held. Publishing, sending and deleting come back as `held: true` with an id. Tell the person what is waiting, then call `chrome_send` with the id; Claude Code asks them to approve it. That is by design. Do not try to click around it.

## Sequence for a workflow build

1. `chrome.ghl context`. Confirms the open tab is GoHighLevel and which sub-account (location) it is on. If `isGhl` is false, stop and tell the person.
2. `chrome.ghl section` with `section: "workflows"`. It clicks the left nav inside the app (no reload), then waits until the route changed, the loading skeleton is gone, the DOM and network are quiet, and a landmark control is on screen. It returns `via` (`nav`, `url`, or `already`) and `landmark`.
3. `chrome.ghl flows` lists the ready-made flows and the action types. Then `chrome.ghl run` with a `flow` and `params`:
   - `create-workflow`: `{name, trigger, triggerConfig?, actions: [{type, config}], save?, publish?}`
   - `add-trigger`, `add-action`: for the builder that is already open.
   - `edit-workflow`: `{name, rename?, trigger?, actions?}` opens an existing workflow by its name and appends to it.
   - `save-workflow`: press Save and verify.
   - `publish-workflow`: `{status: "published" | "draft"}`.
4. Action `type` is one of: `send-email`, `send-sms`, `wait`, `add-tag`, `remove-tag`, `if-else`, `webhook`, `update-contact-field`, `create-opportunity`. Plain names like `email` and `sms` work.
5. Action `config` is an object of visible field labels to values, for example `{subject: "Welcome", messageBody: "Thanks for getting in touch"}`. A key such as `messageBody` or `message_body` is read as "Message Body". For a dropdown use `{status: {select: "Won"}}`. A plain string config only works when the form has a field named "Action configuration".
6. If a flow does not fit, pass your own `steps` to `chrome.ghl run`. Steps are `{op, args}` using `page.act`, `page.fill`, `page.wait`, `ghl.section`, `ghl.save`. `{param}` placeholders are filled from `params`. Steps you write get the same waiting a flow has unless you set `wait` yourself.

## Which tool for which step

| Need | Tool |
|---|---|
| Go to a section | `chrome.ghl section` |
| Do a whole build | `chrome.ghl run` |
| Press Save and know it saved | `chrome.ghl save` (or the `ghl.save` step; flows already include it) |
| Look at the page | `chrome.snapshot` (controls, plus `state`: spinners, dialogs, toasts) |
| One click or one field | `chrome.act` (add `wait: {timeoutMs: 8000, stable: true}`) |
| Several fields by label | `chrome.fill` with `fields: [{label, value}]` and `partial: true` |
| Wait for the page to finish | `chrome.wait` with `settled: true`, or a `selector` (with `enabled`, `stable`, or `gone`) |
| A step that may not exist | `chrome.act` with `optional: true` (it answers `skipped`) |

`chrome.fill` by label matches the way a person reads a form: the field's label, its aria-label or placeholder, or the text next to it. If two fields fit, it says so and sets neither. Inside an open drawer or dialog it prefers that drawer's fields.

## Reading a result: the trace

Every step result carries `trace`:

- `strategy`: how the control was found. `identifier` and `role+name` and `name` are exact. `name-ci` (case), `aria` (aria-label or placeholder), `nearby-label` and `text` (whole-word containment, one candidate only) are fallbacks.
- `fallback`: true if a weaker strategy than the one you asked for matched. A run full of `fallback: true` means the labels in the flow do not quite match this account. Check them with `chrome.snapshot` and pass your own labels.
- `waitedMs`: time spent waiting for the page. High values on every step mean a slow account, not a bug.
- `retries`: how many times a stale or covered control was looked up again (at most 3).
- `newTab`: whether a tab was opened. It should be false.
- Optional extras: `dismissed` (a popup that was closed for you, with its name), `busyIgnored` (a spinner that never went away, so the wait gave up on it), `domNeverQuiet`, `unstable`.

A `chrome.fill` result lists each field as set or not found, and `notFound` names the labels that matched nothing. A field never disappears silently. An `optional` field that is missing is listed under `skipped`.

## Reading a failure

A failed step is an error, or a batch that stopped with `failed: {step, label, op}` and `why`. The error's `detail` holds:

- `tab`: host and path of the page (never the query string).
- `trace`: as above.
- `dom`: about 2 KB of the page around the target, or the open dialog, with emails, phone numbers and tokens masked. Read it before you retry. It usually shows the real label.
- `candidates`: the closest control names on the page for a not-found.
- `blockers`: any dialog in the way, with its text and its buttons.

Error codes: `not_found` (nothing matches; look at `candidates` and `dom`), `tied` (two controls fit; pass a `role` or an `identifier`), `covered` (something sits over the control), `modal` (a dialog is in front), `not_saved` (a save could not be confirmed), `timeout`, `changed`, `blocked` (the person's floor).

## A dialog is in the way

The page tools handle two cases for you. A small allowlist of harmless popups (a "what's new", a product tour, a cookie notice) is closed with its own Close, Skip or Got it button, and the trace lists it under `dismissed`.

Anything else is not touched. An unsaved-changes, confirm or delete dialog, or a dialog Vyre does not recognise, comes back as `code: "modal"` with the dialog's text and button names in `detail.blockers`. What to do:

1. Read the text. Decide with the person if it is not obvious.
2. Act on one of the dialog's own controls with `chrome.act`, by its name, for example `Stay`. A button like `Discard changes` or `Confirm` is held (approve it with `chrome_send`).
3. Then run the failed step again. Do not re-run the whole flow: `chrome.ghl run` with `steps` from the failed one on.

## A save that did not verify

`ghl.save` presses Save, then looks for proof for up to 8 seconds: a new success toast, a Save button that went disabled with the network quiet, a URL change, or (if you passed `expect.listItem`) the item in the list. It returns `{saved: true, evidence: {kind, text?}}`.

If it throws `not_saved`, nothing is confirmed. Do not assume it saved and do not press Save again blindly.

1. Read the message. It says whether an error toast appeared (its text is in `detail.toast`), or no proof appeared at all.
2. `chrome.snapshot` and look at `state.toasts`, `state.blockers` and the visible fields. A required field left empty is the usual cause.
3. Fix that, then `chrome.ghl save` again.

For a status change, use `publish-workflow`. It clicks the Publish toggle (held for the person unless they asked), saves, then reads the toggle back and fails if the status is not what you asked for.

## Honest limits

- The labels in the flows (`Create Workflow`, `Add Action`, `Save Action`, `Save Trigger`, the left nav names, the Publish toggle and the landmark controls) come from GoHighLevel's documentation. They have not been checked against a live account. Expect some to differ, and expect the first real run to need a label fix. The trace and `dom` are there so that fix takes one step.
- Fuzzy matching is deliberately conservative. It binds only when exactly one control fits, so an odd label gives you `not_found` or `tied` with candidates, never a wrong click.
- Popups outside the small allowlist are surfaced, not dismissed. A popup in a language other than English is not recognised.
- Only the main page and open shadow DOM are reachable. Content inside a cross-origin iframe (some embedded editors) cannot be driven with these tools.
- Toast text and timing differ between screens. If a screen shows no toast and no disabled Save, a save on it can fail to verify even though it worked. Check the list or the URL and pass `expect.listItem`.
- Spinners and skeletons are recognised by common class names and ARIA. A page that shows a permanent animated element makes the wait give up after a grace period and say `busyIgnored` instead of hanging.
- This has been proven against a local fixture and unit tests with fakes, not against a live account.

## The ladder: what to try, in order

Go down one rung only when the one you are on fails. The trace records the rung of every call, and a failure tells you the next one.

1. The site's own API (`chrome_api`: learn once from the page's traffic, then `catalog` and `call`). Fastest and steadiest. Prefer it for reads and bulk work, and for any step a flow struggles with. A call is made from inside the page, so the person's own login signs it.
2. The page's controls (`chrome_snapshot`, `chrome_act`, `chrome_fill`, `chrome_batch`, `chrome_ghl`). The normal path for building in the workflow UI.
3. DevTools (`chrome_inspect`, `chrome_console`, `chrome_net`, `chrome_sources`, `chrome_eval`) for a page that resists: read the real DOM, see the request that failed, find a hidden control.
4. Role and name from a snapshot, when a label is odd.
5. `chrome_screenshot`, and read it. Last, because it is slow and cannot be acted on precisely.
