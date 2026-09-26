# vyred HTTP client contract (for native iOS / Android)

Source: main at `d1f7b75`. All paths are repo-relative. Shapes are what `run()` returns, not what the schemas advertise. `?` = optional/conditional key.

Mobile additions (ADR 0018): the `device` presence method, `surface: "ios"|"android"` on every write, and native push transports. Where a shape here and the code disagree, the code wins and this file is fixed.

---

## 0. Things that block a native phone today (read first)

1. **Where the phone connects.** Only a **box** has a network listener. The tailnet listener lives in the `names` module, and that module runs with `roles: ["box"]` (`core/names/module.json:4`, `core/names/service.js:181-226`). A Mac vyred listens only on its unix socket. So the phone talks to the box over HTTPS on its ts.net/cert name. Every request from the phone arrives with caller **`tailnet:<login>`** (`service.js:225`). The router ignores `x-vyre-caller` when a listener has set the caller (`core/daemon/index.js:149`).
2. **`callers` and the tailnet (fixed on work/mobile, ADR 0018).** `callerKind("tailnet:alex@example.com")` still returns the whole string (memory's guard relies on it), but a `callers` entry `"tailnet"` now matches any `tailnet:<login>` caller, in `Registry.call` and in `GET /v1/tools` (`callerAllowed`, `core/modules/index.js`). A bare `tailnet` label from the socket never matches. These tools list it:
   - `gate.get`, `gate.approve`, `gate.reject`, `gate.revise` (`core/gate/index.js`)
   - `threads.answer` (`core/switchboard/index.js`)
   - every `push.*` tool (`core/push/index.js`, `PEOPLE`)
   - `vault.reveal`, `vault.copy`, `vault.session.open`, `vault.session.status` (`core/vault/tools/surfaces.js`) and `vault.totp` (`core/vault/index.js`)

   Still refused to the phone (403 `denied`, and left out of `GET /v1/tools`): `vault.fill.native`, `agents.delete`, `link.pair/find/unpair`, and `memory.correct/uncorrect/merge/split` (on purpose, `memory/index.js`). The human-only ones above still need a proof: a phone without one gets 403 `presence_required`, not `denied` (`test/mobile-tailnet.test.js`).
3. **Deck parity gaps you should not copy.** `deck/js/needs.js:86-94` and `deck/chat/gate-item.js:55-63` call `gate.approve`, `gate.reject` and `threads.answer` **without** `{presence:true}`, so they always get `presence_required`. `deck/chat/gate-item.js:49` calls `gate.revise`, which `deck` may not call.

---

## 1. Transport (`core/daemon/index.js`)

### 1.1 Tailnet listener gates (`core/names/service.js:181-221`)
- TLS 1.2+. HSTS on every response.
- The peer is identified by Tailscale whois. If it is not the owner: **403** `{"error":{"code":"not_owner","message":"This Vyre serves only its owner."}}`.
- The `Host` header must be the cert name or a self IP, optionally with the bound port. Otherwise: **421** `{"error":{"code":"misdirected",…}}`.
- Any non-GET/HEAD request must send `content-type: application/json`. If an `Origin` header is present it must equal `https://<host>`. Otherwise: **403** `denied` "cross-site request". A native app should send no `Origin`.

### 1.2 Envelope
- Success is `{"data": <any>}`. Failure is `{"error":{"code":string,"message":string, methods?:string[], detail?:object}}` (`daemon/index.js:112-115`, `modules/index.js:289-319`).
- A tool that throws gets code `failed`, unless the thrown error carries a lowercase `code`, which passes through (`:313-317`). Examples: `denied`, `presence_required`, `box_unreachable`, `locked`.
- `presence_required` errors carry `methods` (`modules/index.js:306`).

### 1.3 Routes
| Route | Out | Status |
|---|---|---|
| `GET /v1/health` | `{data:{version,pid,role,uptime,supervisor,last_event,modules:{running,failed}}}` (`:182-189`) | 200 |
| `GET /v1/modules` | `{data:[{name,version,state,error?,shows?}]}` (`:190`, `modules/index.js:322-326`) | 200 |
| `GET /v1/tools` | `{data:[{name,module,description,input,presence?:true}]}`, filtered for this caller (`:191`, `modules/index.js:329-333`) | 200 |
| `POST /v1/tools/<name>` | the envelope, from JSON body = tool input (`:192-197`) | 200 ok · 404 `no_such_tool` · 403 `denied`/`presence_required` · 400 `bad_input` · **500 for everything else** |
| `POST /v1/presence/challenge` | see 1.6 (`:200-204`) | 200 · 404 · 400 · 403 |
| `GET /v1/events?since=&type=&project=&limit=` | `{data:[Event]}`. `type` matches exactly; limit ≤1000, default 200 (`:215-218`) | 200 |
| `GET /v1/events/stream` | SSE, see 1.4 | 200 |
| `POST /v1/<module>/<name>/hook` | webhooks, not for clients | 202 |
| `GET /*` (non-`/v1/`) | Deck static files, index.html fallback (`:274-295`) | |

Limits: request body ≤ 5,000,000 chars. A body that is not JSON gives 500 `internal` (`:117-122`). `bad_input` comes only from the schema check: types, required keys, enums. Unknown keys are allowed (`modules/index.js:87-100`).

### 1.4 SSE `/v1/events/stream` (`daemon/index.js:236-264`)
- Query `type` = `*` (default), `thread.*` (prefix, matched with `startsWith("thread.")`), or an exact name.
- Query `since` = an event id, or `latest` to skip the backlog. A `Last-Event-ID` header wins over `since`, and `since=latest` is honored only when no `Last-Event-ID` is sent (`:240-242`).
- Headers `content-type: text/event-stream`, `cache-control: no-store`, flushed immediately.
- It replays the backlog in pages of 500, then streams live.
- Frame: `id: <e.id>\nevent: <e.type>\ndata: <JSON Event>\n\n` (`:251`).
- Heartbeat is the comment `: beat\n\n` every 15 s (`:260`).
- Recommended: `GET /v1/health` → keep `last_event`, load state through tools, then open `since=<last_event>` (or `latest`), and resume with `Last-Event-ID`. The Deck does `since=latest` (`deck/js/api.js:232`).

**Event record** (`core/events/index.js:52`; `since()` at `:93-98`): `{id:int, at:ms, type:"noun.verb", source:"<module>", project:string|null, thread:string|null, payload:object}`. Module names used as `source`: `threads` (switchboard), `gate`, `harness`, `presence`, `memory`, `push`, `vault`.

> `threads.get` returns events as `{id,at,type,payload}` only, without `source`, `project` or `thread` (`switchboard/index.js:555-556`).

### 1.5 `x-vyre-presence` header (`core/presence/index.js:108-120`)
Format: `"<method> k=v k=v"`. Tokens are whitespace-separated. Keys match `[a-z][a-z0-9_]*`, values have no whitespace, keys cannot repeat, and the whole header is ≤32 KB. Methods: `touchid|tty|capsule|device|passkey|code|session` (`METHODS`).

| Method | Header | Checked at |
|---|---|---|
| passkey | `passkey id=<challenge> cred=<credId b64url> ad=<authenticatorData> cd=<clientDataJSON> sig=<signature>` (all base64url) | `:362-383` |
| session | `session id=<session> secret=<secret>` | `:385-396` |
| capsule (Ed25519) | `capsule key=<keyId> ts=<ms> nonce=<[A-Za-z0-9_-]{8,128}> sig=<b64url>`. Signed message: `"vyre-presence-v1\n"+tool+"\n"+inputHash+"\n"+ts+"\n"+nonce`. Clock skew allowed is ±60 s, and each nonce is single-use | `:344-360` |
| device (ECDSA P-256, the phone) | `device key=<keyId> ts=<ms> nonce=<[A-Za-z0-9_-]{8,128}> sig=<b64url DER ECDSA>`. The same signed message as capsule, hashed with SHA-256 (ES256). Same ±60 s window, and the nonce set is shared with capsule, so a nonce is spent whichever key used it. Allowed on the box | `verify`, the capsule/device branch |
| code | `code code=<8 chars>`. Accepted only for `presence.enroll`. On the box the caller must be `tailnet:<network.owner>` | `:398-410` |
| tty / touchid | not for phones | |

`inputHash` is base64url(SHA-256(canonical JSON)). Canonical JSON sorts keys at every depth, drops `undefined`, and has no spaces (`:91-101`). Any proof is bound to the tool name and that exact input, and works once. **A retry must send a byte-identical input object.**

Human-only tools (`HUMAN_ONLY`, `presence/index.js:21-34`):
- `gate.approve/revise/reject`, `threads.answer`
- `vault.put/approve/unlock/offboard/inject/totp/backup/restore/delete/device.code/device.unlock/unlock-passphrase/reveal/copy/resolve/render/session.open/export/kit`
- `learn.accept/retire/relax/skill_install`
- `computers.takeover/giveback`, `link.pair.approve`
- `presence.enroll/remove/code/session.open`

Tools can also opt in with `presence:{…}`. Examples: `memory.correct/merge/split` and `vault.fill.native`.

### 1.6 Presence challenge (`daemon/index.js:200-204`, `presence/index.js:259-292`)
Request: `POST /v1/presence/challenge {tool, input, method:"passkey"|"tty", tty?}`.

Passkey reply:
`{data:{challenge:<id>, webauthn:{challenge:<b64url 32B>, rpId, userVerification:"required", timeout:60000, allowCredentials:[{type:"public-key",id}]}}}`
- `rpId` is the rp_id of the **first-enrolled** passkey. Only passkeys with that rp_id are offered (`:283-289`).
- The challenge lives 120 s and gets one attempt. At most 64 challenges can be open.

Errors:
- no passkey enrolled: 400 `bad_input`
- other methods: 400
- too many open: 403 `denied`

### 1.7 `presence_required` (`modules/index.js:304-306`, `presence/index.js:302-306`)
Body: `{"error":{"code":"presence_required","message":"<why>","methods":["touchid"?,"tty"?,"capsule"?,"device"?,"passkey"?]}}`, HTTP **403**.
- A call with no proof lists the methods available. The Deck uses this to decide what to offer.
- A failed proof also emits the event `presence.refused {tool,method,caller}`.
- On the box, `tty` is never offered (`:250-252`). `methods` only includes `capsule`, `device` or `passkey` if a key of that kind is enrolled (`methods()`). On a box with only a device key enrolled, a phone sees `["device"]`.
- The `callers` check runs **before** the presence check. A tailnet caller refused by `callers` sees `denied`, never `presence_required` (only for the tools still without `tailnet`, section 0.2).

---

## 2. Now screen

### 2.1 Tool calls the Deck makes
- `deck/views/now.js`: `agents.list` (`:37`), `threads.list {}` (`:84`), `projects.catalog {limit:5}` when nothing runs (`:106`), `memory.facts {limit:200}` + `projects.catalog {limit:500}` + `projects.list` (`:118-121`), `memory.pin` / `memory.mute {node, off}` (`:264-270`).
- `deck/js/needs.js:30-39`: `gate.held`, `threads.asks`, `threads.list`, `projects.list`, then `gate.get {id}` once per held id, cached.
- Answering (`needs.js:84-99`): `gate.approve {id, edited?}`, `gate.reject {id}`, `threads.answer {ask, decision:"allow"|"deny", surface:"deck"}`.
- The view refreshes on `ask.raised`, `ask.answered`, `gate.held`, `gate.released`, `gate.failed`, `gate.rejected` (`deck/js/app.js:267`) and on `thread.started/finished/stopped/tool` (`now.js:113`).

### 2.2 Gate shapes (`core/gate/gate.js`)
- `KINDS = send|spend|delete` (`:35`).
- **`gate.held {thread?, project?}`** returns `Brief[]`, oldest first (`:118-131`):
  `Brief = {id:hex18, kind, via, to:string[], summary, why:string|null, agent:string|null, thread:string|null, project:string|null, at:ms, error?:string}`
  - `error` is present when an approved send failed and the item came back to held.
- **`gate.get {id}`** returns `Brief & {state:"held"|"sending"|"sent"|"rejected", draft:object, final:object|null, diff:{removed:string[],added:string[]}, result:any|null, error:string|null, by:string|null, decided:ms|null}` (`:140-145`).
  - The content to show and edit is `final ?? draft`.
- **Content fields per sender type** (`core/gate/senders.js:191-219`):
  - `gmail` (kind send): `{subject, body, cc?:email[], bcc?:email[], in_reply_to?}`. Summary is `subject`.
  - `http` (send, spend or delete): `{method, url, headers?, body?}`. Summary is `"METHOD url"`. `gate.senders` lists `{name,type,kinds,content,hosts?}` for each sender.
- **`gate.approve {id, edited?, by?}`** (`gate.js:151-176`):
  - `edited` may hold the whole content or only the changed fields. `""` or `null` deletes a field, and `to` (a string or string[]) replaces the destination (`:184-197`).
  - Returns `{id, state:"sent", result}` or `{id, state:"failed", error}`. A failed send is kept held with the edit stored as `final`.
  - Throws `"<id> is already <state>"`.
- **`gate.reject {id, reason?}`** returns `{id, state:"rejected"}` (`:216-223`).
- **`gate.revise {id, edited}`** returns a full `gate.get` (`:204-213`).
- Events:
  - `gate.held {id,kind,via,to,summary,agent,thread,project}` (`:113`)
  - `gate.released {id,kind,via,to,edited:bool,by,agent,thread,project}` (`:166`)
  - `gate.failed {id,via,error}` (`:173`)
  - `gate.revised {id,via,to,by,agent,thread,project}` (`:211`)
  - `gate.rejected {id,kind,via,by,reason}` (`:221`)
  - No event carries the content.

`needs.js:55-56` also reads `sources`, `recalled` and `toName` from `gate.get`. **No server code returns these fields.**

### 2.3 Editable fields (`deck/js/editable.js:21-37, 68-77`)
- `To` comes first, as a comma-separated string that is sent back as `string[]`.
- Then every key of the content, ordered `subject, cc, bcc, method, url, headers, body`, with other keys before `body`.
- String values are edited as text. Anything else is edited as pretty JSON and parsed back with `JSON.parse`.
- Send passes `edited` with **only changed keys**. If nothing changed, `edited` is omitted.
- Button labels: "Send" when kind is send, otherwise "Approve", and "Discard" (`needs.js:57`).

### 2.4 Asks (`core/switchboard/asks.js`, `index.js:710-723`)
- **`threads.asks {thread?}`** returns `Ask[]`, oldest first. `Ask = {id:hex18, thread, tool, summary, destination:string|null, reason:string|null, at:ms, state:"open", decision:null}` (`asks.js:56-59`, with `request_id` stripped at `index.js:712`).
  - There is no `agent`. Join `threads.list` on `thread` to get it.
  - The Deck reads `title`, `command`, `why`, `rule`, `intent` and `details`, which **do not exist**.
- `summary` comes from `describe()` (`translate.js:30-45`): `Bash` → the command; file tools → `"<Tool> <path>"` with destination = path; `WebFetch` → `fetch <url>`; others → `"<tool> <firstKey>: <val>"`. Each is cut to 200 chars.
- **`threads.answer {ask, decision:"allow"|"deny", message?, surface?}`** returns `{ask, answered:true, decision}`, or `{ask, answered:false, note}` if the ask is already answered or the thread stopped (`index.js:522-534`). It needs presence, and the summary is built by `answerSummary` (`:111-117`).
- Events:
  - `ask.raised {thread, ask, tool, summary, destination, reason, holder}` (`:329`)
  - `ask.answered {thread, ask, decision:"allow"|"deny"|"cancelled", by, tool, summary}` (`:437`)

---

## 3. Chat

### 3.1 Projects (`core/projects/index.js`, `projects.js`)
- **`projects.list {}`** returns `{projects:[{slug,name,org,home,workspaces:string[],people:[{name,email?}],watchers,threads:int,picked:int,folder:int,picks:string[],last:ms}], problems:[{home,error}]}` (`projects.js:328-348`).
- **`projects.threads {project, limit=100}`** returns `Session[]` with `how:("picked"|"folder")[]`. A missing pick comes back as `{id,label:id,how:["picked"],missing:true,...zeros}` (`projects.js:217-237`).
  - `Session = {id,name,title,label,cwd,started,last,turns,human:bool,agents:int,folder:slug|null}` (`:179-198`).
- **`projects.catalog {q?,limit=50,human?}`** returns `{total, search:"none"|"said"|"titles", note?, sessions:[Session & {projects:string[], titled?, said?}]}` (`:245-281`).
- **`projects.of {cwd}`** returns `{slug,name,home,folders}` or `null`.

### 3.2 Threads (`core/switchboard/index.js`)
**Thread record** (`:190-197`):
`{id(=Claude session uuid), name, cwd, project, agent, status:"starting"|"working"|"waiting"|"idle"|"stopped", model, auth:"ambient"|"subscription"|"api-key", started, last, cost_usd, turns, holder:string|null, asks:int, stopped_reason?}`

| Tool | Input | Output |
|---|---|---|
| `threads.list` | `{agent?, all?}` | `Record[]`: running threads plus those active in the last 24 h, ≤200 (`:544-550`) |
| `threads.get` | `{thread, since=0, limit=200 (≤1000)}` | `{thread:Record, asks:Ask(with request_id)[], events:[{id,at,type,payload}]}`, where `events` holds the newest `limit`, oldest first (`:553-558`) |
| `threads.start` | `{project?\|cwd?, prompt?, name?, model?, surface?, append?, lean?}` | `Record`. `surface` defaults to the caller string and gets the lease (`:685-688`, `:233-264`) |
| `threads.send` | `{thread, text, surface?}` | `{sent:true,thread}` \| `{sent:false,holder,note}` \| `{sent:false,open_elsewhere:true,note}`. A stopped thread is resumed first (`:484-505`) |
| `threads.lease` | `{thread, surface?}` | `{thread, holder, previous, took?:{from,silent_ms}}`. Always takes the lease (`:507-512`) |
| `threads.release` | `{thread, surface?}` | `{thread, released:bool, holder}` (`:514-519`) |
| `threads.stop` | `{thread}` | `{thread, stopped:bool, note?}` (`:536-542`) |
| `threads.watch` | `{thread, until:"finished"\|"asks"\|"either", notify?, note?}` | `{watch:"w…", fired:bool}`. Fires `thread.watched` once (`:600-608`) |
| `threads.unwatch` | `{watch}` | `{removed:bool}` |

**Lease** (`lease.js`):
- The TTL is **90 s**, and it is renewed only by `threads.lease` or a `threads.send` from the holder (`:20, 36-50`).
- A phone must re-lease at least every 60 s while typing.
- `surface` defaults to the caller string. Over the tailnet that is `"tailnet:<login>"`. **Always pass the same explicit `surface` (e.g. `"ios"`) to lease, send and release.** The Deck mixes an explicit `"deck"` with the default (`deck/views/projects.js:680` vs `:707`).

### 3.3 Thread events (`translate.js:57-126`, `index.js:296-432`)
Every payload also carries `thread`.
- `thread.started {name,cwd,project,agent,headless:true,resumed}`
  - The Harness also emits `thread.started {session,cwd,source}` with source `harness` for terminal sessions (`core/harness/index.js:74`).
- `thread.sent {text(≤2000), surface}`. `surface` is `agent:<name>`, or `null`, when a module typed.
- `thread.text`:
  - partial: `{message:<msg id>, delta}`, throttled to 50 ms. Deltas are **pruned from the log 60 s after the turn finishes** (`:88-95, 670`)
  - final: `{message, text(≤20000), done:true}`. Replace the accumulated deltas with this
  - notice: `{message:"vyre", text, done:true, notice:true}` (`:348,354`)
- `thread.tool`:
  - started: `{id, tool, phase:"started", summary, destination}`
  - done: `{id, phase:"done", error:bool}`
  - **No tool input and no tool output are ever sent.**
- `thread.finished {ok, stop_reason, cost_usd, duration_ms, turns, tokens:{input,output,cache_read,cache_write}, error?}` marks the end of a turn.
- `thread.stopped {code, reason}`. Reasons include `"stopped"`, `"exited"`, `"done"`, `"budget"`, `"vyred restarted"`.
- `thread.limit {status, kind, resets_at, utilization?}`
- `thread.watched {watch, reason:"finished"|"asked"|"stopped", notify, note, by, summary?}`
- `thread.contended {session, holder}` (`claim.js:45`)
- `lease.changed {holder:string|null, previous, took?}`
- `ask.raised`, `ask.answered`, and `gate.*` as in section 2
- There is **no `thread.status` event**. Derive status from these events, or re-read `threads.get`.
- The Harness also emits `tool.held`, `file.touched {session,path,tool}` and `turn.completed {session}`.

### 3.4 How the Deck renders a transcript
- **`deck/views/projects.js:418-548`** (the main thread view):
  - A live thread is loaded with `threads.get`. A recorded one uses `recall.thread {session, limit:400}` and renders `turns[{role,ts,text}]`.
  - Consecutive `thread.tool` lines are grouped into one block (`:462-469`).
  - `phase:"done"` with `error` turns the dot red. No second line is drawn.
  - Tools whose name matches recall/memory get a "Recalled" block (`:551`).
  - `thread.sent` from surface `deck` is dropped, because the Deck already echoed it (`:487`).
  - Asks render inline as a "Held before it ran" card (`:602-631`).
  - The files pane comes from `harness.touched {session,limit:100}` (`:645`).
  - Bug: history events are passed unflattened (`addEvent(ev)` where fields live under `ev.payload`, `:513` vs `:521`), so backlog text is empty. **Flatten `payload` yourself.**
- **`deck/chat/session.js`** (Chat):
  - One bubble per `message` id. Deltas are appended, and `done` replaces them with the markdown text (`:108-121`).
  - Tool chips read "running/done/failed · summary", and only the last 6 are kept (`:123-133, 171-182`).
  - `gate.held`/`gate.revised` render an inline editable card (`gate-item.js`). Its diff comes from `deck/chat/lib/diff.js` over `draft.body` vs `final.body` (`:103`).
  - Memory facts come from `memory.facts {thread, room?, limit:50}` and are placed after turn `refs[].seq` (`:205-221`).
  - There is **no file-edit diff**, since tool input never arrives.
  - `rec.status === "running"` is checked but is never a real value (`:67`).

---

## 4. Agents, Memory, Recall

### 4.1 Agents (`core/agents/index.js`)
- **`agents.list {}`** returns `[{name, kind:"assistant"|"agent", projects:"*"|string[], model, computer:bool, auth:"subscription"|"api-key"|"ambient", status:"new"|<thread status>, doing:"not started"|"waiting on your answer"|"working"|"stopped"|"starting"|"idle", thread:string|null, auth?}]`, assistant first (`:197-206, 173-180`).
  - The second `auth` is the thread's auth and overrides the first when the agent has a thread.
- **`agents.ask {agent, text, surface?, wait?}`** (`:244-289`):
  - `wait:false` returns `{agent, thread, ok:true, sent:true, text:""}` and keeps the lease.
  - Otherwise it waits up to 590 s and returns `{agent, thread, text, ok, cost_usd?, note?, ask?:{id,tool,summary,destination}}`.
  - On refusal it returns `{agent,thread,ok:false,text:"",note}`.
- **`agents.threads {agent}`** returns `threads.list {agent}`, which is `Record[]` (`:291-295`).
- **`agents.usage {agent?, since?}`** returns `[{agent, kind, auth, turns, threads, duration_ms, cost_usd, api_cost_usd, tokens:{input,output,cache_read,cache_write}, by_auth:{<auth>:{turns,duration_ms,cost_usd}}, limit:{status,kind,resets_at,utilization?,at}|null, last_at, budget_usd, spent_usd, left_usd}]`, plus a row `agent:null` for threads no agent ran (`:297-317`, `switchboard/index.js:373-395`).
- **`agents.history {agent?, limit=20 (≤200), before?}`** returns `[{id:<send event id>, at, agent, thread, project, surface, text, answer:string|null}]`, newest last. Page with `before=id` (`switchboard/index.js:566-592`).
- `agents.stop {agent}` returns `{agent, stopped:string[]}`.

### 4.2 Memory (`core/memory/index.js`, `graph.js`, `floor.js`)
Callers: tailnet may read `graph`, `facts`, `why` and `stats`. Tailnet may also `pin`/`mute`, since those guards use `whole:true` (`index.js:132-150, 205-211`).

**Fact** (`graph.js:259-282`):
```
{id:"src|rel|dst", text, subject:{id,label,kind,role}, rel, object:{id,label,kind,role},
 confidence:0..1, since, until, seen, age:"3 weeks", fresh:0..1, stale:bool, seen_age,
 source:string|null, ref:{session,seq,name}|null, evidence:int, taught:[{module,kind}],
 conflict:bool, origin:"extract"|"user"|"confirmed"|…, correction:{id,action,age,note}|null}
```

| Tool | Input | Output |
|---|---|---|
| `memory.facts` | `{about?, project_cwds?, room?\|project?, limit=20 (≤200)}` | `{about:NodeSummary&{pinned,muted}\|null, facts:Fact[]}` (`graph.js:406-466`) |
| `memory.facts` with `thread` | `{thread, room?, limit=50}` | `{thread, room, facts:(Fact&{refs:[{seq}]})[]}` (`:477-499`) |
| `memory.graph` | `{project_cwds?, room?, around?, depth?, limit=150, since?}` | `{updated, unchanged:true}` \| `{updated, scope:"main"\|"project", rooms:[{id,kind,label,slug,folders,nodes,facts}], nodes:[{id,kind,label,weight,pinned,muted,role,room,rooms,last}], edges:[{id,src,rel,dst,confidence,since,until,learned,taught,conflict}], counts:{nodes,facts,drawn}, truncated}` (`floor.js:29-215`) |
| `memory.why` | `{fact (id or name), limit=10 (≤50), room?}` | `{fact:Fact\|NodeSummary\|null, turns:[{session,seq,name,role,ts,age,text(≤400)}], taught:[{module,kind,key,text,at,age}], corrections:[…], gone:int}` (`graph.js:634-687`) |
| `memory.pin` / `memory.mute` | `{node, scope="*"\|<folder>, off?}` | `{node, label, scope, mode:"pin"\|"mute"\|null}` (`graph.js:749-757`) |
| `memory.relevant` | `{text, limit=5, project_cwds?, room?}` | `[{id,text,matched,confidence,age,seen,fresh,source,ref,score}]` (`graph.js:~622`). Tailnet is not in its guard's reader set, so the main graph is refused over tailnet unless `room` is given |
| `memory.stats` | `{}` | counts (`graph.js:759-777`) |

`NodeSummary = {id,label,kind,role,sessions,mentions,first,last,age}`.

Deck usage:
- `memory.js:156-161`: graph then facts, with `{room:slug}` when a project is chosen. It polls with `since=<updated>`.
- `memory.js:330-335`: pin/mute with `scope=<first project folder>|"*"`.
- `memory.js:486, 586`: why and about.
- Redraws on `memory.curated`.

### 4.3 Recall (`core/recall/index.js:156-175`, `search.js`)
- **`recall.search {q, limit=10 (≤100), project_cwds?, role?, hybrid?, per_session=3}`** returns `Hit[]`, the array itself (`index.js:167`).
  - `Hit = {session, seq, role, ts, text, snippet (keyword hits bracket matches with «»), score, name, title, cwd}` (`search.js:237-245`).
- **`recall.thread {session (or a unique prefix), from=0, limit=200 (≤2000)}`** returns `{session:<raw recall_sessions row>, turns:[{seq,role,ts,text}]}` (`search.js:255-265`).

---

## 5. Files (`core/files/index.js`)
Over the tailnet the phone reaches the **box's** files module (roles box+local). There, `source` is always `"box"`, and the default root is `/work` (`:64-71`).

- **`files.search {q, limit=50 (≤500), kinds?, where?}`** returns `{results:[{source,path,name,kind,size,mtime:ISO}], sources:[{source,ok,count,note?,error?}]}` (`:166-188`).
  - `kinds` ⊂ `folder,text,code,image,pdf,doc,audio,video,archive,other` (`kinds.js:10`).
- **`files.stat {path, source?}`** returns `{source,path,name,kind,size,mtime,mime,dir}` (`:190-198`).
- **`files.preview {path, source?, max≤262144}`** returns one of (`:216-246`):
  - image: `{source,path,kind:"image",mime,base64|null,thumbnail:bool,size,note?}`. The thumbnail is 512 px.
  - text/code: `{source,path,kind,mime,text,truncated,size}`.
  - anything else: `{source,path,kind,mime,size,preview:null}`.
- **`files.fetch {path, offset=0, length≤1 MiB}`** called on the machine that holds the file returns **one base64 chunk**: `{source,path,size,mtime,offset,length,base64,done}` (`:249-264, 301-310`).
  - There is **no ticket and no byte route**. A phone loops over offsets, checks that `size` and `mtime` stay stable, and base64-decodes each chunk.
  - `source:"box"` from a Mac pulls the file into `~/.vyre/files/fetched/…` and returns `{source,path,local,size,mtime}` (`:267-299`). A phone never gets this path.
- `link.call {tool, input}` (`core/link/mac.js:197-205`) exists **only on a Mac** and calls the box. It forbids `link.*`. On the box the link tools are the pairing side. **A phone cannot reach the Mac at all.** There is no path box→Mac: "the box cannot reach files on the Mac" (`files/index.js:79`).
  - A Mac also proxies box events at `GET /v1/link/events`, adding `source:"box"` plus `event: link.down` / `link.up` frames (`mac.js:207-254`).

---

## 6. Vault

- **`vault.list {filter?, kind?, host?}`**, no callers restriction, returns `{locked:bool, keystore, personal:"none"|"locked"|"unlocked", items:[{name,kind,description,fields:string[],url?,hosts:string[],rotate,why?,origin?,updated,vault,grants:[{module,watcher?}],ssh?,stale?,staleWhy?}]}`. It is **not names only**: it includes field names, hosts and grants. No values (`vault.js:932-946`, `tools/cli.js:67-80`).
- **`vault.item {name}`** returns `{item: <list item> & {otp:bool}}` (`tools/cli.js:116-123`).
- **`vault.search {q, limit=8}`** returns `{rows:[{id,name,kind,sub}]}` (`surfaces.js:222-238`).
- **`vault.reveal {name, field?, session?, version?}`** returns `{value, concealAfter:30}` (`surfaces.js:167-189`).
  - Default fields: secret/api-key→`value`, login→`password`, card→`number`, note→`text`.
- **`vault.copy {name|id, field?, session?, version?}`** copies to **the Mac's/box's clipboard** and returns `{copied:true, clearsAt, said, warning?}`. It is not useful on a phone (`:191-219`).
- **`vault.totp {name|id, session?}`** returns `{code, period, remaining}` (`vault/index.js:196-210`).
- **Two unrelated "sessions":**
  1. `vault.session.open {surface:"deck"|"capsule"|"extension", ttl_s?}` (the enum has no `ios`/`android`; the phone uses option 2) returns `{session:<token>, expires, surface}` (`surfaces.js:132-143`, `session.js:100-114`). It is HUMAN_ONLY and callers PEOPLE. Its token goes in the tools' `session` **input**. The registry's floor ignores that token: the `skip` in the vault's own `prove.js` runs only after the floor has already demanded a proof, so the vault session **does not** save a passkey per reveal.
  2. `presence.session.open {}` returns `{session, secret, expires:ms(created+30min), idle:300000}` (`presence/module.js:64-72`, `index.js:420-428`).
     - It needs a strong proof (Touch ID, capsule, device or passkey) on the opening call. **The phone opens it with a device proof.**
     - It is bound to the tailnet node (`peer.stableId`).
     - Use it as `x-vyre-presence: session id=<session> secret=<secret>`. It works only for `vault.reveal/copy/totp` on non-reprompt items (`index.js:385-396`).
     - It has no callers list, so it works over tailnet.
     - `presence.session.close {session}` returns `{closed:bool}`.
     - **Nothing in the Deck or Capsule uses it.** `deck/vault/client.js:50-72` uses only option 1.

---

## 7. Push (`core/push/`)

- Manifest: tools `push.key, push.subscribe, push.unsubscribe, push.devices, push.settings, push.test`. Needs vault item `push-vapid` (`module.json`).
- All tools have callers `cli, local, deck, capsule, tailnet` (`index.js:27,131`), so the phone may call them. Native transports (`apns`, `fcm`) are not in yet; section 0.2.

| Tool | Input | Output |
|---|---|---|
| `push.key` | `{}` | `{public_key:<b64url raw P-256>}` |
| `push.subscribe` | `{subscription:{endpoint, keys:{p256dh(65B uncompressed), auth(16B)}, expirationTime?}, label?}` | `{device:<12-char id = sha256(endpoint)>}` (`:141-149`) |
| `push.unsubscribe` | `{device}\|{endpoint}` | `{removed:bool}` |
| `push.devices` | `{}` | `[{device,label,service:<hostname>,at,last_ok,fails}]` |
| `push.settings` | `{quiet?:{start:"HH:MM",end:"HH:MM",timezone?}\|null, kinds?:{ask?,draft?,watch?,lesson?:bool}}` | `{quiet, kinds, quiet_now}` |
| `push.test` | `{device?}` | `{sent, failed, dropped}` (ignores quiet hours) |

- **Subscription row** (`:17-21`): `push_devices(id, endpoint UNIQUE, p256dh, auth, label, by=<caller>, at, expires, last_ok, fails)`.
- **Host allowlist** (`:23, 94-99`): `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `push.apple.com`, `notify.windows.com`, plus any subdomain of each, plus `config.push.hosts`. The endpoint must be https unless `push.allow_http`.
- **What triggers a send** (`:33-41, 116-126`). Each is skipped if its kind is off, in quiet hours, or when no devices exist:
  - `ask.raised` → `{kind:"ask", title:"A session is waiting for your answer", path:"/needs/<ask>", tag:"ask-<ask>"}`
  - `gate.held` → `{kind:"draft", title:"Something is waiting for your approval", path:"/needs/<id>", tag:"draft-<id>"}`
  - `thread.watched` → `{kind:"watch", title by reason, path:"/threads/<thread>", tag:"watch-<watch>"}`
  - `lesson.proposed` → `{kind:"lesson", path:"/settings?section=lessons", tag:"lesson-<lesson>"}`
- Payload sent: `{kind,title,path,tag,at}`. It is JSON, encrypted aes128gcm with VAPID, with `ttl=86400` and `urgency` high for ask/draft, normal otherwise (`webpush.js:78-88`, `index.js:108`).
- The only variable part of a payload is an id. The client fetches details after the tap.
- Deep links:
  - `/needs/<id>`: look the id up in `gate.held` or `threads.asks`.
  - `/threads/<id>`: open with `threads.get`.
- **Where APNs/FCM-native plugs in:** in `deliver()` (`index.js:103-114`), which calls `send()` from `webpush.js:78` for each row. Changes needed:
  - a `transport` column (`webpush` | `apns` | `fcm`) with a device-token field in `push_devices`
  - `check()` (`:94-100`) must accept `{transport:"apns", token, bundle, env}`, since today it requires `endpoint` + P-256 keys + an allowlisted host
  - `deliver()` branches to an APNs HTTP/2 or FCM v1 sender that returns the same `{ok, status, gone}` (410/404 or `BadDeviceToken`/`Unregistered` → `gone`)
  - `NOTES` and `settings` can stay as they are
  - The APNs .p8 or FCM service account should live in the vault the way `push-vapid` does (`:72-86`)
  - Without that, iOS 16.4+ can only use Web Push (`web.push.apple.com`, which is allowed) from a home-screen PWA, not from a native app.

---

## 8. Presence enrollment

- **`presence.enroll {kind:"capsule"|"passkey"|"device", name?, public_key:<b64url SPKI DER>, alg?, rp_id?, credential_id?}`** (`presence/module.js:27-44`, `index.js:454-477`):
  - capsule: the key must be Ed25519. The id is the first 22 chars of base64url(sha256(DER)), and `alg=-8`.
  - device: the key must be EC P-256 (`prime256v1`) and `alg` must be exactly `-7`; anything else is refused. The id is the fingerprint, as for capsule. There is no rp_id (one sent is dropped). The phone sends exactly `{kind:"device", name, public_key, alg:-7}`, nothing more, since a passkey proof is bound to that input.
  - passkey: `credential_id` must match `[A-Za-z0-9_-]{8,1024}`; that value becomes the key id. `rp_id` must match `[a-z0-9.-]+`. `alg` is one of `-7` (EC), `-8` (Ed25519) or `-257` (RSA), and must fit the key type.
  - **rp_id check on the box** (`module.js:34-39`): `rp_id.toLowerCase()` must equal `new URL(config.network.address).hostname`. Otherwise the call throws "a passkey here must be for <host>". Capsule keys have no rp_id check.
  - Returns `{id, kind, name, created}`. Emits `presence.enrolled {id,kind,name}`. Duplicates are refused.
  - Proof: the first key comes via `code code=<code>`, where the code comes from `presence.code` (`{code, expires}`, 8 chars, 10 min) or `vyre presence code`. On the box that proof must come from `tailnet:<owner>`. After that, any existing proof method works.
- **`presence.keys {}`** returns `[{id, kind, name, created, last_used}]`, with no public keys (`index.js:446-448`).
- `presence.remove {id}` returns `{removed:id}`.
- **Deck enrollment path**:
  - `deck/views/settings.js:519-559` and `deck/onboard/passkey/passkey.js:55-72` call `navigator.credentials.create` with rp `{id: location.hostname}`, algs `[-7,-257]` and UV required.
  - Then `callWithCode("presence.enroll", {kind:"passkey", name, public_key:getPublicKey(), alg:getPublicKeyAlgorithm(), rp_id:location.hostname, credential_id:rawId}, code)` (`deck/js/api.js:89-100`).
  - That sends `x-vyre-caller: deck` and `x-vyre-presence: code code=<code>`.
- **Native implications:**
  - A native passkey for the box hostname needs Associated Domains / Digital Asset Links. vyred serves no `/.well-known/apple-app-site-association` or `assetlinks.json`; unknown paths return the Deck's index.html (`daemon/index.js:283-291`).
  - The ready path today is a **`capsule` Ed25519 key**: the private key in Keychain/Keystore behind a biometric gate, enrolled once with the code, and signing `vyre-presence-v1\n…` for each call.
  - Note: the Secure Enclave has no Ed25519 support. So the phone uses a **`device` P-256 key** instead (ADR 0018 section 3).
- **Phone enrollment path: `/onboard/device`** (`deck/onboard/device/`):
  - The app opens `https://<address>/onboard/device#k=<b64url SPKI>&n=<device name>&r=vyre` in `ASWebAuthenticationSession` / Custom Tabs, with callback scheme `vyre`. `r` must be exactly `vyre` or the page stops and returns nowhere. A missing or malformed `k` also stops it. `n` is cleaned (control and bidi characters), cut to 80 characters, and defaults to "This phone". The page strips the hash at once.
  - With a passkey on the box: `POST /v1/presence/challenge {tool:"presence.enroll", input:{kind:"device", name, public_key, alg:-7}, method:"passkey"}`, `navigator.credentials.get`, then `presence.enroll` with the passkey header.
  - With no passkey on the box (the challenge answers 400 `bad_input`), or a browser with no WebAuthn: the page asks for the one-time code from `vyre presence code` and sends `code code=<code>`, as the first-passkey page does.
  - Success: navigates to `vyre://enrolled?id=<key id>`. Cancel (the Cancel button, or a cancelled passkey sheet): `vyre://enrolled?error=cancelled`. Any other failure stays on the page with the message; closing the sheet is a cancel for the app.

---

## 9. Capsule search box (`local/capsule/`)

Everything runs over the Mac's unix socket with caller `capsule`. It is not reachable from a phone.

- **Catalog on open** (`lib/bridge.js:117-128`): `agents.list`, `projects.list`, `projects.catalog {limit:30, human:true}`, `threads.list`, then `projects.threads {project, limit:20}` for each project.
- **Each keystroke** (`lib/launcher.js:108-181`):
  - Local only: calculator, contacts, a dictionary for "define x", clipboard history, apps and settings, Glass rows.
  - Drive rows: `^(tell|ask) (the)? X (thread)? to Y$` makes `{kind:"drive", label:"Tell <thread>: Y"}` (`:122-126`).
  - Watch rows: `watch|monitor|track X` or `tell|ping|notify me when X is done|finishes|asks` make `{kind:"watch"}` (`:129-133`, `watch.js:132-137`).
  - `full()` adds Spotlight files, **`files.search {q, where:"box", limit:20}`** if `link.status.linked` (checked every 30 s, box timeout), and module providers.
  - Module providers come from `shows.capsule` `results:<tool>`, fetched with `{q, limit:5}` and a 600 ms timeout (`providers.js:156-167`). Today the only provider is the vault: `results:vault.search`, with actions `vault.fill.native`, `vault.copy` (±`field:username|totp`) and `vault.totp`.
- **Memory preview for a question** (`bridge.js:201-240`): `memory.relevant {text, limit:3}` and `recall.search {q:text, limit:3, per_session:1}` run in parallel. `recall.thread {session, from:seq-1, limit:3}` fetches the source.
- **Enter / destination** (`lib/route.js:129-174`, `bridge.js:280-350, 370-380`):
  - no `@`, text is a question (`?` or a question word), and `threads.start` exists: `threads.start {prompt, append:QUICK_APPEND, lean:true, model:"haiku"|"sonnet", cwd:<~/.vyre/capsule/ask>, surface:"capsule", name:"Capsule: …"}`, unless it is about the user's own things (`ownThings`), which goes to the assistant.
  - no `@`, otherwise: the assistant, via `agents.ask {agent, text, surface:"capsule", wait:false}`. With no assistant, the destination is "memory".
  - `@agent`: `agents.ask …wait:false`. If the words match the name of one of that agent's threads (from `agents.threads`), that thread is offered first (`threads.send`).
  - `@project`: the best thread match by words, otherwise `threads.start {project, cwd:home, prompt, surface:"capsule"}`.
  - `@thread`: `threads.send {thread, text, surface:"capsule"}`. ⌘⏎ takes the lease first (`threads.lease {surface:"capsule"}`).
- **Drive** (`app/capsule.js:198-206`): `threads.send`, then watch.
- **Watch** (`app/main.js:363-364`): `threads.watch {thread, until:"either", notify:"capsule", note:<label>}`. There is also a local fallback that filters the stream (`watch.js`).
- **Needs panel** (`bridge.js:448-525`):
  - reads `gate.held`, `threads.asks`, `learn.lessons {status:"proposed"}`, `gate.get`
  - answers with `gate.approve {id, edited?}`, `gate.reject`, `threads.answer {ask, decision, surface:"capsule"}`, `learn.accept`/`learn.retire {id}`
  - **with no presence header**, so these calls return `presence_required` (`bridge.js:687-696` admits this for lessons).

---

## 10. Test world (`apps/test/world.js`)

`node apps/test/world.js [port]` (default 4800, `0` picks one) prints `mobile world: http://127.0.0.1:<port>/  (home <dir>)` and runs until SIGINT/SIGTERM, then removes its temp home. It is a real vyred with role `box` (`network.owner` `alex@example.com`, `network.address` `https://vyre.example.ts.net`), the Deck world's corpus, two projects and two held Gate items. Every proxied request reaches vyred's router as caller `tailnet:alex@example.com` with peer `{node:"alex-phone", stableId:"nTEST", login:"alex@example.com"}`, and the names listener's checks apply (a non-JSON POST, or one with a foreign `Origin`, is 403). Nothing leaves the machine: both Gate senders point at a fake server on 127.0.0.1, with fake credentials, so an approval really sends, to it. A fake `claude` runs threads.

Test-only endpoints, answered by the proxy itself (POST, JSON):
- `/__test/code` → `{data:{code, expires}}`, a one-time presence code for enrolling a device key with `code code=<code>`.
- `/__test/hold` (optional body: a `gate.request` input) → `{data:{id, state:"held", ...}}`.
- `/__test/ask` → `{data:{thread, ask}}`, a thread whose fake claude is waiting on a Write permission.
- `/__test/outbox` → `{data:[{at, method, path, body}]}`, what the Gate sent to the fake servers.

