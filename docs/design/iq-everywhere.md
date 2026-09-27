---
title: "Vyre IQ everywhere"
summary: What Vyre IQ does on each surface today, what it should do, the gaps ranked by value for cost, and who builds each one. The contract is memory.ask (ADR 0034).
audience: builders, agents
owner: memory-iq
status: draft
---

# Vyre IQ everywhere

The user asked for IQ to be "really smart and designed really well and implemented across every
surface". This page is the map. It lists each surface, what IQ does there today, what it should do,
and the gap. The gaps are ranked by value for cost at the end, with an owner for each.

One rule holds on every surface: **one ask path**. A question goes to `memory.ask` (ADR 0034) and
comes back as an answer with its sources, or "not sure yet" with what memory does know. No surface
writes its own question rules, its own prompt or its own model choice. The hard rules come with it:

- **Grounded or abstain.** An answer names the sessions or facts it stands on. Code checks every
  name, number and path against what it cites. A surface never shows an answer without its sources
  one tap away.
- **Source trust.** Personal facts come only from the user's own words about their life, never from
  Claude's turns, tool output, pasted text or a Vyre dev session (core/memory/personal/trust.js).
- **Determinism.** The same question over the same memory gives the same answer, confidence and
  sources. Replies are kept by the prompt's hash.
- **The graph is first-class.** People, projects and decisions stay visible and editable wherever
  IQ shows an answer: a source links to the turn, and a person links to the Memory view.
- **Cost is visible.** Questions have their own daily cap ($0.50, about 150 questions). At the cap
  `memory.ask` returns `limited: true` and a `message`, and every surface shows that message.

## The contract every surface uses

```
memory.ask { question, context?: { project?, thread? }, project_cwds?, stream?, id? }
  -> { id?, answer, confidence, abstained, known[], sources[{ session, seq, name, quote, ts }],
       via: fact|retrieval|null, latency_ms, cost_usd, limited?, message? }
events (stream: true):
  memory.thinking { id, stage: understanding|searching|reading|checking }
  memory.answered { id, abstained, limited }
```

A surface makes its own `id` (letters, digits, `_`, `-`), sends `stream: true`, and shows a thinking
state from the first `memory.thinking` event. The events never carry the question or the answer.
A personal fact answers in under 50 ms with no model. Otherwise the fast model reads 8 passages:
about 3.8 s at p50 through `claude -p` today (measured on the open world), and under 3 s once
sessions' warm quick session lands (work/sessions, not on main yet).

How it looks is app-design's: an "Answer" variant of the result card
(docs/design/system/components/result-card), confirmed 28 Sep. It uses the result card's shell, with
no header row and never a primary action. Sources are source chips (a 1px strong rule, no fill, a
mono 12 meta line). Confidence is plain text in the meta line, never a colour. The abstain and
limited states use the same shell and padding, never a red or amber treatment. Above the search
hits there is a 12 px gap (space-3), full width. The shape every surface shares:

1. The answer, one or two sentences, in the user's words for names and files.
2. One line under it: how sure ("confidence 0.8") and where from ("from 2 sessions", or "from what
   you have said" for a personal fact).
3. Up to three sources: the session's name, when, and the quoted words. A tap opens that turn
   (`recall.thread` at `seq`). "More" shows the rest.
4. Abstained: "Not sure yet." then "What memory does know:" and the `known` lines, if any. Never an
   empty card.
5. Limited: the `message` as it came, with its link to Settings.

## Surface by surface

### The Capsule

- **Today.** The Capsule calls `memory.relevant` and `recall.search` itself
  (local/capsule/native/Sources/Host/CapsuleModel.swift:729-762), then starts a lean session whose
  system prompt is `composeIq` (core/sessions/iq-prompt.js) over those facts. Said.swift keeps its
  own question rules and shows `memory.answer`'s sureness. Nothing checks the answer against its
  sources, session transcripts are only raw hits, and there is no "what memory does know".
- **Should.** When the box decides the words are a question (cohesion item 5), the Capsule calls
  `memory.ask { question, stream: true, id, context: { project } }` and draws the result card
  above. "Ask Claude instead" stays as the second action, for a question memory cannot answer.
  Said.swift and its rules go.
- **Gap.** The largest one: the Capsule is where the user asks most, and it runs a second answer
  path. Owner: capsule-pro (active), with sessions for retiring the capsule purpose's IQ prompt.
  memory-iq's part (streaming, the id, the cap message) is built.

### Chat

- **Today.** The per-prompt hook (harness/hooks/hook.js, `harness.enrich`) adds up to five graph
  facts from `memory.relevant` to each prompt, marked as memory with their source. The assistant
  can call `memory_ask` over MCP (every module tool is offered), but nothing told it when, so it
  said "I don't remember" about things memory holds.
- **Should.**
  1. `memory.ask`'s description now tells the assistant to ask it before saying it cannot
     remember something from earlier sessions, and to name the session it cites (built).
  2. about.md (core/about) gains one line: "For a question about your past work or life, call
     memory_ask and name the session it cites." Static, so it costs nothing per prompt.
  3. The hook, for the user's own interactive session only (not an agent, not a project-scoped
     session), adds a personal fact when the prompt asks one (`memory.answer`'s rules, no model,
     under 50 ms): "what's my wife's name, and book us a table" arrives with "Your wife is Juno
     (from what you have said)". Never a model call per prompt.
  4. When the assistant cites memory in its answer, the Deck's chat renders "(from <session>)" as a
     link to that turn.
