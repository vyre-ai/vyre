# ADR 0016 · Connectors: the MCP hub and native accounts

Status: proposed, 27 Sep 2026 · Workstream: connectors · Code: `core/connectors/`, `core/mcp/`,
`core/google/`, `core/cli/commands/connect.js`, `deck/views/connections.js`

## The problem

The assistant and the Capsule need the person's calendar and mail, and the person wants to plug
in many MCP servers (a tracker, a CRM, a docs tool) with tokens and service accounts they
already have. Claude Code can load MCP servers, but each one is a line in a config file, often
with its token in the same file or in an env var that every tool call in that session can read.
That breaks floor rule 8 (no vault value on any screen, log or model) and rules 1 and 2 (nothing
goes out unseen), and it does not scale past a handful of servers per session.

## Decision

### 1. Three modules and one shared library

| Module | Folder | What it does |
|---|---|---|
| `mcp` | `core/mcp/` | The hub: any number of MCP servers, their credentials, scoping, lifecycle, and one aggregated tool list. |
| `google` | `core/google/` | Native Google Calendar and Gmail, over REST, with OAuth or a domain-wide-delegation service account. |
| (library) | `core/connectors/` | Credential minting and scrubbing shared by both: bearer tokens, OAuth refresh, service-account JWTs, an in-memory token cache. Fakes for tests live in `core/connectors/testing/`. |

Microsoft 365 is a later `microsoft` module on the same library and the same tool shapes.

`mcp` and `google` both `require` `vault` and `gate`. They register as Gate senders at start, so a
held item survives a restart of vyred and can still be approved.

### 2. Credentials: vault items, minted at call time, never on disk

A connection names a vault item and says how to use it. Nothing secret is stored in the
module's tables or any config file; the table holds the item's name.

| `auth.type` | Vault item | Used as |
|---|---|---|
| `none` | none | nothing |
| `bearer` | `api-key` or `secret` | `authorization: Bearer <value>`, or another `header` with a `format` like `"token {value}"` |
| `env` | `api-key`, `secret` or `env-set` | stdio only: env vars for the server's own process, `{ "GITHUB_TOKEN": "gh-token" }` or a field of an env-set |
| `oauth` | `env-set` with `client_id`, `client_secret`, `refresh_token`, `token_uri` | an access token minted by refresh, cached in memory until a minute before expiry, refreshed once on a 401 |
| `service-account` | `note` or `secret` whose value is the Google service-account JSON | an RS256 JWT with `sub` set to the impersonated user, exchanged at the key's `token_uri`; scopes per call |

Rules, and why:

- Values come from `ctx.vault.fetch` (manifest `needs.vault: ["per-connection"]`), so each item
  still needs `vyre vault grant <item> mcp` (or `google`). `vyre connect add` asks for the grant
  itself, with presence, so a person does it once.
- Access tokens live only in process memory. A restart mints new ones. The refresh token and the
  private key are fetched per mint and dropped.
- For an HTTP server the header is built per request. For a stdio server the env is built at
  spawn and given to that child only: never to Claude, never written to a file. A stdio server is
  a program the person chose to run with that token, which is the same trust as today.
