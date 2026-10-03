// Command wink-forwarder joins a space's network as a tsnet node and hands every accepted peer
// connection to vyred on its own Unix socket, with the peer's identity attached by this program.
//
// Why it exists (EC-1): a userspace tailscaled forwards inbound connections to 127.0.0.1, so a plain
// forwarded connection arrives as a loopback caller and loses who it came from. Here the node
// itself accepts the connection, asks its own LocalAPI who the remote address is (WhoIs), and
// writes a length-prefixed header with the node key before the first byte of the peer's stream.
// The receiver (core/wink/node/peer-channel.js) never reads identity from the stream or the
// source address; a connection WhoIs cannot name is closed here and never reaches vyred.
//
// Framing, written once, before any peer byte, on the Unix socket:
//
//	magic   4 bytes  "WKH1"
//	length  4 bytes  big endian, 1..4096
//	header  length bytes of UTF-8 JSON {"v":1,"nodeKey","stableId","tags","remoteAddr"}
//	stream  the peer's bytes, verbatim, both directions
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

const magic = "WKH1"

// maxHeader bounds the JSON header; the receiver enforces the same limit.
const maxHeader = 4096

// Header is the identity the forwarder attaches. Every field comes from WhoIs, never from the peer.
type Header struct {
	V          int      `json:"v"`
	NodeKey    string   `json:"nodeKey"`
	StableID   string   `json:"stableId"`
	Tags       []string `json:"tags"`
	RemoteAddr string   `json:"remoteAddr"`
}

// EncodeHeader returns magic + length + JSON for h.
func EncodeHeader(h Header) ([]byte, error) {
	if h.Tags == nil {
		h.Tags = []string{}
	}
	body, err := json.Marshal(h)
	if err != nil {
		return nil, err
	}
	if len(body) == 0 || len(body) > maxHeader {
		return nil, fmt.Errorf("header size %d out of range", len(body))
	}
	out := make([]byte, 8, 8+len(body))
	copy(out, magic)
	binary.BigEndian.PutUint32(out[4:8], uint32(len(body)))
	return append(out, body...), nil
}

type listenMap []string

func (l *listenMap) String() string     { return strings.Join(*l, ",") }
func (l *listenMap) Set(v string) error { *l = append(*l, v); return nil }

var outMu sync.Mutex

// emit writes one JSON event line to stdout. It never carries a key or a secret.
func emit(ev map[string]any) {
	outMu.Lock()
	defer outMu.Unlock()
	b, _ := json.Marshal(ev)
	fmt.Println(string(b))
}

func main() {
	var (
		stateDir   = flag.String("state-dir", "", "private state directory (created 0700)")
		controlURL = flag.String("control-url", "", "control URL, normally the local pinning shim http://127.0.0.1:PORT")
		keyFile    = flag.String("auth-key-file", "", "file holding a single-use pre-auth key, mode 0600; deleted after the node is up")
		hostname   = flag.String("hostname", "wink-home", "node hostname")
		dialSock   = flag.String("dial-sock", "", "optional Unix socket for outbound dials: a client writes {\"addr\":\"100.x.y.z:port\"}\\n and then speaks to that tailnet address")
		dialWait   = flag.Duration("dial-timeout", 30*time.Second, "how long an outbound dial may take before it fails")
		verbose    = flag.Bool("verbose", false, "send tsnet's own log to stderr")
		maps       listenMap
	)
	flag.Var(&maps, "listen", "PORT=/path/to/peer.sock (repeatable): accept tailnet connections on PORT and forward them to the Unix socket")
	flag.Parse()
	// A self-hosted network must not report to anyone: tsnet uploads logs to Tailscale unless this is set (spike, 3 Oct 2026).
	os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	if *stateDir == "" || *controlURL == "" || (len(maps) == 0 && *dialSock == "") {
		fmt.Fprintln(os.Stderr, "usage: wink-forwarder -state-dir D -control-url URL [-auth-key-file F] -listen PORT=SOCK ...")
		os.Exit(2)
	}
	os.Unsetenv("TS_AUTHKEY")
	os.Unsetenv("TS_AUTH_KEY")

	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		fatal("state dir", err)
	}
	if err := os.Chmod(*stateDir, 0o700); err != nil {
		fatal("state dir mode", err)
	}
	authKey := ""
	if *keyFile != "" {
		st, err := os.Stat(*keyFile)
		if err == nil && st.Mode().Perm()&0o077 != 0 {
			fatal("auth key file", errors.New("must not be readable by group or others"))
		}
		if err == nil {
			b, rerr := os.ReadFile(*keyFile)
			if rerr != nil {
				fatal("auth key file", rerr)
			}
			authKey = strings.TrimSpace(string(b))
		}
		// A missing key file is fine on a restart: the node is already enrolled in the state dir.
	}

	targets := map[int]string{}
	for _, m := range maps {
		p, sock, ok := strings.Cut(m, "=")
		port, err := strconv.Atoi(p)
		if !ok || err != nil || port < 1 || port > 65535 || sock == "" {
			fatal("listen", fmt.Errorf("bad mapping %q", m))
		}
		targets[port] = sock
	}

	logf := func(string, ...any) {}
	if *verbose {
		logf = func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }
	}
	srv := &tsnet.Server{Dir: *stateDir, Hostname: *hostname, ControlURL: *controlURL, AuthKey: authKey, Logf: logf, UserLogf: logf}
	defer srv.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	upCtx, upCancel := context.WithTimeout(ctx, 90*time.Second)
	st, err := srv.Up(upCtx)
	upCancel()
	if err != nil {
		fatal("up", err)
	}
	if *keyFile != "" {
		_ = os.Remove(*keyFile) // EC-4: the key is gone as soon as it has been used
	}
	lc, err := srv.LocalClient()
	if err != nil {
		fatal("local client", err)
	}
	if err := enforcePrefs(ctx, lc); err != nil {
		fatal("prefs", err)
	}
	go watchPrefs(ctx, lc)

	var wg sync.WaitGroup
	if *dialSock != "" {
		dl, err := listenDial(*dialSock)
		if err != nil {
			fatal("dial socket", err)
		}
		wg.Add(1)
		go func() { defer wg.Done(); serveDial(ctx, dl, srv.Dial, *dialWait) }()
	}
	for port, sock := range targets {
		ln, err := srv.Listen("tcp", ":"+strconv.Itoa(port))
		if err != nil {
			fatal("listen", err)
		}
		wg.Add(1)
		go func(ln net.Listener, sock string) {
			defer wg.Done()
			go func() { <-ctx.Done(); ln.Close() }()
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				go handle(ctx, lc, c, sock)
			}
		}(ln, sock)
	}
	ips := []string{}
	for _, ip := range st.TailscaleIPs {
		ips = append(ips, ip.String())
	}
	emit(map[string]any{"event": "ready", "nodeKey": st.Self.PublicKey.String(), "stableId": string(st.Self.ID), "ips": ips})
	<-ctx.Done()
	wg.Wait()
}

