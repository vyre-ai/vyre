# wink-forwarder

The Wink home's peer door. It joins a space's network as a `tsnet` node and hands every accepted
peer connection to vyred on a Unix socket of its own, with the peer's identity attached by this
program (spec 4.7 and 5.4, EC-1).

Why a program and not a plain port forward: a userspace tailscaled delivers inbound connections to
127.0.0.1, so a forwarded connection arrives as a loopback caller and the node it came from is
lost. Here the node accepts the connection itself, asks its own LocalAPI `WhoIs` for the remote
address, and writes the node key before the first byte of the peer's stream. A connection `WhoIs`
cannot name is closed here and never reaches vyred.

## Build

Go 1.27 or newer. The only dependency is `tailscale.com` (pinned in `go.mod` to the same version as
the core binary, v1.102.4). From this folder:

    go build -o wink-forwarder .
    go vet ./... && go test ./...

The module cache is the standard Go one; on testbox the spike's cache can be reused with
`GOPATH=$HOME/spike-wink/gopath GOCACHE=$HOME/spike-wink/gocache`. The binary is a build output:
do not commit it. Cross-compile with `GOOS=linux GOARCH=amd64` and the same line.

## Run

    wink-forwarder -state-dir DIR -control-url URL -auth-key-file FILE -hostname NAME \
                   -listen 8443=/run/vyre/wink/peer.sock [-listen PORT=SOCK ...]

- `-state-dir` is created 0700 and holds the node key. A restart reuses it and needs no key.
- `-control-url` is the Wink pinning shim (`core/wink/node/shim.js`), `http://127.0.0.1:<port>`.
- `-auth-key-file` is a single-use pre-auth key, mode 0600 (the program refuses a wider file). It is
  deleted as soon as the node is up (EC-4). Never pass a key on the command line.
- `-listen PORT=SOCK` accepts tailnet connections on PORT and forwards them to SOCK, which
  `core/wink/node/peer-channel.js` listens on (0600, in a 0700 directory). Each port gets its own socket.

Standard output carries one JSON event per line and never a key or a secret: `ready` (with the
node's own key, id and addresses), `refused` (`no whois`, `header`, `receiver unreachable`) and
`drift` (a pref moved). A fatal error prints `{"event":"error",...}` and exits 1.

The node's prefs are forced to the safe set at start and re-checked every 60 seconds: no subnet
routes, no DNS settings, no SSH, no exit node, no advertised routes (EC-9). A drift is reported and
re-applied. A tsnet node has no Taildrop storage.

## Framing

Written once on the Unix socket, before any peer byte:

    magic   4 bytes   "WKH1"
    length  4 bytes   unsigned big endian, 1 to 4096
    header  length bytes of UTF-8 JSON
            {"v":1,"nodeKey":"nodekey:<64 hex>","stableId":"<node id>","tags":["tag:..."],"remoteAddr":"100.x.y.z:port"}
    stream  the peer's bytes, verbatim, both directions

Every header field comes from `WhoIs`, none from the peer. The receiver refuses a connection with
no magic, a bad length, anything but exactly those five fields, a node key, id or tag of the wrong
shape, an address outside the tailnet ranges (loopback included), or no header within two seconds.
Bytes after the header are the peer's and are passed on untouched.
