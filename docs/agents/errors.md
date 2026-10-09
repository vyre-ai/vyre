---
title: Errors and what to do next
summary: Every error code you can meet and the one next step for each.
audience: agents
owner: docs
status: stable
tokens: 1600
when: A call failed with a code, or a refusal does not say why, or you are deciding whether to retry.
---

# Errors and what to do next

A failed call returns a `code` (stable, lowercase) and a message. The message never repeats secret input. Read the code first, then the message. Retry only where the table says so: a second identical call to a refused act gets the same answer.

<!-- agent:errors:start -->

| Code | What to do |
| --- | --- |
| `bad_input` | The input is malformed or a field is missing. Read the message, fix the input, call again. |
| `bad_state` | The thing is in the wrong state for this (for example a task already done). Read its state and choose a legal next step. |
| `budget_exhausted` | The spend or token budget is used up. Stop and tell the person. |
| `chain_not_person` | This act needs a chain that is exactly one person. An agent cannot do it. Ask the person to do it. |
| `changed_since_approval` | The act changed after the person approved. It will be held again; tell them. |
| `cloud_required` | This needs a Cloud space (a server). Tell the person. |
| `denied` | Refused by a rule. Read the message; ask the person if you need it. |
| `draft_only` | This connection or tool only drafts. Make a draft; a person sends it. |
| `expired` | It ran out of time (a proof, an approval, a code). Ask for a new one. |
| `field_not_allowed` | That field may not be set by you. Leave it out. |
| `field_not_shown` | The field is not shown to this caller. Leave it out. |
| `field_required` | A required field is missing. Fill it or ask the person. |
| `idem_conflict` | The same request key was used for different input. Make a new key. |
| `invalid` | The value is not valid. Read the message and correct it. |
| `key_custody` | The machine cannot keep keys safely, so this will not start. Tell the person; do not retry. |
| `log_broken` | The Space's log does not verify. Stop. A person must look. |
| `log_rolled_back` | The Space's log was rolled back. Stop. A person must look. |
| `module_down` | The module behind this tool is not running. Wait and retry once; then tell the person. |
| `module_failed` | The module failed to start. Tell the person; do not retry. |
| `moved` | The thing moved. Follow the new address in the message. |
| `needs_approval` | A person must approve first. The act is held as a task. Tell them; do not repeat the call. |
| `needs_confirmation` | The act needs the person to confirm the exact words. Show them and wait. |
| `needs_presence` | A person must prove they are there (a signature on their own device). Tell them what waits and where. |
| `no_checker` | The task needs a checker and has none. Ask the person to name one. |
| `not_a_member` | You or the person are not a member of this Space. Do not retry. |
| `not_allowed` | Your chain may not do this. Do not retry or work around it. Ask the person, or request a grant. |
| `not_contained` | The sandbox could not confine this. It will not run. Tell the person. |
| `not_found` | Absent, or you may not see it (the two look the same). Do not retry. Say what you could not read, or ask the person for access. |
| `placeholder_unreadable` | The placeholder could not be resolved for this act. Do not guess; tell the person which field. |
| `rate_limited` | Too many calls. Wait, then continue slower. Do not loop. |
| `rule_failed` | A rule of the Space refused the change. Read the message and fix what it names. |
| `same_actor` | The doer and the checker may not be the same. Ask for a different checker. |
| `sealed` | The value is sealed. Use the placeholder; never ask for the value. |
| `sealed_value_refused` | A sealed value was refused where it may not go. Use the placeholder. |
| `secret_refused` | A secret was found in text you sent. Remove it and use the vault or a placeholder. |
| `stage_entry_refused` | The record may not enter that stage yet. Read the message for what is missing. |
| `stage_not_in_set` | That stage does not exist for the type. Read the stages and choose one. |
| `stage_tasks_open` | Open tasks block this stage. Finish or skip them first. |
| `timeout` | It took too long. Retry once with a smaller request; then tell the person. |
| `too_large` | The input or output is too large. Send less or ask for less. |
| `unavailable` | The service is not ready or reachable right now. Wait and retry a few times, then tell the person. |
| `unique_violation` | A record with that unique value exists. Find it instead of creating another. |
| `unknown_field` | No such field on that type. Ask `records.types` for the fields. |
| `unknown_type` | No such record type in this Space. Ask `records.types` for what exists. |
| `unreachable` | The other machine did not answer. Retry once; then tell the person it seems to be offline. |
| `unsupported` | This is not supported here (the machine, the store or the version). Do not retry; tell the person. |
| `used_up` | A one-time proof or approval was already used. Ask for a new one. |
| `version_conflict` | Someone changed it since you read it. Read again, then decide whether your change still applies. |
| `wrong_space` | The call names a different Space than this chain. Use the right Space's chain. |

Other codes, which carry their own message: `already_adopted`, `bad_endorsement`, `bad_revocation`, `closed`, `contents_differ`, `id_mismatch`, `limit`, `no_audience`, `no_grant`, `output_check_failed`, `pattern_not_covered`, `revoked`, `runner_only`, `store_disagreed`, `store_required`, `supervisor_absent`, `tainted`, `type_exists`, `undeclared`, `unknown_action`, `unknown_lease`, `wrong_node`.

<!-- agent:errors:end -->
