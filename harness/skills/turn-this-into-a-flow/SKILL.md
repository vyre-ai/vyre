---
name: turn-this-into-a-flow
description: Use when the user says to turn what you just did into a Flow, make it automatic, or repeat it every time, after you did the steps by hand in this chat.
---

# Turn this into a Flow

You already did the work by hand, so you hold the steps and the values. Do not ask the user to describe it again.

1. List the Vyre calls you made for the job, in order, each as `{ tool, input }`. Add `returns: { id }` to a call whose new record's id a later call used.
2. Pick what changes from one run to the next (a client's name, an amount) as `variables: { name: "<the value you used>" }`. Everything else stays as it was.
3. `tools_call flows_from-chat` with `{ name, calls, variables }`. Read the lines it returns and what it says it could not map; a call to an action of the Space needs a `resource` address to be a step.
4. Fix and add with `flows_patch`, save one case from this chat with `flows_test-save`, then `flows_propose` (it checks the draft and runs the case before a person is asked).
5. Tell the user in plain words what it will do and that nothing runs until they approve it.

Never approve it yourself. A draft you cannot map fully is still worth proposing if you say what is left.
