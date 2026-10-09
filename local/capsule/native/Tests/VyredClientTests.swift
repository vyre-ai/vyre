// VyredClient against FakeVyred over a real unix socket: calls, the stream, and the backoff.
import Foundation

// capsule-suite: vyredClientSuite
let vyredClientSuite = Suite("vyred client") { t in
    t.test("the socket path is VYRE_SOCKET, else vyred.sock in VYRE_HOME, else in ~/.vyre") {
        t.eq(vyredSocketPath(["VYRE_SOCKET": "/s/v.sock", "VYRE_HOME": "/h"]), "/s/v.sock")
        t.eq(vyredSocketPath(["VYRE_HOME": "/h"]), "/h/vyred.sock")
        t.eq(vyredSocketPath([:]), (NSHomeDirectory() as NSString).appendingPathComponent(".vyre/vyred.sock"))
    }

    t.test("chunked bodies decode however the bytes are split") {
        var d = ChunkDecoder()
        let whole = Data("5\r\nhello\r\n7;x=1\r\n, there\r\n0\r\n\r\n".utf8)
        var out = Data()
        for b in whole { out.append(d.feed(Data([b]))) }
        t.eq(String(decoding: out, as: UTF8.self), "hello, there")
        t.ok(d.finished)
    }

    t.test("a call goes as the capsule caller and comes back as data or error, never a throw") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("projects.list") { _ in ["projects": [["slug": "harlow-legal", "name": "Harlow Legal"]]] }
        v.tool("gate.approve") { _ in FakeError(code: "denied", message: "needs presence") }
        v.tool("slow.tool") { _ in usleep(1_500_000); return [:] }
        let c = VyredClient(socket: v.socket)
        let r = t.wait { await c.call("projects.list", ["limit": 3]) }
        let rows = VJ.rows((r?.data as? [String: Any])?["projects"], "x")
        t.eq(rows.first.flatMap { VJ.str($0["name"]) }, "Harlow Legal")
        t.eq(VJ.int(v.callsOf("projects.list").first?["limit"]), 3)
        t.eq(v.callers, ["capsule"])
        t.eq(t.wait { await c.call("gate.approve", [:]) }?.error, "needs presence")
        t.eq(t.wait { await c.call("nope", [:]) }?.error, "no tool nope.")
        let slow = t.wait { await c.call("slow.tool", [:], timeout: 0.3) }
        if case .failure(let code, _)? = slow { t.eq(code, "timeout") } else { t.ok(false, "a slow tool times out") }
    }

    t.test("a presence call to a tool that needs no yes goes straight through, with no card asked") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("vault.fill") { _ in ["filled": true] }
        let c = VyredClient(socket: v.socket)
        let r = t.wait { await c.call("vault.fill", [:], presence: true) }
        t.eq(r?.error, nil)
        t.eq(v.callsOf("vault.fill").count, 1)
        t.eq(v.callsOf("approvals.ask").count, 0)
    }

    t.test("vyred not running is unreachable, not a crash") {
        let c = VyredClient(socket: vyScratch("sock") + "/nobody-here.sock")
        let r = t.wait { await c.call("projects.list", [:]) }
        if case .failure(let code, _)? = r { t.eq(code, "unreachable") } else { t.ok(false) }
        t.eq(c.isUp, false)
    }

    t.test("has() comes from GET /v1/tools, refreshed when the stream opens") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("agents.list") { _ in [] }
        v.listed = ["threads.send"]
        let c = VyredClient(socket: v.socket)
        MainActor.assumeIsolated {
            c.useClock(ManualClock())
            c.follower.start()
            t.ok(until { c.follower.isStreaming && c.has("agents.list") }, "streaming with tools known")
            t.ok(c.has("threads.send") && !c.has("gate.held") && c.isUp)
            c.follower.stop()
        }
    }

    t.test("events arrive in order, once, to the patterns that match") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.emit("system.started")
        let c = VyredClient(socket: v.socket)
        MainActor.assumeIsolated {
            var all: [String] = [], threads: [String] = [], exact: [Int] = []
            let a = c.on("*") { all.append($0.type) }
            let b = c.on("thread.*") { threads.append($0.type) }
            let x = c.on("thread.text") { exact.append($0.id) }
            c.useClock(ManualClock())
            c.follower.start()
            t.ok(until { c.follower.isStreaming && v.openStreams == 1 })
            for i in 0..<50 { v.emit("thread.text", thread: "t1", ["message": "m", "delta": "\(i)"]) }
            v.beat()
            v.emit("ask.raised", ["ask": "a1"])
            t.ok(until { all.count == 51 }, "got \(all.count)")
            t.ok(!all.contains("system.started"), "nothing from before the Capsule opened is replayed")
            t.eq(exact, Array(2...51), "in order")
            t.eq(threads.count, 50)
            b.cancel()
            v.emit("thread.finished", thread: "t1")
            t.ok(until { all.count == 52 })
            t.eq(threads.count, 50, "a cancelled subscription hears nothing")
            a.cancel(); x.cancel()
            c.follower.stop()
            t.ok(until { v.openStreams == 0 }, "stop closes the stream")
        }
    }

    t.test("while vyred is down: 3 s doubling to 60 s hidden, 3 s shown, at once on show") {
        let v = FakeVyred()        // not started: vyred is down
        let c = VyredClient(socket: v.socket)
        let clock = ManualClock()
        MainActor.assumeIsolated {
            c.useClock(clock)
            var downs = 0
            c.follower.onState = { if $0 == .down { downs += 1 } }
            c.follower.start()
            t.ok(until { c.follower.retries.count == 1 })
            for n in 2...7 { clock.advance(clock.pending.first ?? 0); t.ok(until { c.follower.retries.count == n }, "retry \(n)") }
            t.eq(c.follower.retries, [3, 6, 12, 24, 48, 60, 60].prefix(7).map { $0 }, "doubling to a minute, hidden")
            t.eq(clock.pending, [60])
            c.follower.setShown(true)
            t.ok(until { c.follower.retries.count == 8 }, "showing looks again at once")
            t.eq(c.follower.retries.last, 3, "and every 3 s while shown")
            t.ok(downs >= 8)
            // vyred starts: the next look finds it and follows the stream.
            v.start()
            clock.advance(3)
            t.ok(until { c.follower.isStreaming && v.openStreams == 1 }, "connected")
            t.eq(c.follower.wait, 3, "the backoff starts over")
            c.follower.stop()
        }
        v.stop()
    }

    t.test("a stream that drops reconnects after the backoff and resumes without repeats") {
        let v = FakeVyred(); v.start()
        let c = VyredClient(socket: v.socket)
        let clock = ManualClock()
        MainActor.assumeIsolated {
            c.useClock(clock)
            var ids: [Int] = []
            let s = c.on("*") { ids.append($0.id) }
            c.follower.start()
            t.ok(until { v.openStreams == 1 })
            v.emit("thread.text", thread: "t1")
            v.emit("thread.text", thread: "t1")
            t.ok(until { ids.count == 2 })
            v.stop()
            t.ok(until { !c.follower.isStreaming && c.follower.isWaiting }, "the drop is seen")
            t.eq(c.isUp, false)
            t.eq(clock.pending, [3], "not a busy loop: one retry, 3 s out")
            // vyred comes back on the same socket, with what it logged meanwhile.
            v.start()
            v.emit("gate.held", ["id": "g1"])
            clock.advance(3)
            t.ok(until { ids.count == 3 }, "the event logged while it was away arrives: \(ids)")
            t.eq(ids, [1, 2, 3])
            s.cancel()
            c.follower.stop()
        }
        v.stop()
    }

    t.test("an open stream costs next to nothing while nothing happens") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let c = VyredClient(socket: v.socket)
        MainActor.assumeIsolated {
            c.useClock(ManualClock())
            c.follower.start()
            t.ok(until { c.follower.isStreaming && v.openStreams == 1 })
            func cpu() -> Double {
                var u = rusage(); getrusage(RUSAGE_SELF, &u)
                return Double(u.ru_utime.tv_sec + u.ru_stime.tv_sec) + Double(u.ru_utime.tv_usec + u.ru_stime.tv_usec) / 1e6
            }
            let c0 = cpu(), w0 = Date()
            // Idle, the way the Capsule idles: the run loop waits, the stream thread sits in poll.
            RunLoop.main.run(until: Date().addingTimeInterval(3))
            v.beat()
            RunLoop.main.run(until: Date().addingTimeInterval(1))
            let used = cpu() - c0, wall = Date().timeIntervalSince(w0)
            let pct = used / wall * 100
            print("capsule native perf: idle stream \(String(format: "%.3f", pct))% CPU over \(String(format: "%.1f", wall)) s (\(String(format: "%.1f", used * 1000)) ms)")
            t.ok(pct < 0.5, "idle CPU \(pct)%")
            c.follower.stop()
        }
    }
}
