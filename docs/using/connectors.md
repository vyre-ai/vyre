---
title: Connectors
summary: Connect MCP servers and Google accounts to Vyre, with credentials from the vault and every send held for your approval, and use them from any Claude session through one entry.
audience: users, builders
owner: connectors
status: stable
---

# Connectors

A connector is how a Claude session reaches something outside itself: a tracker, a CRM, a docs
tool, your calendar or your mail. Vyre connects these:

- **MCP servers**, which Vyre runs for you behind one entry.
- **Google accounts**, for Calendar and Gmail.
- **Apps from the catalog**, which run on their vendor's own hosted server: `vyre connect apps`.
- **GitHub accounts**, so a session can clone your repos and commit as you.
- **Your own Chrome**, through Vyre Computer, on a Mac.

The first three keep the same promises. A connection names [vault](vault.md) items and never
holds a value. Anything that goes out as you waits at the Gate until you approve it.

You manage MCP servers, Google accounts and GitHub accounts in the Vyre app, under Settings,
Connections (`/u/connections`). MCP servers, Google accounts and catalog apps also work from the terminal with
`vyre connect`. See the [CLI reference](../reference/cli.md) for every flag.

## Add an MCP server

Put the server's credential in the vault first. Values are never typed on the command line:

```
vyre vault put tracker-token --kind api-key
```

Then add the server, naming the item. For a server that runs on this machine (stdio):

```
vyre connect add mcp tracker --env TRACKER_TOKEN=tracker-token -- npx -y @northwind/tracker-mcp
```

For a server on the web (streamable HTTP, or SSE with `--sse`):

```
vyre connect add mcp docs --url https://docs.example.com/mcp --auth bearer --item docs-api
```

After the add, Vyre asks the vault to let the `mcp` module use each item. That grant needs you
to be present. Then it tries the server and prints how many tools it has. In the Vyre app, **Add MCP
server** does the same and asks you to prove you are there for the grant.

What else you can set:

- `--project` and `--agent`, repeatable, to limit which projects and agents see the server. The
  default is every project and every agent.
- `--var VAR=value` for a plain setting a stdio server needs. Vyre refuses one that looks like a
  credential; put that in the vault and use `--env` instead.
- `--header Name:Value` for a header that is not a secret.

Plain `http://` is allowed only to this machine, your tailnet, or an origin you list under
`mcp.httpHosts` in `config.json`. Everything else needs `https://`.

A server starts on its first use, not at boot. It stops after 10 minutes idle. A server that
crashes three times in five minutes stays stopped until you restart it (**Restart** in the Vyre app).

`vyre connect list` shows every connection. `vyre connect test mcp tracker` tries one now.
`vyre connect remove mcp tracker` disconnects it and leaves its vault items where they are.

## Hold and approve a send

The hub reads each tool's name. A tool is a read when its name is plainly a read (`list`, `get`,
`search`, `read` and the like) with no word that writes, sends or deletes. Everything else is
outward, and an unknown tool counts as outward.

- A read runs and returns the server's answer.
- An outward call is held at the Gate. Claude gets back the held item and a sentence that says
  so, and the tool's description starts with "(held for approval)", so Claude expects to wait.
  Nothing reaches the server until you approve it, and then it runs with exactly the arguments
  you approved, edits included.

You can change a tool's mode after **Test** in the Vyre app: **Read**, **Held** or **Off** (hidden).
A tool whose name sends (`send`, `post`, `reply`, `forward`, `publish`, `share`, `invite`,
`tweet`, `dm`, `comment`) is always held. It can be Held or Off, never Read.

## Use Vyre's tools in a plain claude

Every session Vyre starts already loads Vyre's MCP server, `vyre`. It offers the tools of every
running module and every hub tool you may use, as `<server>__<tool>` (for example
`tracker__list_issues`). No server needs its own line in a Claude config.

For a `claude` you start yourself, outside Vyre, install the Vyre plugin. It brings the `vyre`
server with Vyre's hooks, skills and `/vyre` command. See [Vyre in Claude Code](claude-code.md).

To add only the MCP server, without the plugin:

```
vyre mcp install
```

It prints the one line that registers Vyre with Claude Code,
`claude mcp add -s user vyre -- vyre mcp`, and runs it only with `--yes`. Vyre never edits a
Claude config on its own.

## Connect an app from the catalog

Most apps you would want to connect already run their own hosted MCP server. Vyre keeps a catalog of
them, so connecting one is a sign-in, not a setup. Nothing passes through a Vyre server: your box signs
in to the vendor directly, and the credential is a [vault](vault.md) item that only that vendor's own
address can receive.