- Every result and error that leaves the hub or the connector is scrubbed of every value it
  used (the Gate's scrub: raw, base64, base64url and URL-encoded forms).
- stderr of a stdio server is kept as a bounded ring for `mcp.test`, scrubbed, never logged raw.

### 3. The hub

Tools (callers in brackets; "people" means cli, local, deck, capsule and modules, never mcp):

| Tool | Callers | Input | Returns |
|---|---|---|---|
| `mcp.servers` | all | `{}` | `[{name, transport, state, tools, error?, lastUsed, auth: {type, item?}, scope}]`, never a value |
| `mcp.add` | people | `{name, transport: "stdio"\|"http"\|"sse", command?, args?, cwd?, env?, url?, headers?, auth?, scope?, tools?, idle?}` | the server as `mcp.servers` shows it |
| `mcp.update` | people | `{name, ...any field of add}` | same |
| `mcp.remove` | people | `{name}` | `{removed}` |
| `mcp.test` | people | `{name}` | `{ok, tools, ms, error?, stderr?}`: starts it, lists tools, caches them |
| `mcp.restart` | people | `{name}` | `{state}` |
| `mcp.tools` | all | `{}` | the tools the verified caller may see: `[{name: "<server>__<tool>", server, tool, description, input, outward}]` |
| `mcp.call` | all | `{server, tool, arguments?}` | the server's result, scrubbed; or `{held: id}` when it went to the Gate |
| `mcp.release` | internal, gate only | `{id, to, content}` | runs an approved call |

Names: a server name is `[a-z][a-z0-9-]{0,31}`. An aggregated tool is `<server>__<tool>`, with
the server's tool name reduced to `[A-Za-z0-9_-]`, so Claude Code shows it as
`mcp__vyre__<server>__<tool>` and no hub name can collide with a Vyre module tool (those use one
underscore).

Scope. Each server has `scope: { projects: "*" | [ids], agents: "*" | [names] }` (default both
`"*"`) and `tools: { allow?: [], deny?: [], mode?: { "<tool>": "read" | "write" | "off" } }`.
`mcp.tools` and `mcp.call` use only what vyred verified: the agent from its key, the thread from
the session key, and the thread's project from the Switchboard. An agent sees a server when its
name is in `agents` (or `"*"`) and, if `projects` is a list, one of its projects is in it. A
person's session sees a server when `projects` is `"*"` or the thread's project is in the list.
People's own callers (cli, deck) see everything, for managing it.

Lifecycle. Nothing starts at boot. A server starts on its first call or `mcp.test`, and its tool
list is cached in the store, so listing tools for a new session never spawns anything. A running
server stops after `idle` ms without a call (default 10 minutes), on one `setTimeout` per
running server, never a poll. A crash marks it `failed` with the last scrubbed stderr line; the
next call restarts it, at most three times in five minutes, then it stays failed until
`mcp.restart`. State is `stopped | starting | running | failed`.

Transports, all in `core/mcp/client.js`, no dependencies: stdio (newline-delimited JSON-RPC),
streamable HTTP (POST with JSON or an SSE reply, `Mcp-Session-Id` kept), and legacy SSE (GET the
stream, POST to the `endpoint` it names). Redirects are refused for HTTP servers, as the Gate
does, so a credential never follows one to another host.

### 4. What goes through the Gate

Anything a server's tool does to the world outside is held, unless it is plainly a read.

- A tool is a **read** when its own name starts with or contains a read verb (`list`, `get`,
  `search`, `read`, `find`, `fetch`, `query`, `describe`, `lookup`, `view`, `show`) and no send,
  write or delete word, or when its annotations say `readOnlyHint: true` and its name has no
  send, write or delete word. Everything else is **outward**. Unknown means outward.
- The person can set a tool's mode in `tools.mode`: `read`, `write` (held) or `off` (hidden).
  A tool whose name has a send word can be `write` or `off`, never `read`.
- An outward call becomes `gate.request { kind, via: "mcp:<server>", to, content: { tool,
  arguments } }`. `kind` is `delete` for delete-like names, `spend` for pay-like names, `send`
  otherwise. `to` is the first of the argument's `to`, `channel`, `recipient`, `email`,
  `address`, `url`, else the server name. The model gets `{ held: id, message }`.
- On approval the Gate calls `mcp.release` with exactly the approved content, as `module:gate`.

The Gate change that makes this possible is small and generic: `gate.offer { name, tool, kinds,
content }` (internal, modules only) registers a sender whose `name` starts with the calling
module's name and whose `tool` is that module's own internal tool. Sending calls
`ctx.call(tool, { id, to, content })`. Registrations are in memory; modules offer again at start.

The harness Rules ask about any MCP tool with a send word in its name (rule 1), and `gate.route`
denies them to agents. The hub's tools already go through the Gate, so both step aside for
`mcp__vyre__<server>__<tool>`: the hub's classification is stricter than the name rule (unknown
is outward), so nothing that the rule would have asked about goes out unheld.

That stepping aside is sound only while one invariant holds: every hub tool with a send word
(`send`, `post`, `reply`, `forward`, `publish`, `share`, `invite`, `tweet`, `dm`, `comment`, in
its own name or in the aggregated name the floor sees) is held at the Gate, whatever the person's
mode or the server's annotations say, and `mcp.add` and `mcp.update` refuse `read` for one. And
Vyre's own MCP server is never a hub server: `vyre mcp`, `harness/mcp/server.js` and `VYRE_`
variables are refused at add, and every stdio child gets `VYRE_HUB_CHILD=1`, under which the
server answers every request with an error and never reaches vyred.