func fatal(what string, err error) {
	emit(map[string]any{"event": "error", "what": what, "error": err.Error()})
	fmt.Fprintf(os.Stderr, "wink-forwarder: %s: %v\n", what, err)
	os.Exit(1)
}

// handle names the peer through WhoIs, or closes it. Nothing reaches the Unix socket unnamed.
func handle(ctx context.Context, lc whoIsClient, c net.Conn, sock string) {
	defer c.Close()
	remote := c.RemoteAddr().String()
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	w, err := lc.WhoIs(wctx, remote)
	if err != nil || w == nil || w.Node == nil || w.Node.Key.IsZero() || w.Node.StableID == "" {
		emit(map[string]any{"event": "refused", "reason": "no whois", "remoteAddr": remote})
		return
	}
	hdr, err := EncodeHeader(Header{V: 1, NodeKey: w.Node.Key.String(), StableID: string(w.Node.StableID), Tags: w.Node.Tags, RemoteAddr: remote})
	if err != nil {
		emit(map[string]any{"event": "refused", "reason": "header", "remoteAddr": remote})
		return
	}
	u, err := net.DialTimeout("unix", sock, 3*time.Second)
	if err != nil {
		emit(map[string]any{"event": "refused", "reason": "receiver unreachable", "remoteAddr": remote})
		return
	}
	defer u.Close()
	if _, err := u.Write(hdr); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	pipe := func(dst, src net.Conn) {
		io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go pipe(u, c)
	go pipe(c, u)
	<-done
	<-done
}

// enforcePrefs pins the node's prefs to the safe set (EC-9) and fails if the control plane
// already moved them.
func enforcePrefs(ctx context.Context, lc prefsClient) error {
	mp := &ipn.MaskedPrefs{
		Prefs: ipn.Prefs{RouteAll: false, CorpDNS: false, RunSSH: false, ShieldsUp: false},
		RouteAllSet: true, CorpDNSSet: true, RunSSHSet: true,
		ExitNodeIDSet: true, ExitNodeIPSet: true, AdvertiseRoutesSet: true,
	}
	if _, err := lc.EditPrefs(ctx, mp); err != nil {
		return err
	}
	return checkPrefs(ctx, lc)
}

func checkPrefs(ctx context.Context, lc prefsClient) error {
	p, err := lc.GetPrefs(ctx)
	if err != nil {
		return err
	}
	var bad []string
	if p.RouteAll {
		bad = append(bad, "RouteAll")
	}
	if p.CorpDNS {
		bad = append(bad, "CorpDNS")
	}
	if p.RunSSH {
		bad = append(bad, "RunSSH")
	}
	if p.ExitNodeID != "" || p.ExitNodeIP.IsValid() {
		bad = append(bad, "ExitNode")
	}
	if len(p.AdvertiseRoutes) > 0 {
		bad = append(bad, "AdvertiseRoutes")
	}
	if len(bad) > 0 {
		return fmt.Errorf("prefs drift: %s", strings.Join(bad, ","))
	}
	return nil
}

// watchPrefs re-checks once a minute, re-applies the safe set and reports any drift.
func watchPrefs(ctx context.Context, lc prefsClient) {
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := checkPrefs(ctx, lc); err != nil {
				emit(map[string]any{"event": "drift", "error": err.Error()})
				_ = enforcePrefs(ctx, lc)
			}
		}
	}
}