- **Gap.** 1 is built. 2 and 3 are small and belong to the harness (cc-plugin). 4 belongs to chat.
  A module caller (`module:harness`) passes memory's personal check, so the hook must decide scope
  itself: it sends `agent` or `project_cwds` whenever the session is not the user's own.

### The Deck (Find, Memory view, Now)

- **Today.** Find (deck/views/find.js:595-597) shows `recall.search` hits and `memory.relevant`
  facts: search results, never an answer. The Memory view browses and edits the graph
  (`memory.graph`, `memory.facts`, `memory.why`). Now shows what memory learned today. The Ask view
  uses `memory.relevant` for hints while typing.
- **Should.** Find shows an IQ card on top when the words are a question (they end in "?" or start
  with who, what, when, where, which, why, how, did, do, is, was), asked on Enter or after 700 ms
  without typing, never per key. The search hits stay below it, unchanged. The Memory view gets the
  same card from its search box, and each source links to the turn. Now needs nothing from IQ.
- **Gap.** Medium: one card component, one call, debounce. Owner: the Deck (app-design has the
  result card). Built once in chat-core so the PWA gets it too.

### The phone (Find)

- **Today.** iOS FindView.swift:607-621 calls `recall.search`, then `memory.relevant` with a
  `memory.facts` fallback. Android Find.kt follows the same grammar. Search results only.
