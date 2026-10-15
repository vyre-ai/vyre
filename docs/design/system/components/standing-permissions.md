---
title: Standing permissions
summary: What an agent may send, post or pay by itself. A row per permission with its connection, recipient chips, daily cap and use, and Revoke; the add sheet names the recipients, the cap and the expiry and says when a followed list can change who is covered.
audience: builders
owner: app-design
status: draft
---

# Standing permissions

An agent that wants to send, post or pay asks once, and the person's answer can become a standing permission: that agent, through that connection, to those recipients, up to a daily cap. Inside it the act goes out with no question. Outside it, the agent asks as before. The box keeps the grants (`gate.standing.add`, `list`, `revoke`) and checks every act; this list only shows them and sends the person's calls.

| Surface | Implementing file | Status |
|---|---|---|
| App, an agent's page, "Where it is used" | `apps/app/ui/components/StandingPermissions.tsx`, exported from `@vyre/ui`; the section in `apps/app/screens/assistants/StandingSection.tsx` | built |
| Deck, Lumen | not used | |

## Anatomy

One row per permission, in a card:

1. **Title.** The kind and the connection as the person knows it: "Send from alex@harlowlegal.com", "Pay from the vendor account". The assistant is never listed.
2. **Meta line.** The daily cap or the payment limits, how often it has been used and the last use, and the end date when there is one: "Up to 20 a day · 3 times, last 2 days ago".
3. **Recipient chips** (chip.md): each address, each `*@domain`, each list. A list that is followed as it changes adds a warning chip, "Follows the list".
4. **Recent line.** Up to three of the last acts, in `--label`, so a person sees what it actually did.
5. **Revoke.** A ghost button at the end of the row. It ends the permission at once; the agent's next act asks.

Under the rows, "Let it act by itself" opens the add sheet. With none, the list says "This agent asks you each time it wants to send, post or pay."

## Add sheet

A sheet (sheet.md) with: the kind (Send, Post, Pay), the connection, who it may go to (addresses, `*@domain`, lists, typed and separated by commas), the daily cap (or, for Pay, the most for one payment, the most for a day and the currency), how many days it lasts (empty for no end), and for lists a switch "Follow the lists as they change". The switch reads: "Anyone who can edit these lists can change who this agent sends to." Without it the addresses a list holds now are what the permission means.

The sheet saves with the person's presence, as every grant does. A person only lists connections they can use themselves.

## Who sees it

An owner and an admin see every permission; an agent's own owner sees theirs. Nobody else sees the section, and a model never adds or widens one.

## Copy

"Let it act by itself", "Revoke", "Follows the list", "Up to 20 a day", "Not used yet", "Ends 2026-11-01". Never a grant id, an action name or a vault path.
