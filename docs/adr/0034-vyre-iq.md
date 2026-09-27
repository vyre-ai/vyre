---
title: "ADR 0034: Vyre IQ"
summary: One question in, one cited answer out, from every session the user has had, their personal facts and the people and projects graph, in one to three seconds, and "not sure, here's what I know" rather than a wrong answer.
audience: builders, agents
owner: memory-iq
status: draft
---

# ADR 0034: Vyre IQ

Status: proposed, 27 Sep 2026 · Workstream: memory-iq (module `memory`, `core/memory`) · Builds on
ADR 0007 (intelligence), ADR 0023 (personal facts, written into this one) and ADR 0030 (sessions)

## The problem

The user asks their own history questions: "what's my wife's name", "which file had the stripe
refund bug", "what did we decide about the Harlow portal login", "who is Bram". Today three
pieces answer parts of that. Recall searches turns. The graph knows people and organisations.
memory.answer reads personal facts by rules and a fast model. None of them answers from all of it
at once, none cites where the answer came from, and memory.answer can be confidently wrong.

The user's words: the answer "needs to show up (even if it takes a second) to answer the question
from my sessions graph", and it must be "as robust as technology currently allows". Wherever they
ask (the Capsule, Chat, the phone), they get one answer within one to three seconds, with its
sources, or an honest "not sure" with what memory does know.

## Decision

Vyre IQ is the user-facing name for question answering over everything memory holds. It is one
tool on the memory module:

```
iq.ask { question, project_cwds?, room?, stream? }
  -> { answer: string|null, confidence: number, abstained: boolean, known: string[],
       sources: [{ session, seq, name, quote, ts }], via: "fact"|"retrieval"|null,
       latency_ms, cost_usd }
```

`stream: true` emits `iq.thinking { id, stage }` (understanding, searching, reading, checking)
and `iq.answered { id }`, so a surface shows a thinking state within 100 ms. The Capsule, Chat
and the phone call it; app-design owns how it looks. memory.answer stays as the fast path and the
contract cc-plugin already uses. Internal names (memory, personal, reader) stay.

### The pipeline

Each step has a time budget; the sum stays under three seconds at p95.

1. **Fast path (under 50 ms).** The question is parsed by the rules in `personal/answer.js`. If
   a personal fact answers it and that fact passed the second look (below), IQ answers at once:
   no model call. Most questions about the user's own family, home, car and work end here.
2. **Understanding (under 20 ms, no model).** People and places memory knows expand the
   question: "my wife" also searches "Dani", "the northwind app" also searches "Northwind
   Bakery" and "Priya". Time words ("last week", "in June") become a time window. This is where
   the graph is used, and it is measured (see Evaluation). If expansion does not help, it goes.
3. **Retrieval (under 150 ms).** Candidates come from three places, fused by reciprocal rank:
   session turns by BM25 (Recall's FTS index) and by embedding (Recall's vectors), personal
   facts, and graph facts. Fresher turns get a prior, and the newest value of a fact that changes
   over time wins, as the store already does. The scope filter runs here, before anything is read
   (see Scopes).
4. **Rerank (under 700 ms).** The top 30 passages are ranked by the fast model in one call, and
   the top 8 go on. A local cross-encoder is the alternative. It is measured on the same eval and
   kept only if it matches the model at lower latency and no network.
5. **Answer (under 1.5 s).** The fast model (the sessions model map, purpose `memory`, haiku,
   thinking off) reads the question and the 8 passages. It must answer in JSON:
   `{ answer, cite: [passage ids], confidence, abstain, known: [short facts it is sure of] }`.
   A citation must be one of the passages given. The answer's names and numbers must appear in
   what it cites, checked by code, not by the model. A failed check means abstain.
6. **Second look (under 700 ms, people and relations only).** When the answer says who someone is
   to the user, or a relation between people, a strict verify prompt reads the cited turns
   again. A disagreement means abstain. This is the check the reader already uses for extraction,
   which took the sealed world's confident-wrong answers from 9 to 6.
7. **Abstention.** Below a per-class threshold (higher for people and relations than for tools
   or places), IQ says "Not sure." and lists `known`: what it is sure of that bears on the
   question ("I know your son is Emrys; I don't know his school"). A wrong answer at confidence
   0.5 or more is the metric that matters most, and its target is zero.

### Models and where they run

All model steps use the fast model through the sessions layer's model map and one-shot jobs
(ADR 0030), with the per-purpose override. Spawning `claude -p` costs one to two seconds before
the model starts. That fits the background reader, not a three-second answer. IQ therefore asks
sessions for a warm background session with purpose `memory`: one long-lived SDK query with
streaming input, reused per question, closed after 10 minutes idle. Until that exists, IQ's model
steps run through `claude -p`, and latency is reported as it really is.

### Scopes

- The user's own surfaces (Deck, CLI, Capsule, their own sessions, `mcp` and `mcp:thread:<id>`,
  their tailnet devices) ask across everything.
- An agent granted some projects searches only those projects' sessions and graph rooms, and
  never personal facts.
- A session running in a project folder asks with `project_cwds`. Client data from another
  project never enters its passages unless the user asked from a surface that sees everything.
- The filter is applied at retrieval, so the model never reads what the caller may not see.

### Cost and budget

At the reader's measured cost (about $0.30 per 1,000 turns per reading), one IQ question costs
about $0.002 to $0.004: a rerank call and an answer call, plus a verify call only for people
questions. Questions come out of the same memory budget as the reader (config.memory.model),
with their own daily cap line. The fast path costs nothing.

## Evaluation

The evaluation decides every step above, and each result goes into this ADR as it lands.

- **Worlds.** `sealed` (life facts, written without the rules and never opened) stays the
  personal score. A new sealed **sessions** world holds questions answerable only from session
  transcripts: decisions, files, bugs, dates, who said what, what was deployed. It is written by
  an agent that never reads the code.
- **Metrics per world:** accuracy, confident-wrong (answered at 0.5 or more and wrong), abstain
  rate, p50 and p95 latency, and cost per question.
- **Ablations**, each on the same worlds: BM25 alone, embeddings alone, hybrid, hybrid with
  graph expansion, with and without rerank, and model rerank against a cross-encoder. ADR 0007
  measured the graph as not helping retrieval. IQ measures it again on questions about people,
  where expansion should matter most, and removes it if it does not help.
- **CI** replays every model call from recorded fixtures keyed by prompt hash, as the reader's
  eval does (test/eval/reads). CI never calls a model. Recording runs on testbox, and a sealed
  world is recorded without anyone reading it.

## Phases

1. This ADR, and the sessions eval world (sealed).
2. Retrieval with scopes and fusion, and the ablation harness. No model yet: measure recall@8
   on both worlds.
3. The answer step with citations, code-checked facts and abstention, replayed in CI.
4. The second look, the fast path from verified facts, and an answer cache that a new turn
   invalidates.
5. The warm session with sessions (latency), then `iq.ask` in the Capsule, Chat and the phone
   with app-design.

## Consequences

- One contract for every surface, and answers that show their sources.
- More model calls per question than memory.answer. The fast path and the cache keep most
  questions free.
- The sealed worlds make the score honest, at the price of never tuning on their failures.
- A slower answer (one to three seconds) is accepted for questions the fast path cannot answer.
