package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

type fakeWho struct {
	resp *apitype.WhoIsResponse
	err  error
}

func (f fakeWho) WhoIs(ctx context.Context, remote string) (*apitype.WhoIsResponse, error) {
	return f.resp, f.err
}

func TestEncodeHeaderFraming(t *testing.T) {
	b, err := EncodeHeader(Header{V: 1, NodeKey: "nodekey:00", StableID: "12", RemoteAddr: "100.64.0.2:1"})
	if err != nil {
		t.Fatal(err)
	}
	if string(b[:4]) != "WKH1" {
		t.Fatalf("magic %q", b[:4])
	}
	n := binary.BigEndian.Uint32(b[4:8])
	if int(n) != len(b)-8 {
		t.Fatalf("length %d vs body %d", n, len(b)-8)
	}
	var h Header
	if err := json.Unmarshal(b[8:], &h); err != nil || h.StableID != "12" || h.Tags == nil {
		t.Fatalf("body %s err %v", b[8:], err)
	}
}

// pair runs handle against a Unix socket and a peer connection, returning what the receiver saw.
func pair(t *testing.T, who whoIsClient, peerBytes string) (header []byte, rest string, refused bool) {
	t.Helper()
	dir := t.TempDir()
	sock := filepath.Join(dir, "p.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	a, b := net.Pipe()
	go func() { b.Write([]byte(peerBytes)); b.Close() }()
	got := make(chan []byte, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			got <- nil
			return
		}
		defer c.Close()
		all, _ := io.ReadAll(c)
		got <- all
	}()
	done := make(chan struct{})
	go func() { handle(context.Background(), who, a, sock); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handle did not finish")
	}
	ln.Close()
	select {
	case all := <-got:
		if len(all) == 0 {
			return nil, "", true
		}
		n := int(binary.BigEndian.Uint32(all[4:8]))
		return all[:8+n], string(all[8+n:]), false
	case <-time.After(2 * time.Second):
		return nil, "", true
	}
}

func TestHandleWritesHeaderBeforeStream(t *testing.T) {
	nk := key.NewNode().Public()
	who := fakeWho{resp: &apitype.WhoIsResponse{Node: &tailcfg.Node{Key: nk, StableID: "n42", Tags: []string{"tag:device"}}}}
	hdr, rest, refused := pair(t, who, "hello")
	if refused {
		t.Fatal("refused")
	}
	var h Header
	json.Unmarshal(hdr[8:], &h)
	if h.NodeKey != nk.String() || h.StableID != "n42" || len(h.Tags) != 1 || h.Tags[0] != "tag:device" {
		t.Fatalf("header %+v", h)
	}
	if rest != "hello" {
		t.Fatalf("stream %q", rest)
	}
}

func TestHandleRefusesUnknownNode(t *testing.T) {
	for name, who := range map[string]fakeWho{
		"whois error": {err: errors.New("no match")},
		"nil":         {},
		"no key":      {resp: &apitype.WhoIsResponse{Node: &tailcfg.Node{StableID: "n1"}}},
		"no id":       {resp: &apitype.WhoIsResponse{Node: &tailcfg.Node{Key: key.NewNode().Public()}}},
	} {
		if _, _, refused := pair(t, who, "x"); !refused {
			t.Errorf("%s: a node WhoIs cannot name reached the socket", name)
		}
	}
}

func TestMain(m *testing.M) { os.Exit(m.Run()) }
