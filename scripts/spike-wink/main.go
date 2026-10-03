// winkspike: the Wink network spike harness. One or more embedded tsnet nodes in one process.
//
//	winkspike -conf nodes.json            several nodes (spaces) in this process
//	winkspike -control URL -key FILE -dir DIR -host NAME   one node
//
// Every node serves the same tiny TCP service on :7000 (first line picks the mode):
//
//	hello\n     -> "node=<name> space=<space>\n"
//	ping\n      -> echoes each 1-byte write
//	src N\n     -> sends N bytes then closes
//	sink N\n    -> reads N bytes, answers "ok\n"
//
// Output is one JSON object per line on stdout.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

type NodeConf struct {
	Name      string `json:"name"`
	Space     string `json:"space"`
	Control   string `json:"control"`
	KeyFile   string `json:"keyFile"`
	Dir       string `json:"dir"`
	Ephemeral bool   `json:"ephemeral"`
}

type Test struct {
	From  string `json:"from"`
	To    string `json:"to"` // ip:port
	Kind  string `json:"kind"` // hello | ping | src | sink
	Count int    `json:"count"`
	Bytes int64  `json:"bytes"`
	Label string `json:"label"`
	Wait  int    `json:"waitSeconds"`
}

type Conf struct {
	Nodes []NodeConf `json:"nodes"`
	Tests []Test     `json:"tests"`
	Hold  int        `json:"holdSeconds"`
}

var emitMu sync.Mutex

var logf = func(string, ...any) {}

func emit(m map[string]any) {
	m["t"] = time.Now().Format("15:04:05.000")
	m["rss_kb"] = rssKB()
	m["goroutines"] = runtime.NumGoroutine()
	emitMu.Lock()
	defer emitMu.Unlock()
	b, _ := json.Marshal(m)
	fmt.Println(string(b))
}

func rssKB() int {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		return int(ms.Sys / 1024) // not RSS: only where /proc is missing
	}
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "VmRSS:") {
			f := strings.Fields(l)
			n, _ := strconv.Atoi(f[1])
			return n
		}
	}
	return 0
}

type node struct {
	conf NodeConf
	srv  *tsnet.Server
	ip   string
}

func serve(n *node) {
	ln, err := n.srv.Listen("tcp", ":7000")
	if err != nil {
		emit(map[string]any{"ev": "listen-fail", "node": n.conf.Name, "err": err.Error()})
		return
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go handle(n, c)
	}
}

func handle(n *node, c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(c)
	line, err := r.ReadString('\n')
	if err != nil {
		return
	}
	f := strings.Fields(line)
	if len(f) == 0 {
		return
	}
	switch f[0] {
	case "hello":
		fmt.Fprintf(c, "node=%s space=%s from=%s\n", n.conf.Name, n.conf.Space, c.RemoteAddr())
	case "ping":
		buf := make([]byte, 1)
		for {
			if _, err := io.ReadFull(r, buf); err != nil {
				return
			}
			c.Write(buf)
		}
	case "src":
		sz, _ := strconv.ParseInt(f[1], 10, 64)
		chunk := make([]byte, 32*1024)
		for sz > 0 {
			k := int64(len(chunk))
			if k > sz {
				k = sz
			}
			if _, err := c.Write(chunk[:k]); err != nil {
				return
			}
			sz -= k
		}
	case "sink":
		sz, _ := strconv.ParseInt(f[1], 10, 64)
		io.CopyN(io.Discard, r, sz)
		fmt.Fprintf(c, "ok\n")
	}
}

// path says how the node reaches the peer at host: a direct address or a DERP region.
func path(n *node, host string) string {
	lc, err := n.srv.LocalClient()
	if err != nil {
		return "?"
	}
	st, err := lc.Status(context.Background())
	if err != nil {
		return "?"
	}
	for _, p := range st.Peer {
		for _, ip := range p.TailscaleIPs {
			if ip.String() == host {
				if p.CurAddr != "" {
					return "direct " + p.CurAddr
				}
				return "derp " + p.Relay
			}
		}
	}
	return "no peer"
}

