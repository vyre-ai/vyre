# The agent docs set: outline (0.3.1, R031-00l)

Status: outline for review, 9 Oct 2026. Written from the product owner's ruling "Agent tokens and native agents" (the 0.3 decisions file) and the architecture map (docs/architecture/map.md). Nothing here is built yet. Task C4 in team/0.3.1/PLAN-waves.md builds it.

## 1. What this is for

The product owner's ruling: the docs split in two, one set for humans and one for agents. The agent set holds what an agent needs about the architecture and about the environment it works in, so that an agent working through Vyre is "native": it knows where it is, what it may do, what it must not do and the cheapest way to do the thing, without reading human prose or exploring the tree. Humans are not offered the agent set. The code is open source, so this is "not shown to people", not secret.

The agent set is also half of the token plan. The always-loaded tool core is capped at about 30 tools and about 6k tokens, and the `docs` tool and the `vyre.core` index tool carry everything else on demand. So every agent page must be short, retrievable by intent and true.

## 2. Where it lives

- Files: `docs/agents/*.md`, one topic per file, flat. The folder is new.
- Front matter, in the docs contract's existing keys, with one value that makes a page agent-only: `audience: agents` and nothing else in that list. A page whose audience contains any human audience is a human page, whatever its folder.
- Two keys are added to the contract for this folder only (in `scripts/lib/docs/check.js`): `tokens` (the page's budget, an integer, the check fails over it) and `when` (a one-line "read this when ..." that the docs tool shows in search results).
- `docs/nav.json` gets a new top-level list, `agents`, beside `sections` and `unpublished`. Pages in `agents` are listed for the docs tool and for nothing else.
- The human build (`scripts/build-docs`) renders no page whose audience is only `agents`: not in the nav, the search index, the sitemap, `/llms.txt` or the page counts. A link from a human page to an agent page is a check error.
- The `docs` MCP tool (built in C4) serves both sets. It returns an agent page only to a caller whose chain contains an agent hop or the harness, never to a person's browser session. Humans and agents share the same files and tooling, so nothing about the split is hidden in the repository.

## 3. The pages

Each page is at most 1,000 tokens unless noted, written as short rules and exact examples, with one "when this goes wrong" block. Tags in brackets say how the page is made.

1. `environment.md` [hand-written, with generated facts]: where an agent is. The machine kind (server, solo, device), what it is running inside (a sandbox, a computer, a session), the Vyre home, what belongs to the person and what to the agent, the network it has, the clock. How to ask for the live facts (the `vyre.core` tool).
2. `authority.md` [hand]: the actor chain, why an agent's authority is the intersection of every hop, why a denial looks like "not found", what a grant, a role and a task are, how to ask for more (a grant request is a task).
3. `outward-acts.md` [hand]: the Gate. What counts as outward (send, spend, post, delete, share, publish), how to request, what "held" returns, what the person sees, that the agent never holds the credential and cannot approve.
4. `sealed-and-secrets.md` [hand]: placeholders, sealed fields, never writing a secret into text, what a placeholder looks like, what to do when a value is needed but sealed (ask for a use, not a reveal).
5. `tools.md` [generated from manifests and the surface generator]: how tools are named and grouped, `find`, `create` and `update` per record type, results that are held, results by handle, which tools are always loaded and how to find the rest (`tools.find`, `tools.call`, when built).
6. `records.md` [hand, with the type list generated]: types, fields, stages, Kits, addresses (URNs), comments and activity, how to link records.
7. `flows.md` [hand, with the step kinds generated]: what a Flow is, that an agent drafts a proposal and a person applies it, the 19 step kinds in one line each, the `fn` sandbox limits, how to test a Flow without side effects.
8. `sessions-and-context.md` [hand]: threads, projects, the three memory layers, what Vyre gives a session at its start, what to recall and what to ask. Gets receipts and the facts ledger when 0.3.1 lands them.
9. `connections.md` [hand, with the catalog generated]: connectors, a firm's own connections, the `service` step, the MCP hub, how an outward operation is marked.
10. `computers-and-files.md` [hand]: the workspace, an agent's computer, Glass and take-over, file folders a person chose and what is off limits.
11. `skills.md` [hand]: what a skill is here, `skills.find` and `skills.list` (when built), that permission decides which skills a model may use.
12. `errors.md` [generated from the error code tables in `kernel/core/errors.js` and each module's codes]: every code, what it means, the one next step. "Errors that teach" lives here and in the errors themselves.
13. `behaviour.md` [hand]: how Vyre wants an agent to behave: act or ask (act on reads and drafts, ask before outward), report what was verified and what was not, keep to the cheapest path (one script for many steps, results by reference), cost awareness, no claims without a check, one message when done.
14. `index.md` [generated]: the page list with each page's `when` line, the same text the docs tool returns for "what pages exist". Stays under 600 tokens.

The architecture map (docs/architecture/map.md) stays a human page. The agent pages restate only what an agent must act on, and link by name to the map's headings for the rest, so the two cannot disagree: C4 adds a test that every agent page that names a module, a folder or a tool names one that exists, the same way `docs-check` fails a stale mention today.

## 4. What is generated and what is hand-written

Generated, from code, so it cannot go stale: the tool and event lists (`scripts/gen-docs-reference` already reads them), the type list from the Kits, the 19 step kinds from `kernel/flows/schema.js`, the error table, the connector catalog, and the module index the `vyre.core` tool returns at run time (the architecture map's module table is the human copy of the same facts). Hand-written pages carry the judgement: what to do, what not to do, when to ask.

## 5. How an agent finds and reads a page

- `docs.find` takes an intent in plain words ("send an email to a client", "why was my call refused") and returns up to five pages with their `when` lines and token counts, ranked by the same search the human site uses plus the `when` text. `docs.read` takes a page name and returns it whole, or one heading.
- A page is never longer than its `tokens` budget, so reading it costs a known amount. The docs tool says the cost before it returns the page.
- The always-loaded core names `docs` and `vyre.core` and one sentence on each. Nothing else about the docs is loaded until needed.

## 6. Tests that keep it honest

1. Budget: every agent page is at or under its `tokens`, counted with the repository's one token estimator, and the always-loaded text for `docs`, `tools.find` and `vyre.core` stays under the 6k cap.
2. Audience: no human page links to an agent page, the human build contains no agent page, and the docs tool returns agent pages only to an agent chain.
3. Staleness: every module, folder, tool, event, config key and error code an agent page names exists (the `docs-check` stale-mention check, extended to `docs/agents/`).
4. Coverage: every tool reach class, every outward kind and every error code is covered by a page, so a new one cannot ship without agent docs.
5. Usefulness (the proof harness, task 00n): a fixed set of agent tasks run with and without the agent docs, and the token and step counts are compared. The set starts with the ten questions in team/0.3.1/ARCH-QUESTIONS.md.

## 7. Open questions for the lead

1. Is `docs/agents/` the right home, or should the files live outside `docs/` (for example `harness/agent-docs/`) so that no human docs tool can ever surface them? The proposal keeps them in `docs/` to reuse the checks and the build.
2. Should the docs tool serve agent pages to a person's own Claude Code session (an agent hop under a person)? The proposal says yes: it is an agent chain.
3. Who writes the hand pages? Each page's owner is the module's team, with the architecture map as the shared reference.
