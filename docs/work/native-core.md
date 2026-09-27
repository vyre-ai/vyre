# native-core

## Scope
Own the NATIVE CORE milestone end to end: chat on the Claude Agent SDK that feels as native and
smooth as the Claude Code terminal (and Paseo), plus complete Settings at account and project level.
The bar: the user does a full working day in Vyre chat instead of the terminal and doesn't want to go
back.

Definition of done: the user uses Vyre chat for a full working day instead of the terminal.

## Done
- 2026-09-27: audits of sessions, chat, settings and Paseo (findings in the gap list sent to the
  lead). docs/design/settings-inventory.md and docs/design/native-bar.md written.

## Doing
- First report to the lead. Contract mismatches sent to sessions and chat.

## Next (1-week plan)
1. Day 1-2: core/settings registry + adapters, `settings.*` tools, `settings.changed`,
   `vyre config`. Tests in a temp home.
2. Day 2-3: Settings screens (Account and Project tabs) per design A: Models and thinking,
   Permissions, Prompt, Sessions and concurrency, Tools (MCP, hooks, env, plugins), Notifications,
   Memory, Vault, Files, Network. Effective value + source + reset on every row.
3. Day 3-4: stream smoothness in chat (with chat): Paseo paced reveal, tail-block-only markdown,
   intent-only detach, one commit per frame, stream.reset handling, draft persistence.
4. Day 4-5: native-bar harness on testbox, numbers for Vyre, terminal, Paseo.
5. Day 5-7: dogfood a full day on the box; fix what hurts.

## Needs from others
- sessions: commit step 6; rewind (resumeSessionAt + enableFileCheckpointing + rewindFiles);
  thinking deltas as kind:"reasoning"; setModel/effort/fallback; supportedCommands; images;
  tool input + capped output on thread.tool; keep mode across resume; initial permissionMode.
- chat: align names (mode.changed, queued_id, threads.send-now); stream.reset; jank fixes.
- app-design: tokens + design A frames for Settings (account/project).
- polish-cli: `vyre config` verb shape agreed with me.
