# Pending for docs/using/claude-code.md (cc-plugin), apply when c4a30dd and 2d9a274 are on main

Verify each line against the merged code before applying (planner module, /vyre commands, the
session "about you" lines and their filters, the 20-an-hour limit).

## /vyre table: add rows, change `remember`

| `/vyre todo <text>` | Adds a todo. `/vyre todo` with no text lists your open todos. |
| `/vyre remind <when> <text>` | Sets a reminder, for example `/vyre remind 6pm call Dana at Harlow Legal`. Claude says when it will ring. |
| `/vyre agenda` | Today's reminders in time order, then open todos. `/vyre agenda tomorrow` shows tomorrow. |
| `/vyre remember <fact>` | Remembers a fact about you or your work for every future session, for example `/vyre remember Northwind Bakery's orders close at 3pm`. |
| `/vyre lesson <rule>` | Makes a lesson (this used to be `/vyre remember`). |

## Snag

"`/vyre todo` or `/vyre remind` says the planner is not running": the planner module is not on this
machine yet; Claude will not pretend to set anything.

## New section after "What you get": Every session knows you

Each new session starts with a few lines about you: your name, your assistant's name, your busiest
projects and the people in them, and what memory knows about you. Vyre keeps these lines up to date
whenever memory, your projects or your agents change, so starting a session never waits on them,
and they're still there when vyred is stopped. They stay short (under 600 characters). Anything that
looks like a password, key, token, email address or phone number is left out. Claude reads them as
facts, not instructions. An agent that works only in some projects doesn't get them; your own
sessions and your assistant do.

## Under the `vyre` MCP server paragraph

When Claude promises a reminder ("I'll remind you at 6"), it sets it with the planner in the same
turn. If the planner isn't running, it tells you it can't set a reminder yet, instead of promising.

## Agents and the planner (user's rule, replaces the old "20 an hour" line)

Agents add notes, reminders and todos without asking. An item shows the agent's name only when it
comes from someone other than your own assistant or your own session. (A silent runaway cap of
about 200 an hour exists; the page does not mention it.)

## Also

- using/cli.md and using/learning.md: `/vyre remember` becomes `/vyre lesson` wherever they mention it.
- The planner's own user page (todos, reminders, agenda, alarms) belongs to the planner team (or
  docs writes it from their contract). When it exists, link it from the /vyre todo, remind and
  agenda rows. Agent rule (user, replaces the earlier one): agents add notes, reminders and todos
  without asking; an item names the agent only when it is not your own assistant or session. No
  visible limit; do not mention the silent cap.