- **Should.** The same IQ card as the Deck, same question test, same debounce, called over the
  tailnet as the owner (`tailnet:<login>` passes memory's personal check). Events may not reach
  the phone, so it shows a plain thinking state until the reply.
- **Gap.** Medium, twice (iOS and Android). Owner: mobile.

### The CLI (recall, memory, why)

- **Today.** `vyre memory ask` called `memory.answer`: personal facts only, no sessions.
  `vyre recall` searches turns. `vyre why` shows where a fact came from.
- **Should.** `vyre memory ask` is IQ: the answer, "confidence 0.8 · from 2 sessions", three
  sources (`--sources` for all), "not sure yet" with what memory knows, the cap message, exit 1
  when there is no answer, and `--json` for scripts.
- **Gap.** Built (this branch). A vyred without `memory.ask` still answers from personal facts.

### Suggest and predictive text

- **Today.** suggest (core/suggest) ranks agents, projects, threads, accounts and times per key.
  `memory.suggest` existed but nothing asked it.
- **Should.** The people and things memory knows complete as the user types: "my wi" offers "wife"
  with "Juno" beside it, "Jun" offers "Juno". Personal names only on the user's own surfaces. IQ
  answers are never suggestions: they come on pause, through the card.
- **Gap.** Built: memory offers `memory.suggest` to suggest at start and again on the new
  `suggest.ready` event, in the offer's `items` shape. One line in core/suggest (the event),
  listed in memory-iq's changed contracts.

### The assistant's own system prompt

- **Today.** about.md (core/about/index.js) holds up to 600 characters of `memory.profile` lines
  (work, places, preferences) and the agents and projects, read at SessionStart. No personal
  people facts, and nothing says memory can be asked.
- **Should.** The same, plus the one line about `memory_ask` (see Chat). People facts stay out of
  about.md: they enter a prompt only when the prompt asks about them.
- **Gap.** Small. Owner: cc-plugin (core/about).

### Teammates' notes

- **Today.** A teammate's notes file is its own memory of record and is deliberately not fed into
  memory (ADR 0031). Corrections go through `learn.add`.
- **Should.** Notes stay out of personal facts: they are an agent's words, and source trust says
  so. A teammate asks project history with `memory_ask`, scoped to its projects by the guard, so
  it never reads personal facts or another client's sessions. Its brief gains one line saying so.
- **Gap.** Small. Owner: teammates.

## Project graphs: a session that joins a project later

Cohesion writes the product spec. This is what IQ needs from it and what it costs.

- **Today.** Memory's rooms already follow projects: `project.created`, `project.changed`,
  `thread.picked` and `thread.unpicked` mark the rooms stale, and the next pass files a picked
  session's facts in that project's room (the ids come from `projects.list` picks). Personal facts
  never move: they are the user's, not a project's.
- **Gap.** IQ's retrieval scopes a project by its folders. `recall.search` has `project_cwds` and no
  session filter, so a session picked into a project from outside its folders is in the project's
  graph but not in the passages IQ reads for that project, and a project-scoped agent cannot read it.
- **Should.** `recall.search` takes `sessions: string[]` next to `project_cwds`, and a turn matches
  if either holds. `memory.retrieve` and `memory.ask` scope a project by its folders plus its picked
  session ids. A session unpicked leaves at the next pass. An agent's grants follow the same union.
- **Size.** Recall: S (one filter, an index on session already exists). memory-iq: S (the room's ids
  into retrieve, a test in each direction). Cohesion's spec decides the user-facing words.

## Host to server: the Mac's sessions build the box's graph

Federation owns the transport. This is the contract memory-iq proposes. It reverses ADR 0008's
"a Mac transcript is never stored on the box", so it needs an amendment and the user's yes.

- **Consent.** Off until the user turns it on for one Mac, in onboarding or Settings: "Build
  memory on your box from this Mac's Claude Code sessions." A person-only setting (presence proof).
  Folders can be left out (`memory.personal.skipCwds` and a sync exclude list); Vyre's own folders
  and `<home>/quick` are never sent. Turning it off deletes that Mac's turns and everything derived
  from them on the box, by machine tag, and says how much was deleted.
- **What moves.** Turns, not raw transcripts: `{ machine, session, seq, role, ts, cwd, name, text }`
  as the Mac's Recall indexes them, with the vault's scrub applied on the Mac first (keys, tokens,
  passwords never leave). Also the Mac's kept model reads (`memory_me_reads`, by text hash), so a
  turn the Mac already read is not paid for again on the box.
- **Dedupe.** The key is `(session, seq)`; the machine is a label, not part of the identity, so the
  same session copied to two Macs is stored once. Uploads are idempotent upserts from a per-session
  cursor the box acknowledges. A rewritten (compacted) session is sent with `rewritten: true` and
  replaces the old rows, which fires `session.indexed { rewritten }` as today.
- **What is indexed where.** The Mac keeps its own Recall for offline search. The box indexes
  everything it receives: Recall's keywords and embeddings (local model, CPU), the graph (rules,
  no model), and personal facts (the model reader). The model reader runs on one machine only:
  on the box when sync is on, so nothing is read twice. Mac surfaces ask the box's `memory.ask`
  over the link, and the Mac's own when the box is offline.
- **Load.** The Mac uploads in batches of at most 500 turns, no faster than every 60 s, only
  while idle, and never while a thread of the user's is working.
- **Cost.** Transport and storage: text only, tens of MB for a year of sessions. Embeddings and the
  graph: box CPU, no money. The model reader: a one-time backfill of about $1.50 to $2.60 in
  reported usage, then at most $0.25 a day (config.memory.model). It runs through the Claude
  Code login on the box, so the box needs one; with none, reading waits and nothing else breaks.
- **Size.** Federation: M to L (upload channel, cursor, consent and delete). memory-iq: M (ingest
  with machine labels, reader location, reads import, delete by machine, eval on a two-machine
  fixture). Recall: S (accept pushed turns). An ADR amendment for 0008.

## Ranked

Value is how often the user meets it and how wrong things are today. Cost is the work to build and
test it.