```
vyre connect apps            # the catalog, and what each one asks of you
vyre connect add app ghl     # GoHighLevel: opens the sign-in address, then lists its tools
vyre connect add app notion --label work   # a second account of the same app
```

There are three ways an app signs in, and Vyre picks the one the vendor offers:

- **Sign in.** The vendor lets an app register itself. You open the address Vyre prints, approve, and
  it is done. On a browser that is not on the box, paste the address the browser lands on back into the
  terminal, or into the Vyre app's Connections screen.
- **Your own app.** The vendor wants you to make an OAuth app in your own account first (Asana,
  HubSpot, Google Workspace). `vyre connect apps` says so, and `vyre connect add app <id>` prints the
  steps and the redirect address to enter. Put the app's client ID and secret in a vault item, then
  run `vyre connect add app <id> --client <item>`.
- **A token.** Some apps also take a personal token or API key (monday.com prefers it). You type it at
  a hidden prompt; it goes straight into the vault and is never shown again.

A `#Slack` in your own message lets that conversation (and the ones it started) use that connection even when it is limited to certain projects. That lasts until Vyre restarts.

Each connection to an app that has a hosted server is a hub server, so what you read above applies: reads run, and anything that sends or
changes something waits at the Gate. `vyre connect remove <name>` disconnects it and leaves the vault
item where it is. A vendor that was checked and cannot be connected by a person (Slack, Dropbox, Figma
and a few more) is listed by `vyre connect apps --all` with the reason, not hidden.

