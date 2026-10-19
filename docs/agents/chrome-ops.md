---
title: A site's own API through the person's Chrome
summary: How to read or change data on a site that has no connector, by calling the site's own API from the logged-in browser.
audience: agents
owner: docs
status: stable
tokens: 700
when: You need data from a site or an action in it and there is no connector, or you are about to click through a page by hand.
---

# A site's own API through the person's Chrome

When a site has no connector, call its own API through the logged-in browser before you click by hand. The login stays in the browser; no credential reaches you, and values that look like credentials are masked in what you read.

## Pick the lightest way

1. A connector, if there is one (see `connections.md`).
2. `chrome.api` with `action: "route"` for a read. Give a `hint` (what the data is about, in a few words). The reply says `route: "api"` with the data, or `route: "ui"` with why; on `ui`, drive the page.
3. `chrome.op` for a named operation that has been learned on the site, such as `ghl.listContacts`. `action: "list"` shows what is kept; `action: "call"` runs one with its inputs.
4. The page controls (`chrome.snapshot`, `chrome.act`, `chrome.fill`) when nothing above fits.

## Learning an API

- `chrome.net` with `action: "start"` captures the page's traffic; `list` and `get` read it, with headers and bodies masked.
- `chrome.api` with `action: "learn"` reduces captured requests to a catalog; `catalog` reads it; `call` invokes one entry from inside the page, so its own cookies sign it.
- `chrome.op` teaches an operation: `scout` shows the page's requests, `learn` runs the trigger twice with two different example inputs and diffs the traffic into a draft, `save` keeps it. A read must first answer on an input that was not an example. `heal` and `check` keep it working. `rollback` and `forget` are the person's.
- Prefer `chrome.api` `call` over a fetch in `chrome.eval`, which cannot write and cannot read the stored login.

## Before you start

Post a short plan with `chrome.plan` before your first action, so the person can see it and stop you. A step the person must approve comes back with an id (see `outward-acts.md`). Some sites watch their accounts, and LinkedIn is one: use them at a person's pace, within the daily limits.

## Whose browser

The browser is your own computer's, or the person's Chrome when they connected it. `chrome.site` shows what has been learned about a site on this device.
