# Door retrofit: sessions and voice behind the inference door

Ship gate from the K3 review (contract 8.4, invariants 5 and 6). Owner: sessions teammate, branch work/flows.

## What goes through the door
- The API-key chat driver (core/sessions/drivers/openrouter.js: OpenRouter and "OpenAI-compatible"): every turn is `door.call({ chain, purpose: "session", provider, model, session: thread id, messages, credential })`. The key travels only in `credential`, which the door passes to the driver and never logs. `openrouterDoorDriver` is the provider side to register as `drivers[id]` in the door.
- Process drivers (Codex, Grok via ACP; Claude when its Switchboard wraps it with `throughDoor`): the prompt is `door.sanitize`d before it is written, and every report (assistant text, tool_use input, stream deltas, result) is `door.result`d before anything persists or shows it (D-2). Order is kept. A door that throws means the prompt is not sent.
- Spoken replies (local/voice/index.js `speakable`): the text goes through `door.sanitize` before it reaches the speech provider.
- Refusals (ledger_hit, residency, not_a_sink, budget) read in plain words (`doorMessage`) and never carry a value or a class's content.

## No door, no call
`ctx.model` is the door and `ctx.chainFor(o)` builds a session's kernel chain. With no door a provider reports "Model calls must go through Vyre's inference door" and sends nothing. `VYRE_LEGACY_DIRECT_MODEL=1` (`legacyDirect`) keeps the old direct path and logs one warning per provider. Today the flag is still needed anywhere the platform has not yet put `ctx.model` on the module context: every session and voice daemon test, and any box until the gateway wires the door in. It must be off by default in the release.

## What stays outside the door, and what covers it
- The model process itself (Claude Code, Codex, Grok): it reads its own tool results and calls its own provider. Prompts and reports are sanitised at our edge, but what the process reads from disk or a tool never passes `door.call`. Cover: the egress firewall (only the gateway reaches provider hosts, K6) and the sealing rule that sealed values are placeholders in everything an agent can read.
- Streaming: the door answers whole, so the chat driver shows the answer as one chunk. Gap: add `door.stream` and re-chunk.
- Speech audio (Deepgram listen, transcription, TTS audio): carries no text prompt, so there is nothing for `call()` to scan. Declared under `audio_only` in kernel/door/sinks.json. Cover: the key goes only to the provider's own host (providers.js origin rules) and the egress firewall.
- Account key checks in core/sessions/index.js (GET /auth/key or /models): send a key, no prompt. Listed in door_clients because the file names provider hosts.
- The Claude provider is built into the Switchboard, not registered by this module: wrap it with `throughDoor(provider, cfg)` there (platform or the Switchboard owner).

## Changed contracts
kernel/door/sinks.json: `retrofit_pending` is empty, `door_clients` lists the two session files, new `audio_only`. sinks.test.js reads `audio_only`. kernel/door/door.js, ledger.js and normalise.js are copied from origin/work/sealing unchanged (vault's merge brings the same bytes).
