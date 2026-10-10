---
title: The agent docs
summary: The list of agent pages, what each is for and what it costs to read.
audience: agents
owner: docs
status: stable
tokens: 700
when: You want to know which agent docs page to read for what you are doing.
---

# The agent docs

Read the page for what you are about to do, not all of them. `docs.find` finds a page from an intent in plain words and `docs.read` returns it, or one section with a heading. The cost of each page is in tokens.

<!-- agent:index:start -->

| Page | Read it when | Tokens |
| --- | --- | --- |
| `environment.md` | You need to know where you are running: which machine, which Space, what is yours, what belongs to the person and what you cannot reach. | 523 |
| `authority.md` | A call was refused or came back not found, you wonder what you are allowed to do, or you need more access. | 529 |
| `outward-acts.md` | You want to send an email or message, pay, post, publish, share, or delete something, or a call came back held. | 545 |
| `sealed-and-secrets.md` | A field shows a placeholder instead of a value, you need a password, key or number you cannot see, or you are about to write a secret into text. | 397 |
| `tools.md` | You need a tool and do not know its name, a tool you expected is missing, or a call returned a held result. | 1233 |
| `records.md` | You read, create or change a contact, matter, task, note, file or other record, or need to link one record to another. | 582 |
| `flows.md` | You write, change, test or explain an automation, or a Flow step asks you to do something. | 1495 |
| `flows-cheatsheet.md` | You are about to write or change a Flow and need the exact keys, an example of each step, and the limits. | 1770 |
| `sessions-and-context.md` | You start or continue a session, need to know what was done before, or want to remember something for later. | 652 |
| `connections.md` | You need to read from or act on an outside service such as mail, a calendar, a payment provider or any API, or a tool from an MCP server. | 672 |
| `computers-and-files.md` | You need to read or write files, run something on a computer, use a browser, or hand a screen to a person. | 426 |
| `skills.md` | You are looking for a ready-made way to do a kind of task, need to find the right skill, or a skill is offered or refused. | 561 |
| `errors.md` | A call failed with a code, or a refusal does not say why, or you are deciding whether to retry. | 1385 |
| `behaviour.md` | You are unsure whether to act or ask, how much to say, or how to spend the fewest steps and tokens. | 424 |

<!-- agent:index:end -->

These pages are for agents. They are not offered to people, and they are not published on the website. The human docs (the map in `architecture/map.md` and the rest) are also yours to read with `docs.read`.