func runTest(nodes map[string]*node, t Test) {
	n := nodes[t.From]
	defer func() {
		h, _, _ := net.SplitHostPort(t.To)
		emit(map[string]any{"ev": "path", "label": t.Label, "path": path(n, h)})
	}()
	if n == nil {
		emit(map[string]any{"ev": "test", "label": t.Label, "err": "no such node " + t.From})
		return
	}
	deadline := time.Now().Add(time.Duration(t.Wait) * time.Second)
	var c net.Conn
	var err error
	start := time.Now()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		c, err = n.srv.Dial(ctx, "tcp", t.To)
		cancel()
		if err == nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		emit(map[string]any{"ev": "test", "label": t.Label, "from": t.From, "to": t.To, "err": err.Error(), "after_ms": time.Since(start).Milliseconds()})
		return
	}
	defer c.Close()
	dialMs := time.Since(start).Milliseconds()
	r := bufio.NewReader(c)
	switch t.Kind {
	case "hello":
		fmt.Fprintf(c, "hello\n")
		l, _ := r.ReadString('\n')
		emit(map[string]any{"ev": "test", "label": t.Label, "from": t.From, "to": t.To, "dial_ms": dialMs, "answer": strings.TrimSpace(l)})
	case "ping":
		fmt.Fprintf(c, "ping\n")
		b := []byte{1}
		rb := make([]byte, 1)
		var rtts []float64
		for i := 0; i < t.Count; i++ {
			s := time.Now()
			c.Write(b)
			if _, err := io.ReadFull(r, rb); err != nil {
				break
			}
			rtts = append(rtts, float64(time.Since(s).Microseconds())/1000)
		}
		emit(map[string]any{"ev": "test", "label": t.Label, "from": t.From, "to": t.To, "dial_ms": dialMs, "rtt_ms": stats(rtts)})
	case "src":
		fmt.Fprintf(c, "src %d\n", t.Bytes)
		s := time.Now()
		got, _ := io.Copy(io.Discard, r)
		el := time.Since(s).Seconds()
		emit(map[string]any{"ev": "test", "label": t.Label, "from": t.From, "to": t.To, "dial_ms": dialMs, "bytes": got, "secs": el, "mbit_s": float64(got) * 8 / el / 1e6})
	case "sink":
		fmt.Fprintf(c, "sink %d\n", t.Bytes)
		s := time.Now()
		chunk := make([]byte, 32*1024)
		left := t.Bytes
		for left > 0 {
			k := int64(len(chunk))
			if k > left {
				k = left
			}
			c.Write(chunk[:k])
			left -= k
		}
		r.ReadString('\n')
		el := time.Since(s).Seconds()
		emit(map[string]any{"ev": "test", "label": t.Label, "from": t.From, "to": t.To, "dial_ms": dialMs, "bytes": t.Bytes, "secs": el, "mbit_s": float64(t.Bytes) * 8 / el / 1e6})
	}
}

func stats(v []float64) map[string]any {
	if len(v) == 0 {
		return map[string]any{"n": 0}
	}
	s := append([]float64(nil), v...)
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1] > s[j]; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
	return map[string]any{"n": len(s), "min": s[0], "p50": s[len(s)/2], "p95": s[len(s)*95/100], "max": s[len(s)-1]}
}

func main() {
	confPath := flag.String("conf", "", "JSON config with several nodes")
	control := flag.String("control", "", "control URL")
	keyFile := flag.String("key", "", "pre-auth key file")
	dir := flag.String("dir", "", "state dir")
	host := flag.String("host", "wink-spike", "hostname")
	hold := flag.Int("hold", 0, "seconds to stay up after tests")
	verbose := flag.Bool("v", false, "print tsnet logs to stderr")
	flag.Parse()

	if *verbose {
		logf = func(f string, a ...any) { fmt.Fprintf(os.Stderr, "%s "+f+"\n", append([]any{time.Now().Format("15:04:05.000")}, a...)...) }
	}
	var conf Conf
	if *confPath != "" {
		b, err := os.ReadFile(*confPath)
		if err != nil {
			panic(err)
		}
		if err := json.Unmarshal(b, &conf); err != nil {
			panic(err)
		}
	} else {
		conf.Nodes = []NodeConf{{Name: *host, Space: *host, Control: *control, KeyFile: *keyFile, Dir: *dir}}
	}
	if *hold > 0 {
		conf.Hold = *hold
	}
	emit(map[string]any{"ev": "start", "os": runtime.GOOS, "arch": runtime.GOARCH, "go": runtime.Version(), "nodes": len(conf.Nodes)})

	nodes := map[string]*node{}
	for _, nc := range conf.Nodes {
		key := ""
		if nc.KeyFile != "" {
			if b, err := os.ReadFile(nc.KeyFile); err == nil {
				key = strings.TrimSpace(string(b))
			}
		}
		s := &tsnet.Server{Dir: nc.Dir, Hostname: nc.Name, ControlURL: nc.Control, AuthKey: key, Ephemeral: nc.Ephemeral, Logf: logf, UserLogf: logf}
		n := &node{conf: nc, srv: s}
		t0 := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		st, err := s.Up(ctx)
		cancel()
		if err != nil {
			emit(map[string]any{"ev": "up-fail", "node": nc.Name, "err": err.Error(), "ms": time.Since(t0).Milliseconds()})
			os.Exit(2)
		}
		ips := []string{}
		for _, ip := range st.TailscaleIPs {
			ips = append(ips, ip.String())
		}
		n.ip = ips[0]
		emit(map[string]any{"ev": "up", "node": nc.Name, "space": nc.Space, "ips": ips, "up_ms": time.Since(t0).Milliseconds(), "peers": len(st.Peer)})
		nodes[nc.Name] = n
		go serve(n)
	}
	var wg sync.WaitGroup
	for _, t := range conf.Tests {
		if t.Count == 0 {
			t.Count = 50
		}
		wg.Add(1)
		go func(t Test) { defer wg.Done(); runTest(nodes, t) }(t)
	}
	wg.Wait()
	emit(map[string]any{"ev": "tests-done"})
	if conf.Hold > 0 {
		time.Sleep(time.Duration(conf.Hold) * time.Second)
		emit(map[string]any{"ev": "hold-end"})
	} else {
		select {}
	}
	for _, n := range nodes {
		n.srv.Close()
	}
}
