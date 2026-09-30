---
title: Connectors
summary: Connect MCP servers and Google accounts to Vyre, with credentials from the vault and every send held for your approval, and use them from any Claude session through one entry.
audience: users, builders
owner: connectors
status: stable
---

# Connectors

A connector is how a Claude session reaches something outside itself: a tracker, a CRM, a docs
tool, your calendar or your mail. Vyre connects two kinds:

- **MCP servers**, run by the MCP hub (the `mcp` module) behind Vyre.
- **Google accounts**, for Calendar and Gmail, handled natively by the `google` module.

Both keep the same promises. A connection names [vault](vault.md) items and never holds a value.
Anything that goes out as you waits at the Gate until you approve it.

You manage both in the Deck, under Settings, Connections, or from the terminal with
`vyre connect`. See the [CLI reference](../reference/cli.md) for every flag.

## Add an MCP server

![Settings, Connections: the harlow-docs MCP server with its tools and the projects it serves, and Harlow Legal's Google account, each with Test and Remove, and the buttons to add more.](shots/settings-connections.png)

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
to be present. Then it tries the server and prints how many tools it has. In the Deck, **Add MCP
server** does the same and asks for your passkey for the grant.

What else you can set:

- `--project` and `--agent`, repeatable, to limit which projects and agents see the server. The
  default is every project and every agent.
- `--var VAR=value` for a plain setting a stdio server needs. Vyre refuses one that looks like a
  credential; put that in the vault and use `--env` instead.
- `--header Name:Value` for a header that is not a secret.

Plain `http://` is allowed only to this machine, your tailnet, or an origin you list under
`mcp.httpHosts` in `config.json`. Everything else needs `https://`.

A server starts on its first use, not at boot. It stops after 10 minutes idle. A server that
crashes three times in five minutes stays stopped until you restart it (**Restart** in the Deck).

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

You can change a tool's mode after **Test** in the Deck: **Read**, **Held** or **Off** (hidden).
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

## Connect Google Calendar and Gmail

In the Deck, open Settings, Connections, and press **Add Google account**. Give the account a
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
vyre connect add google work --email alex@harlowlegal.com --item harlow-google-sa --dwd
```

**Test** asks Google for each scope and lists which were refused. For a service account, the
message names the scopes to allow for its client ID in the Google Workspace admin console, under
Security, API controls, Domain-wide delegation.

To sign in with a browser instead, run `vyre connect add google home --sign-in`. It opens
Google's consent page, finds the address itself and puts the refresh token in the vault. It uses
the OAuth client in the vault item `google-oauth-client` unless you name another with `--client`.
A **Sign in with Google** button in the Deck is coming next.

What Vyre does with the account:

- Reads your calendar and mail on demand, with the narrowest scope each call needs. Nothing
  polls or syncs in the background.
- `google.mail.send` is always held at the Gate. So is an event with attendees, since Calendar
  mails each of them an invite. A draft and an event with no attendees are written directly.
- Each account is its own sender at the Gate, so you see which address a message would leave
  from.

## Send an email from any account

Every mail account you connect works the same way: a Google account (OAuth or a Workspace
service account), an MCP server that reads and sends mail, your own Google Apps Script web app,
or any mailbox over IMAP and SMTP. You can connect several at once, and several of one kind. Each
one is a connection in Vault, Connections, where you choose which surfaces may use it: the
Lumen and chats by default, agents only when you turn them on.

In Lumen, type **send an email**. You get one row per account you may send from, such as
"Send from alex@harlow.example". Words you add are filled in: "email dana@northwind-bakery.example
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
  Those are for you, in the Deck or the terminal.
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