Some apps have no hosted server an individual can use, or none that takes a person's own login
(Microsoft mail and calendar, personal Gmail, Slack's Web API). Those connect as a **vault
credential** instead: Vyre walks you through making a small app in your own account, signs in, and
stores the result in the vault. Your agent then calls the vendor's API through `vault.request`, which
adds the sign-in, runs reads at once, and holds anything that sends or changes something at the Gate
(unless you asked for that exact thing). `vyre connect apps` marks these.

Slack, Zoom, Microsoft and Google each print a numbered guide with the links and the exact settings.
For Slack the link fills in a private app's settings for you. When a vendor requires an https redirect
(Slack) or `localhost` (Microsoft), your browser ends on a page that cannot load: copy the full
address from the browser bar and paste it into the terminal.

For Google, publish the app you make (its status is In production) or Google ends the sign-in every
7 days; the app stays unverified, which for one person only means a warning screen to click through.

GoHighLevel signs in once for every sub-account you approve. Use the generic `services.leadconnectorhq.com/mcp/`
address that Vyre uses; HighLevel's Claude-only address refuses any other app.

## Connect Google Calendar and Gmail

In the Vyre app, open Settings, Connections, and press **Add Google account**. Give the account a
name (like `work`) and its address, pick how it signs in, and pick the vault item that holds the
credential. **Add account** adds it, asks for your passkey to let the `google` module use the
item, then checks each scope with Google. There are two ways to sign in.

**OAuth.** The vault item is an env-set with `client_id`, `client_secret`, `refresh_token` and
`token_uri`:

```
vyre vault put home-google --kind env-set --field client_id --field client_secret --field refresh_token --field token_uri
vyre connect add google home --email alex@example.com --item home-google
```

**Service account.** For a Google Workspace domain, a service account can act as a person
through domain-wide delegation. Store its JSON key as a `note` or `secret` vault item, then add the account with the
address it acts as:

```
vyre connect add google work --email alex@juniperstudio.example --item juniper-google-sa --dwd
```

**Test** asks Google for each scope and lists which were refused. For a service account, the
message names the scopes to allow for its client ID in the Google Workspace admin console, under
Security, API controls, Domain-wide delegation.

To sign in with a browser instead, run `vyre connect add google home --sign-in`. It opens
Google's consent page, finds the address itself and puts the refresh token in the vault. It uses
the OAuth client in the vault item `google-oauth-client` unless you name another with `--client`.
In the Vyre app, **Add Google account** offers **Sign in with Google** first; it opens Google's consent
page in a new tab, and on a browser on another device you paste the address it lands on.

What Vyre does with the account:

- Reads your calendar and mail on demand, with the narrowest scope each call needs. Nothing
  polls or syncs in the background.
- `google.mail.send` is always held at the Gate. So is an event with attendees, since Calendar
  mails each of them an invite. A draft and an event with no attendees are written directly.
- Each account is its own sender at the Gate, so you see which address a message would leave
  from.

## Connect GitHub

A connected GitHub account lets Vyre clone your repos for a project, give each session its own
branch in its own worktree, and open and read pull requests. Open Settings, Connections, **Add a
GitHub account**, give it a name such as `work`, and choose how to sign in:

- **Sign in with GitHub.** Vyre shows a short code and opens GitHub's own device page; type the
  code there. Vyre waits until you finish, and the code lasts 15 minutes. This runs GitHub's own
  command line tool, `gh`, so `gh` must be installed on the machine Vyre runs on. It asks GitHub
  for the `repo` scope: full read and write on every repo the account can reach, because GitHub's
  device sign-in offers nothing narrower.
- **Paste a token instead.** Paste a personal access token into the field in the form. Vyre checks
  it with GitHub before it saves anything, and tells you how many repos it reaches. A fine-grained
  token can reach fewer repos than the sign-in, and this path needs no `gh`. Type the token in the
  app's field, never into a chat message.

The token is stored as a [vault](vault.md) item named `github-<name>` and is never shown again.
Disconnecting removes that item and the account. It does not revoke the token at GitHub, so
remove it at github.com/settings/applications if you want it gone entirely.

**A new repo for a folder.** Ask for a repo for a site or a project folder and Vyre makes it under
your account, or under an organisation you belong to, private unless you say public, and sends the
folder there as its first commit. It asks for your yes first, because it creates something on
GitHub. Files that look like secrets (an `.env`, a private key) are left out, and a folder with a
token inside is stopped before anything is made on GitHub, with the file and line named.

Commits a session makes carry your identity: your GitHub name, and your public GitHub email or,
without one, GitHub's `<id>+<login>@users.noreply.github.com` address. Each commit also ends with a
`Vyre-Session: <id>` line, so you can see which session wrote what. This is an audit aid, not a
lock: a session can change its own git settings.

## Your own Chrome

Vyre Computer lets Claude work in the Chrome you already have open, signed in as you, on a
Mac. It reads a page in one call, fills forms, clicks, and reads the page's DevTools. It works in
Chrome, Brave, Edge, Chromium, Arc and Dia. Vyre sets up the connector for you (`chrome.install`
registers it with each browser it finds), and then you load the extension in `chrome://extensions`
with Developer mode on. Click its toolbar icon to see whether it is connected.

- **You approve what sends.** A real submit, message, post, payment or delete comes back held,
  with the fields it would send. Nothing goes until you approve it, and a page that changed since
  it was held is refused. Esc in Chrome stops everything at once.
- **Passwords stay out.** Passwords, cookies, tokens and session ids are masked before Claude sees
  them. Banks, password managers and sign-in pages are never read or touched, and a page with a
  visible password field never runs a script.
- **The script guard.** A script Claude runs in a page (`chrome.eval`) may read with your login but
  not write with it, and may not read the page's stored login. Vyre blocks what it can see a script
  send to a site the page does not already use: that request is held and reported, for HTTP and
  HTTPS requests, navigation, WebSockets and beacons, in every frame of the tab. It closes a worker
  it made once the call returns.
- **What is not blocked.** WebRTC connections and DNS hints (`dns-prefetch`, `preconnect`) are
  refused only in their plain forms. A script that builds an iframe, or writes with `innerHTML` or
  `document.write`, can get around those two. A script that builds code from text, or starts a
  worker some other way, cannot be held. Only the main page and open shadow DOM are reachable, so
  cross-origin iframes are not.
- **Site learning is on by default.** Vyre Computer remembers each site's layout, how to find
  its buttons, how to tell the page is ready or that you must sign in, and the flows that worked,
  so the next visit is faster. It keeps structure only, never what you typed, cookies or tokens.
  See and forget any of it in the Vyre app under Memory, Sites; each forget can be undone for a day.
  Turn it off with **Learn how each website works** in Settings.

A separate package, `vyre-chrome`, runs the same code without a Vyre server: `vyre-chrome
install`, then add it to Claude Code with `claude mcp add`. It writes a trace of each session to
`~/.vyre-chrome/logs` on your computer only. Its README in `local/hands-chrome-mac/standalone/`
has the steps.

## A website you are signed in to

Some sites have no API for you: LinkedIn, a practice-management page, a portal. Vyre can learn what
the site's own page asks of its servers, name it, and call it by name afterwards, as you, without
driving the page each time. `chrome_op` in Claude Code (or your assistant) does the teaching:

1. Say what you want from the site and with which inputs: `readProfile(slug) -> name, headline,
   location`. Your assistant says it back and waits for your yes.
2. It runs the page twice with two different examples and compares the traffic. No model reads the
   traffic. Then it proves the operation on an input that was not an example before it keeps it.
3. A send (a message, a connection request) is taught with its request **blocked**, after your yes:
   nothing is sent while Vyre learns it. Every later call of it waits for your yes and is made once.

Your login never leaves the browser. A call is signed inside the page, by the browser that is
signed in; Vyre keeps names, shapes and the places a token comes from, never the token, a cookie or
what you typed. When the site changes, a read is repaired once from the page and kept only after a
replay answers; each kept version can be rolled back in one step.

Then make the site a Connection: `connectors.site.connect` (your own act). A Flow's "Call a
service" step, a watcher's poll, a view and your assistant call its operations like any
Connection's, and anything that is not a read is held for your yes. Where a call runs is the
cheapest way that works, and the trace says which: a plain fetch for public data, your Chrome on
this Mac, an assistant's own Chrome on your box (so it works with the Mac off; sign in once through
its screen view), or your Chrome on a paired Mac that you allowed with `link.ops.allow`. If the
browser says the login ran out, the Connection's light says to sign in again.

