package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func startDial(t *testing.T, d dialer, timeout time.Duration) string {
	t.Helper()
	dir := t.TempDir()
	sock := filepath.Join(dir, "d", "dial.sock")
	ln, err := listenDial(sock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go serveDial(ctx, ln, d, timeout)
	return sock
}

func ask(t *testing.T, sock, line string) (net.Conn, *bufio.Reader, map[string]any) {
	t.Helper()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.Write([]byte(line + "\n"))
	br := bufio.NewReader(c)
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	l, err := br.ReadBytes('\n')
	if err != nil {
		t.Fatalf("no answer: %v", err)
	}
	c.SetReadDeadline(time.Time{})
	var m map[string]any
	if err := json.Unmarshal(l, &m); err != nil {
		t.Fatal(err)
	}
	return c, br, m
}

func TestDialSocketMode(t *testing.T) {
	sock := startDial(t, nil, time.Second)
	st, _ := os.Stat(sock)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode %v", st.Mode().Perm())
	}
	d, _ := os.Stat(filepath.Dir(sock))
	if d.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v", d.Mode().Perm())
	}
}

func TestDialPipesToTheNodesNetwork(t *testing.T) {
	var gotAddr string
	d := func(ctx context.Context, network, addr string) (net.Conn, error) {
		gotAddr = addr
		a, b := net.Pipe()
		go func() { io.Copy(b, b); b.Close() }() // echo
		return a, nil
	}
	sock := startDial(t, d, time.Second)
	c, br, m := ask(t, sock, `{"addr":"100.64.0.7:8443"}`)
	if m["ok"] != true || gotAddr != "100.64.0.7:8443" {
		t.Fatalf("answer %v addr %q", m, gotAddr)
	}
	c.Write([]byte("hello"))
	buf := make([]byte, 5)
	if _, err := io.ReadFull(br, buf); err != nil || string(buf) != "hello" {
		t.Fatalf("echo %q %v", buf, err)
	}
}

func TestDialRefusesNonTailnetAndBadRequests(t *testing.T) {
	called := false
	d := func(ctx context.Context, network, addr string) (net.Conn, error) { called = true; return nil, errors.New("no") }
	sock := startDial(t, d, time.Second)
	for _, line := range []string{`{"addr":"8.8.8.8:53"}`, `{"addr":"127.0.0.1:22"}`, `{"addr":"example.com:80"}`, `not json`, `{}`} {
		_, _, m := ask(t, sock, line)
		if m["ok"] != false {
			t.Fatalf("%s accepted: %v", line, m)
		}
	}
	if called {
		t.Fatal("a refused request reached the dialler")
	}
}

func TestDialReportsFailureAndCancelsWhenTheClientLeaves(t *testing.T) {
	cancelled := make(chan struct{})
	d := func(ctx context.Context, network, addr string) (net.Conn, error) {
		<-ctx.Done()
		close(cancelled)
		return nil, ctx.Err()
	}
	sock := startDial(t, d, 10*time.Second)
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte(`{"addr":"100.64.0.7:8443"}` + "\n"))
	time.Sleep(100 * time.Millisecond)
	c.Close() // the application gave up on this path
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("the dial was not cancelled when the client left")
	}
	// and a dial that fails says so
	d2 := func(ctx context.Context, network, addr string) (net.Conn, error) { return nil, errors.New("context deadline exceeded") }
	_, _, m := ask(t, startDial(t, d2, time.Second), `{"addr":"100.64.0.7:8443"}`)
	if m["ok"] != false || m["error"] == "" {
		t.Fatalf("failure answer %v", m)
	}
}

func TestDialTimeoutFails(t *testing.T) {
	d := func(ctx context.Context, network, addr string) (net.Conn, error) { <-ctx.Done(); return nil, ctx.Err() }
	_, _, m := ask(t, startDial(t, d, 150*time.Millisecond), `{"addr":"100.64.0.7:8443"}`)
	if m["ok"] != false {
		t.Fatalf("timeout answer %v", m)
	}
}
