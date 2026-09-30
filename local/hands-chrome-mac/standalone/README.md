# vyre-chrome

Control your own Chrome from Claude Code. It reads a page in one call, fills forms, runs a whole workflow build in one batch, and reads DevTools (DOM, scripts, console, network). It uses the Chrome you already have open, signed in as you. No Vyre server is needed. It is the same code that ships inside Vyre 0.2.

It is built for real GoHighLevel work (see "GoHighLevel" below), but it drives any site that is not on the never-touch list.

## What you need

- macOS (Windows works the same way, see the note at the end), Chrome 116 or newer, Node 22 or newer, Claude Code.

## Install (four steps, about two minutes)

1. Unpack the release anywhere, for example `~/Downloads/vyre-chrome`. Step 2 copies it to a private, read-only folder (`~/.vyre-chrome/app`), so you can delete or move the download afterwards.
2. Register the connector with Chrome:

       node ~/.vyre-chrome/app/standalone/cli.mjs install

   It prints the extension folder and the exact `claude mcp add` line for your machine.
3. In Chrome open `chrome://extensions`, turn on Developer mode (top right), press Load unpacked, and choose the folder step 2 printed (`~/.vyre-chrome/app/extension`). Its id must match the one step 2 printed; the connector only talks to that id.
4. Add it to Claude Code, once (copy the line step 2 printed):

       claude mcp add vyre-chrome -- node ~/.vyre-chrome/app/standalone/cli.mjs mcp

Check it: start Claude Code and ask it to run `chrome_status`. It should say connected. Chrome shows two bars that cannot be hidden: a warning about developer-mode extensions when it starts, and "started debugging this browser" while a tab is being driven.

## Uninstall

    node ~/.vyre-chrome/app/standalone/cli.mjs uninstall            # keeps your logs
    node ~/.vyre-chrome/app/standalone/cli.mjs uninstall --purge    # also deletes them
    claude mcp remove vyre-chrome

Then remove the extension in `chrome://extensions`. Nothing else was installed. `--purge` only deletes `~/.vyre-chrome` when it holds this program's own marker file, and never a link or your home folder. To update, unpack the new release and run its `install` again.

## Who approves what

There is no Gate here. Claude Code's own permissions are the approval.

- Reading, filling and clicking are ordinary tools (`chrome_snapshot`, `chrome_act`, `chrome_fill`, `chrome_batch`, `chrome_ghl`, ...). Allow them in Claude Code if you want it to work without asking.
- An act that sends something as you (a real submit, a message, a post, a payment, a delete) is not done. It comes back `held: true` with an id and the fields it would send. Doing it is a separate tool, `chrome_send`. Never put `chrome_send` in an allow list: it is where you approve. If your Claude Code supports questions from a tool (MCP elicitation) the server itself asks you, showing the site, the button and the field values, and a no sends nothing; otherwise Claude Code's own permission prompt is the approval. It is refused if the page changed since it was held.
- `chrome_resume` (carry on after you pressed Esc) also belongs on "ask", and the server asks you itself before it carries on. `node ~/.vyre-chrome/app/standalone/cli.mjs config confirm-sends off` turns those questions off.
- Esc in Chrome stops everything at once, and it waits until you answer.

Always on, whatever you allow: passwords, cookies, tokens and session ids are masked before Claude sees them; banks, password managers and sign-in pages are never read or touched; a page with a visible password field never runs a script; and a script that runs without you asking cannot send anything to a site the page does not already talk to (it is held and reported). That containment holds for HTTP(S), navigation and new WebSockets (the run in CI shows what a real Chrome does). WebRTC and DNS hints are only blocked in their plain forms: a script that builds an iframe, uses `innerHTML` or `document.write` can get around those two.

## The tools

`chrome_tabs` (list, find, use, open, activate, close, navigate), `chrome_snapshot`, `chrome_act`, `chrome_fill`, `chrome_eval`, `chrome_wait`, `chrome_screenshot`, `chrome_batch`, `chrome_inspect`, `chrome_sources`, `chrome_console`, `chrome_net`, `chrome_api`, `chrome_ghl`, `chrome_state`, `chrome_plan`, `chrome_stop`, `chrome_resume`, `chrome_status`, `chrome_send`. In Vyre they are the same tools with dots (`chrome.snapshot`).

## GoHighLevel

Read `standalone/GHL-PLAYBOOK.md`; Claude Code can read it too. The short version:

1. Have GoHighLevel open in one tab. Tell Claude to reuse it; it never opens a tab per step.
2. `chrome_ghl context`, then `chrome_ghl section` (workflows). Then one `chrome_ghl run` with a `flow` (`create-workflow`, `add-trigger`, `add-action`, `edit-workflow`, `save-workflow`, `publish-workflow`) or your own `steps`. A whole flow is one round trip.
3. Every step waits for GoHighLevel's spinners, drawers and toasts, retries a control that went stale, closes harmless popups (what's new, tours, cookies) and stops on anything else (unsaved changes, confirm, delete) instead of guessing.
4. Saves are verified. A save that cannot be confirmed is an error that names the step, never a silent success.
5. Publishing is held; you approve it with `chrome_send`.

Honest limit: the labels come from GoHighLevel's documentation and have not been checked against a live account. If a label differs, the failure says which control it looked for, lists the closest names on the page, and includes a masked snippet of the page, so the fix is one step. Send the report (below) and it gets fixed for everyone.

If your GoHighLevel is on your own domain, tell it once (install asks, or `node ~/.vyre-chrome/app/standalone/cli.mjs config ghl-host your.domain.com`; add or `--remove` several). `gohighlevel.com` and `leadconnectorhq.com` always count. Nothing a page does can add a domain; only this setting can. On those domains, the builder's own action tiles ("Send Email", "Remove Tag") and an action editor's Confirm are not held as sends, and typed workflow text is kept in the trace.

## Logs

Every session writes one trace file, `~/.vyre-chrome/logs/session-<time>-<pid>.jsonl`, on this computer only. Nothing is ever sent anywhere. Each tool call records its arguments (masked), how long it queued, ran and waited on the page, whether it worked, the error and the step that failed, retries, which selector strategy matched and whether a fallback was needed, the page's host and path (no query), the tab, and whether a tab was opened. A failure adds a small masked snippet of the page. Secrets, passwords, tokens and cookies are always masked; card numbers, national ids, emails and phone numbers are masked; on GoHighLevel automation and workflow-builder pages the text you type stays readable, and on any other site a typed value is logged only as its length (`logs values all` keeps them, `logs values none` drops them everywhere). Field names always stay. Old logs are removed to stay under 100 MB.

    node ~/.vyre-chrome/app/standalone/cli.mjs report --last 5     # one masked bundle plus a summary
    node ~/.vyre-chrome/app/standalone/cli.mjs logs off            # stop logging (on turns it back on)
    node ~/.vyre-chrome/app/standalone/cli.mjs logs shots on       # also keep a small screenshot of each failure (off by default)
    node ~/.vyre-chrome/app/standalone/cli.mjs logs values builder|all|none   # which typed values are kept
    node ~/.vyre-chrome/app/standalone/cli.mjs logs path

The report prints the slowest steps, failures by kind and the fallback rate, and writes the bundle to `~/.vyre-chrome/reports/`.

## Limits

- One Claude Code session drives Chrome at a time. A second one says so instead of failing quietly.
- The connector name is shared with the Vyre app: installing one replaces the other's registration in Chrome.
- Only the main page and open shadow DOM are reachable; cross-origin iframes are not.
- Windows: `install` writes the registry key; the same four steps apply. Linux is untested outside CI.