### 5. One MCP entry for every session

`harness/mcp/server.js` (the `vyre` MCP server every Vyre thread already loads) adds
`mcp.tools` to its listing and routes `<server>__<tool>` calls to `mcp.call`, with the session
key, so scope follows the session. `vyre mcp` runs the same server on stdio, for plain `claude`:
`claude mcp add -s user vyre -- vyre mcp` is printed by `vyre mcp install`, which runs it only
when the person asks. Vyre never edits the global Claude Code config on its own.

### 6. Google, native

Accounts: `google.accounts`, `google.add {name, email, auth: {type: "oauth" | "service-account",
item, subject?}}`, `google.remove`, `google.test`. A DWD service account acts as `subject`; OAuth
acts as whoever consented.

| Tool | What | Gate |
|---|---|---|
| `google.calendar.next` | the next events across accounts | read |
| `google.calendar.list` | events between two times | read |
| `google.calendar.search` | events matching words | read |
| `google.calendar.create` / `.update` | an event | held when it has attendees (an invite goes out), direct otherwise |
| `google.mail.search` | messages matching a Gmail query | read |
| `google.mail.read` | one message or thread, as text | read |
| `google.mail.draft` | a Gmail draft | direct: a draft goes nowhere |
| `google.mail.send` | an email | always held |
| `google.find` | the Capsule's results provider: "what's next", "email from dana" | read |
| `google.release` | internal, gate only | runs an approved send or invite |

Scopes are the narrowest per call: `calendar.readonly` and `gmail.readonly` for reads,
`calendar.events` for writes, `gmail.compose` for drafts, `gmail.send` for sends. A DWD client
must be allowed those scopes in the Workspace admin console; `google.test` names any that are
refused.

Sign-in. `google.connect {name, client}` (people only) runs Google's installed-app flow: the
person keeps an OAuth client (`client_id`, `client_secret`, optionally `auth_uri` and
`token_uri`, both https) as a vault env-set granted to google, and Vyre returns the consent
address, with PKCE S256 and a random state, redirecting to a loopback listener on 127.0.0.1 port
0. The listener exists only while a sign-in is open; each sign-in expires after 10 minutes on its
own timer, and its state works once, compared in constant time. A browser on another device
cannot reach that loopback, so `google.connect.finish {id, url}` takes the address it landed on,
pasted. Finishing exchanges the code, reads the address from the id_token, and puts the refresh
token in a new env-set `google-<name>` that the module makes and grants to itself (vault.put lets
a module do that, for items it made); then the account is added as `google.add` does, with
`google.connected {id, name, email}`, or `google.connect-failed {id, error}`. No value reaches a
result, an event or a log. With no refresh token (a client allowed before), the error says to
remove Vyre's access at myaccount.google.com/permissions and sign in again.

Domain-wide delegation helper. For a service account, `google.test` also returns the key's
`client_id`, a public number, and `admin_scopes`, the five scope URLs comma-separated, which are
exactly what the Workspace admin console asks for under Security, API controls, Domain-wide
delegation. No other field of the key is returned.

Capsule: `shows.capsule` lists `results:google.find` and actions on its rows (open, reply as a
draft). Deck: Settings, Connections (`deck/views/connections.js`).

### 7. CLI

`vyre connect add|list|remove|test` covers both: `vyre connect add mcp <name> -- <command>`,
`vyre connect add mcp <name> --url <url> [--sse]`, `--auth bearer|env|oauth|service-account
--item <vault item>`, and `vyre connect add google <name> --email <user> --item <item>
[--dwd]`. After adding, it asks for the vault grant (presence) and runs the test.

## Consequences

- Many servers cost nothing until used: one row each, and one child process only while in use.
- A model never sees a token, a refresh token, a private key or a server's env.
- A server's tool that the hub cannot classify is held. That is the safe mistake; the person can
  mark it `read` once.
- The Gate learns one generic sender kind instead of one type per integration.
- The first refresh token comes from "Sign in with Google" (decision 6); the person still
  brings their own OAuth client, since Vyre ships no client secret.

## Rejected

- **Writing each server into Claude Code's `.mcp.json`.** Tokens in files and env, no scoping,
  no Gate, and every session starts every server.
- **Starting every server at boot.** Breaks principle 8 for people with twenty servers.
- **Passing a token from one module to another** (a shared `connect.token` tool). Each module
  fetches its own items under its own grants, through the shared library.
