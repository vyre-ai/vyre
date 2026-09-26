# Chat: one-time Mattermost setup

`compose.yml` starts Mattermost with open sign-up off, so nobody can create the first account
from a browser. These steps make the owner, the team, the bot and the `/vyre` command through
`mmctl --local`, which talks to Mattermost over a socket inside the container and needs no login.
They are written so a later `vyre chat setup` can run them as they are.

Run from the box, in the folder holding the compose:

```sh
mm() { docker compose exec -T mattermost mmctl --local "$@"; }
```

## 1. The owner and the team

```sh
read -rs -p "Password for alex: " PW; echo
mm user create --email alex@example.com --username alex --password "$PW" --system-admin; unset PW
mm team create --name vyre --display-name "Vyre" --private
mm team users add vyre alex
```

## 2. The bot, and its token into the Vault

The bot posts every thread, ask and held draft. Its token goes straight from mmctl into the
Vault through a pipe, so it never lands on screen or in shell history.

```sh
mm bot create vyre --display-name "Vyre" --description "Your Claude Code sessions"
mm team users add vyre vyre
mm --json token generate vyre vyred \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[0]?.token ?? JSON.parse(s).token))' \
  | vyre vault put chat-bot-token --kind api-key --description "Mattermost bot token for Chat"
vyre vault grant chat-bot-token chat
```

## 3. The `/vyre` command, and its token into the Vault

Mattermost signs each slash request with a token; Chat compares it before doing anything.

```sh
mm --json command create vyre --title "Vyre" --trigger-word vyre \
  --url http://vyred:8766/chat/slash --method P --creator alex \
  --autocomplete --autocompleteHint "held | send <id> | discard <id> | new <prompt>" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))' \
  | vyre vault put chat-slash-token --kind api-key --description "Mattermost /vyre command token"
vyre vault grant chat-slash-token chat
```

## 4. Tell vyred where Mattermost is

In `~/.vyre/config.json`:

```json
{ "chat": {
    "url": "http://mattermost:8065",
    "team": "vyre",
    "owner": "alex",
    "listen": { "host": "0.0.0.0", "port": 8766 },
    "callback": "http://vyred:8766",
    "poll_ms": 2000 } }
```

`url` is how vyred reaches Mattermost (`http://127.0.0.1:8065` when vyred runs on the host).
`callback` is how Mattermost reaches vyred, and its host must be in
`AllowedUntrustedInternalConnections` in `compose.yml`. Then `vyre down && vyre up`, and
`vyre call chat.status` says whether Chat is connected.
