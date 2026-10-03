package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"time"
)

// dialer is the one thing the outbound door needs from the node: tsnet.Server.Dial, which is bound to
// that node's own network. A package-level dial or the default route would leave the space (SPIKE-wink
// section 3), so main passes the Server's method and tests pass a fake.
type dialer func(ctx context.Context, network, addr string) (net.Conn, error)

// dialRequest is the one line a local client writes on the dial socket.
type dialRequest struct {
	Addr string `json:"addr"`
}

// maxDialLine bounds that line.
const maxDialLine = 512

// listenDial opens the dial socket: 0600 in a 0700 directory, like the peer sockets.
func listenDial(path string) (net.Listener, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	_ = os.Chmod(dir, 0o700)
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return ln, nil
}

// serveDial accepts local clients: each writes {"addr":"100.x.y.z:port"}\n, gets {"ok":true}\n or
// {"ok":false,"error":"..."}\n, and then the connection is the tailnet connection, bytes verbatim.
// Only tailnet addresses are dialled, so the socket is never a general proxy. If the client goes
// away while the dial is still in progress the dial is cancelled (tsnet's own dial takes 25 s to
// fail when no path exists, and the application races it against the relay).
func serveDial(ctx context.Context, ln net.Listener, dial dialer, timeout time.Duration) {
	go func() { <-ctx.Done(); ln.Close() }()
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go handleDial(ctx, c, dial, timeout)
	}
}

func reply(c net.Conn, ok bool, why string) {
	m := map[string]any{"ok": ok}
	if why != "" {
		m["error"] = why
	}
	b, _ := json.Marshal(m)
	c.Write(append(b, '\n'))
}

func handleDial(ctx context.Context, c net.Conn, dial dialer, timeout time.Duration) {
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReaderSize(c, maxDialLine)
	line, err := br.ReadSlice('\n')
	if err != nil {
		reply(c, false, "no request")
		return
	}
	var req dialRequest
	if json.Unmarshal(line, &req) != nil {
		reply(c, false, "bad request")
		return
	}
	ap, err := netip.ParseAddrPort(req.Addr)
	if err != nil || !tailnetAddr(ap.Addr()) {
		reply(c, false, "not a tailnet address")
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	dctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// Watch the client while dialling: nothing may arrive before the answer, so a read that returns
	// at all means it gave up (EOF) or broke the protocol.
	gone := make(chan struct{})
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		var b [1]byte
		_, _ = br.Read(b[:])
		select {
		case <-gone:
		default:
			cancel()
		}
	}()
	t, err := dial(dctx, "tcp", ap.String())
	if err != nil {
		reply(c, false, err.Error())
		return
	}
	defer t.Close()
	// Stop the watcher before the answer: it is blocked in a read on c, so wake it with a deadline in the past.
	close(gone)
	_ = c.SetReadDeadline(time.Now())
	<-watched
	_ = c.SetReadDeadline(time.Time{})
	if dctx.Err() != nil {
		return
	}
	reply(c, true, "")
	done := make(chan struct{}, 2)
	pipe := func(dst io.Writer, src io.Reader) {
		io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go pipe(t, br)
	go pipe(c, t)
	<-done
	<-done
}

// tailnetAddr is true for 100.64.0.0/10 and fd7a:115c:a1e0::/48, the ranges a node's peers live in.
func tailnetAddr(a netip.Addr) bool {
	a = a.Unmap()
	if a.Is4() {
		return netip.MustParsePrefix("100.64.0.0/10").Contains(a)
	}
	return netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(a)
}
