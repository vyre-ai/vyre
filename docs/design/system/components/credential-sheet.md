---
title: Credential sheet
summary: The one sheet every surface shows when a module answers needs_credential. What it asks (a key, a file or a sign-in), why in one line, a secret field that never echoes, where it is kept, the grant in the same step and one Touch ID, with an inline variant in the Capsule and a bottom sheet on the phone.
audience: builders
owner: app-design
status: draft
---

# Credential sheet

When a module cannot act because a key or a sign-in is missing, it answers with one shape,
`{code: "needs_credential", detail: {module, need, account?}}`, and every surface turns that into
this sheet. The surface asks `vault.need {module}` for how to fill the need (`how: "field" |
"file" | "oauth"`, its `fields`, `help` and `next`) and saves with `vault.connect {module, need,
fields | file, label?}`, which stores the item, grants it to the module and records the connection
in one step (ADR 0028 decision 9a; cohesion's item 7). It replaces the voice key command's prompt,
the grant command for the Claude token, onboarding's Claude step and connectors' client item on
screen. It is the sheet (sheet.md) with form controls (form-controls.md) and one button set; it
adds no new part. Not drawn on a board yet (see Gaps).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | a sheet in `deck/js/sheet.js` (proposed `deck/js/connect-sheet.js`, work/pwa) | not built |
| App | a sheet on the chat-core error path (work/mobile) | not built |
| Capsule | the inline row in `local/capsule/native/Sources/UI/CapsuleView.swift` (work/capsule-pro) | not built |
| CLI | the hidden prompt of `vyre vault connect <module>` (work/vault) | not built <!-- terms: ignore --> |

## Anatomy

A sheet: a centred card 540 wide on the desktop, a bottom sheet under 720.

1. **Header.** Title 22/28 600: "Connect Deepgram" (a key or a file), "Sign in to Google" (a
   sign-in), "Sign in to alex@northwindbakery.com again" (when `account` is given). The close icon
   button on the right.
2. **Why.** One line under the title, 13/18 `--text-2`, from the need's `purpose`, naming the
   module in plain words: "Voice uses it to hear you." "Mail uses it to send as
   alex@harlowlegal.com." Never the module id, the need id or a tool name.
3. **Choice** (only when the need is a group). A segmented control (2 to 4) or a select (5 or
   more) of the group's providers: Deepgram, OpenAI, ElevenLabs. The first ready or most common one
   is chosen.
4. **Fields**, by `how`:
   - `field`: one field wrapper per entry in `fields`, with its label. A secret field is a field
     (form-controls.md) in JetBrains Mono 13 (17 on the phone) that shows only dots; there is no
     show button and the value is never echoed, logged or put in the page. Paste works; on the
     phone a trailing "Paste" ghost button (xs, 44 target) pastes from the clipboard. Autofill and
     spell check are off.
   - `file`: a field 64 tall with the file icon, "Drop the JSON file here" 13/18 `--text-2` and a
     "Choose file" outline button xs. Once chosen: the file name in mono 13 and Remove.
   - `oauth`: no field. The body says where the sign-in happens: "Google opens in your browser.
     Come back here when you're done."
   - A need that takes several accounts (`multiple`) adds a Label field: "Name this account", with
     the provider's account as its placeholder.
5. **Help.** The need's `help` in 12/16 `--label` under the fields, with an "Open Deepgram" link
   (ghost xs) when the catalog has the provider's key page.
6. **Kept.** One line, 12/16 `--label`, with a 12 vault icon: "Kept in your vault on the box." and,
   under it, the grant in the same words the person will see later: "Voice can use it. Nothing
   else can."
7. **Actions.** One primary, lime, once: **Connect** (a key or a file) or **Sign in with Google**
   (oauth), with the Touch ID glyph (Face ID on the phone) beside its label. It is disabled until
   the fields have values. No Cancel: the close button is the way out.

## Variants

| Variant | Where | Shape |
|---|---|---|
| Sheet, desktop | Deck and PWA on a laptop | centred card 540, top 56, `--panel`, `--popover` shadow, scrim |
| Sheet, phone | PWA and app | bottom sheet, fit content; fields 44; Connect 54 full width; the keyboard pushes the actions up |
| Inline, Capsule | the Capsule's body | one row, then the field in place (below) |
| Prompt, CLI | `vyre vault connect voice` | the why line, a hidden prompt, "Kept in your vault on the box." (vault's) <!-- terms: ignore --> |

**Inline in the Capsule.** A result row at 44 at the top of the body, in place of what could not
run: the key icon in a 20 tile, title "Connect Deepgram to talk" 13/18 `--text`, meta 12/16
`--label` "Voice needs a speech key · Kept in your vault on the box". ⏎ turns the row into the
secret field (a native secure field, 32 tall, mono 13, full width minus 32) with "⏎ Connect with
Touch ID · Esc Cancel" in the footer. A group shows its providers as three rows first ("Deepgram",
"OpenAI", "ElevenLabs"); ⏎ on one opens its field. A sign-in (`oauth`) row opens the browser on ⏎
and reads "Finish signing in to Google in your browser" until `vault.connected` arrives. The <!-- terms: ignore -->
Capsule never opens a separate window for this.

Where it opens from: any tool call that answers `needs_credential`, anywhere: the Capsule when you
talk with no speech key, chat when an agent's send has no mail login, an account row's Sign in
(account-row.md), onboarding's Claude step, Settings, Vault, Connections.

## States

| State | What shows |
|---|---|
| Asking | as above; focus in the first field (oauth: on the primary) |
| Connecting | the primary keeps its width: "Connecting" with a spinner; fields read only |
| Proof | the system Touch ID or Face ID prompt, once, for the whole step: storing and granting ride on the same proof |
| Signing in (oauth) | "Waiting for Google" with a spinner and "Finish in your browser" 12 `--label`; Open again (ghost) after 10 s |
| Connected | the sheet closes; a toast (toast.md) "Deepgram connected · Voice can use it"; what asked runs again once, by itself |
| Not accepted | the help line becomes the reason in `--text` with the failed mark: "Deepgram didn't accept this key." and the provider's detail in mono 12 under it; the field keeps its dots and is selected, so a paste replaces it |
| Proof refused | "Touch ID didn't confirm. Nothing was saved." in the help line; the primary is ready again |
| Box away | "Connecting needs the box." 13 `--text-2`; the primary is disabled; the fields are cleared when the sheet closes |
| Already ready | the sheet is not shown; the surface retries at once |

Nothing typed is kept by the surface after the sheet closes, in any state.

## Keyboard and touch

⏎ in the last field connects; Tab moves between fields; Esc closes (the Capsule: collapses the row,
then clears). ⌘V pastes into the secret field. The segmented choice takes ← and →. On the phone
the fields are 44, Paste is 44, and Connect is 54.

## Motion

As sheet.md: in over `--motion-sheet`, out over `--motion-panel`. The Capsule's row opens its field
in place with no animation. Reduced motion: opacity only.

## Copy

- Titles: "Connect Deepgram", "Sign in to Google", "Sign in to alex@northwindbakery.com again".
- Why: one sentence from the module: "Voice uses it to hear you."
- "Kept in your vault on the box.", "Voice can use it. Nothing else can."
- Buttons: "Connect", "Sign in with Google", "Choose file", "Paste", "Open Deepgram", "Open again".
- States: "Connecting", "Waiting for Google", "Finish in your browser", "Deepgram connected · Voice
  can use it", "Deepgram didn't accept this key.", "Touch ID didn't confirm. Nothing was saved.",
  "Connecting needs the box."
- Capsule: "Connect Deepgram to talk", "Voice needs a speech key".
- Never "API key required", "Error", "Authenticate", "Credentials", "Paste your secret", or a
  module or tool id.

## Accessibility

- `role="dialog"`, labelled by the title and described by the why line.
- The secret field is `type="password"` (a native secure field in Swift), named by its label
  ("Deepgram key"); its value is never in an accessible name or description.
- The reason on failure is tied to the field (`aria-describedby`) and announced once (polite).
- Touch ID and Face ID are named in the button's label: "Connect with Touch ID".

## Gaps

Deck (work/pwa)
- [ ] Nothing built: the sheet on any `needs_credential` answer, from `vault.need` and <!-- terms: ignore -->
      `vault.connect`; the centred card and the phone sheet. <!-- terms: ignore -->

Deck (work/chat)
- [ ] A tool row or send that answers `needs_credential` opens the sheet instead of printing the
      error.

App (work/mobile)
- [ ] Nothing built: the bottom sheet with Paste and Face ID on Connect.

Capsule (work/capsule-pro)
- [ ] Nothing built: the inline row and secure field; "Voice needs a speech key" copies a
      terminal command today (capsule.md), replace it with "Connect Deepgram to talk".

native-core
- [ ] Onboarding's Claude step and Settings, Vault, Connections open this sheet.

vault
- [ ] `vault.need` returns `purpose` in plain words and the provider's key page for Open. <!-- terms: ignore -->

System (app-design)
- [ ] The CredentialSheet board on the canvas: key, file, sign-in, the Capsule row.