| Rank | Gap | Owner | Cost | Value | State |
|---|---|---|---|---|---|
| 1 | The Capsule answers through memory.ask, streamed; Said.swift goes | capsule-pro, sessions | M | highest | memory-iq side built; spec sent |
| 2 | The assistant knows to ask memory (tool description) | memory-iq | S | high | built |
| 3 | about.md line: ask memory_ask, name the session | cc-plugin | S | high | spec sent |
| 4 | `vyre memory ask` is IQ | memory-iq | S | medium | built |
| 5 | Predictive text knows memory's names | memory-iq (+1 line in suggest) | S | medium | built |
| 6 | Chat hook adds a personal fact when asked, no model | cc-plugin (harness) | S | medium | spec sent (0.1.1) |
| 7 | Deck Find and Memory view IQ card | deck, app-design | M | high | spec sent (0.1.1) |
| 8 | Phone Find IQ card | mobile | M | medium | spec sent (0.1.1) |
| 9 | Chat renders "(from <session>)" as a link | chat | S | medium | spec sent (0.1.1) |
| 10 | Teammates' brief: memory_ask for project history | teammates | S | low | built (work/teammates 7eb7ffb8; reaches teammates with core/team step 3) |
| 11 | Project graphs: IQ reads a project's picked sessions, not only its folders | memory-iq, recall | S | high | proposed (0.1.1) |
| 12 | Mac sessions build the box's graph (consent, dedupe, one reader) | federation, memory-iq, recall | M-L | highest for a box user | contract proposed |

## What makes IQ smarter, whatever the surface

These are memory-iq's own, measured on the synthetic worlds before they ship:

- **Prompt v2** (each passage names its project; answer exactly what was asked). Open world:
  accuracy 0.778 and 1 confident-wrong, against v1 re-recorded the same day at 0.767 and 2. One
  question apart on 90 is within the model's run-to-run spread, so it is not a measured win yet.
- **The second look** for answers about people (ADR 0034 phase 4).
- **Latency.** 3.8 s p50 through `claude -p`. The warm quick session in work/sessions is the fix.
- **"Before" for places**: a past place is answered with the current place's confidence (sealed
  place-history).

## Specs for the owners

Each owner builds against memory.ask as it is on work/memory-iq (streaming and `id` from 6adfc4b6).
Tests use the fixtures and temp homes only; under `node --test` memory has no model, so a question
that no personal fact answers comes back abstained, which is the state to test.

- **capsule-pro.** On a question, call `memory.ask { question, stream: true, id: "cap_<n>",
  context: { project } }`. Show the thinking state from the first `memory.thinking` with that id,
  the stage as a word ("searching", "reading"). Draw the result card. A source tap opens the turn.
  Abstained: "Not sure yet." plus `known`, then "Ask Claude instead". `limited`: show `message`.
  Remove Said.swift's question rules and the `memory.relevant` plus `composeIq` path. Where the box
  has no `memory.ask` (no_such_tool), keep today's path.
- **sessions.** Once the Capsule has moved, the capsule purpose's IQ prompt (core/sessions/iq-prompt.js)
  is used only by old Capsules; retire it a release later. Keep the quick session for purpose memory
  warm: it takes IQ from 3.8 s to under 3 s.
- **cc-plugin (paused).** core/about: add "For a question about your past work or life, call
  memory_ask and name the session it cites." to about.md, inside the 600-character budget.
  harness.enrich: when the session is the user's own and interactive (no agent, all projects), and
  `memory.answer { q: prompt }` returns `kind: "fact"` at confidence 0.5 or more, add its answer as
  one memory line "(from what you have said)". Otherwise nothing new. No model call per prompt.
- **Deck and app-design.** Find: the IQ card above the hits for question-shaped words, on Enter or
  after 700 ms still, one call per settled question, the previous one's events ignored by `id`.
  Memory view: the same card from its search box. Put the card in chat-core so the PWA gets it.
- **mobile (paused).** iOS FindView and Android Find: the same card over the tailnet, a plain
  thinking state (no events), the same question test and debounce.
- **chat (paused).** Render "(from <session name>)" in an assistant message as a link to that
  session when the session exists in `recall`.
- **teammates.** One line in a teammate's brief: "For what was decided or done before in your
  projects, call memory_ask; it sees only your projects." Notes stay out of memory.