**LinkedIn.** A kit for it exists (`chrome_op kit`), but automating LinkedIn is against LinkedIn's
terms and can get an account restricted or closed. Use it only on an account you can afford to
lose, and at your own risk; Vyre does not recommend it. If you do, the strict pace is on by default:
a read every 20 to 60 seconds, 2 to 5 minutes between sends, 80 reads and 15 sends a day, never at
night, and **the first security check stops the account** until you clear it in the browser and
resume it (`connectors.site.resume`). Every one of those numbers is a setting for your account
(`connectors.site.limits.set`).

It does not solve CAPTCHAs, and a site that challenges your browser needs you once. Respect each
site's terms: you are responsible for what you ask it to do.

## Send an email from any account

Every mail account you connect works the same way: a Google account (OAuth or a Workspace
service account), an MCP server that reads and sends mail, your own Google Apps Script web app,
or any mailbox over IMAP and SMTP. You can connect several at once, and several of one kind. Each
one is a connection in Vault, Connections, where you choose which surfaces may use it: the
Lumen and chats by default, agents only when you turn them on.

In Lumen, type **send an email**. You get one row per account you may send from, such as
"Send from alex@juniper.example". Words you add are filled in: "email dana@northwind-bakery.example
about the order" sets the address and the subject, "write to dana saying the rota is ready" finds
Dana's address in your mail and sets the body. Press Return on a row and the message waits at the
Gate, where you finish it and approve it with Touch ID. "email from dana" lists messages across
your accounts instead.

A chat or an agent uses the same three tools: `mail.accounts` lists the accounts it may use,
`mail.search` and `mail.read` read, and `mail.send` is always held at the Gate. With more than one
account it has to say which; it never picks one for you.

**IMAP and SMTP.** In Vault, Connections, pick **Email (IMAP and SMTP)** and fill in the servers,
the ports, your username, the password (often an app password), and TLS or STARTTLS. Vyre never
connects without TLS. Grant the connection to `mail`.

**Apps Script.** For a Gmail account where you cannot add an OAuth client, paste
`core/mail/apps-script.gs` into a new project at script.google.com, set the script property
`vyre_token` to a long random value, and deploy it as a web app that runs as you with access for
Anyone. Put the `/exec` address and the token in Vault, Connections as **Google Apps Script web
app**. The token travels in the request body, never in the address.

**An MCP mail server.** Add the server as in [Add an MCP server](#add-an-mcp-server). Vyre reads
its tools and guesses which one sends, searches and reads. The `mail.map` tool shows the guess,
and you can correct it with the same tool. Its sends are held even if you marked the
tool as a read.

## What it never does

- A connection never holds a value. `mcp.add` refuses a header, env value, argument or url that
  looks like a credential. Tokens are fetched from the vault at call time and scrubbed from every
  result and error.
- A model never adds, changes or removes a server or an account, and never widens a scope.
  Those are for you, in the Vyre app or the terminal.
- A tool that sends is never run without your approval.
- Vyre's own MCP server is never a hub server: it refuses to run inside the hub.

Sessions Vyre starts still load your own Claude Code settings, so MCP servers you configured in
Claude Code are there too. Vyre does not manage those: their credentials and their sends are
outside the vault and the Gate.

## Next

- [Tools reference](../reference/tools.md): every `mcp.*`, `google.*` and `mail.*` tool.
- [CLI reference](../reference/cli.md): `vyre connect` and `vyre mcp`.
- [Vyre in Claude Code](claude-code.md): the plugin for a `claude` you start yourself.
- [The MCP hub](../build/mcp-hub.md), for builders.
- [The vault](vault.md): items, grants and presence.
