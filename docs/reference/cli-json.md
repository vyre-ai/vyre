---
title: CLI output for surfaces
summary: What vyre --json, --view and vyre commands --json print, so the Capsule, chat and the phone can run a command and draw its answer.
audience: builders, agents
owner: polish-cli
status: stable
---

# CLI output for surfaces

The Capsule runs `vyre` by argv (never through a shell) and draws what comes back. Chat and the
phone will do the same. Three outputs are stable and versioned:

| Flag | Prints | For |
|---|---|---|
| `--json` | the verb's data, one JSON value per line | scripts |
| `--view` | frames: the data plus how to draw it | the Capsule, chat, the phone |
| `vyre commands --json` | every command and verb, with arguments and flags | autocomplete and / menus |

Exit codes are the same everywhere: 0 ok, 1 failed, 2 usage (or a prompt, below), 3 a person
must prove it is them, 4 the vault is locked, 5 vyred is not running.

## --json

Each read prints its data and nothing else on stdout. The shape of each verb's data is named in a
comment at the verb in `core/cli/commands/`. A failure prints `{"error":{"code","message","next"}}`
with the exit code above. Live verbs (`vyre threads watch`) print one line per event.

## --view

Every line on stdout is a frame:

```json
{"v":1,"cmd":"threads list","view":{"kind":"table","columns":[{"key":"name","label":"Thread"}],"rows":[]},"data":[]}
{"v":1,"done":true,"exit":0}
```

- `data` is exactly what `--json` prints for the same verb.
- The last line is always the done frame, with the exit code.
- A live verb sends a frame per change; the newest frame of a kind replaces the last one.
- Nothing is read from stdin and no colour is printed. A verb that prints only words for a
  person comes out as one `text` frame.

### View kinds

| kind | fields |
|---|---|
| `table` | `columns: [{key, label}]`, `rows`, `title?`, `empty?` (what to show with no rows) |
| `card` | `title?`, `fields: [{label, value}]`, `state?` |
| `text` | `lines` |
| `qr` | `text` (what the code encodes), `caption?` |
| `checks` | `items: [{id, label, state: ok, wait, failed or unknown, note?}]`, `title?` |
| `prompt` | `name`, `label`, `args`, `answer`, `flag?`, `choices?`, `secret?` |
| `error` | `code`, `message`, `next?` |

A verb that does not pick its own view gets one from its data: a list of objects is a table, an
object with one list is a titled table, any other object is a card.

### Prompts

Under `--view` a verb never waits for input. When it needs an answer it prints a prompt frame and
exits 2. The surface asks the person and runs `vyre <args...>` again with the answer, where
`answer` says:

| answer | how the answer goes back |
|---|---|
| `word` | appended as the last word: `threads rewind t1 3` |
| `flag` | appended as `--<flag> <answer>`: `gate revise d1 --text "..."` |
| `stdin` | written to stdin, never an argument; `args` already carry `--stdin` (secrets) |
| `confirm` | on yes, `args` run as they are (they carry `--yes`); on no, nothing runs |

A verb that needs a person to prove it is them prints an `error` frame and exits 3; the surface
proves it its own way and runs the verb again.

## vyre commands --json

Works before `vyre up`: it reads the command files.

```json
{"v":1,"commands":[{"name":"relay","summary":"...","group":"Start and connect","usage":"vyre relay [...]",
  "verbs":[{"verb":"trust","args":[{"name":"id","required":true}],"flags":[{"name":"off"}],"read":false}]}]}
```

- `verbs[]`: `verb`, `aliases?`, `summary?`, `args: [{name, required, repeat?, choices?}]`,
  `flags: [{name, value?, choices?}]` (no `value` means a switch), `read` (only reads),
  `person?` (asks a person to prove it is them), `live?` (follows changes).
- A command without verbs has its own `args` and `flags`; one with both (`vyre apps`) has both.
- `--all` adds hidden commands; `vyre commands <name> --json` gives one.

When platform's module commands land (ADR 0033), they join this list in the same shape.
