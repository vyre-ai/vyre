// capsule-suite: boxLinkSuite
// A Mac paired to a server asks the server for the assistant, memory and agents (Vyred/BoxLink.swift, #36). The user's Mac said
// "there is no assistant on this Vyre" while their assistant was on their server, because Lumen asked the Mac's own vyred.
// A FakeVyred stands in for the Mac's vyred: it has wink.server.home and wink.server.call, and proxies the box's events at /v1/wink/server-events.

import Foundation

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

/// A Mac's vyred: its own agents.list is empty (no assistant here), wink.server.call answers for the server.
private func pairedMac(linked: Bool = true, boxUp: Bool = true) -> FakeVyred {
    let v = FakeVyred(); v.start()
    v.tool("wink.server.home") { _ in ["role": "local", "linked": linked, "reachable": boxUp, "box": ["name": "kit", "address": "https://kit.vyre.run"]] as [String: Any] }
    v.tool("agents.list") { _ in [] as [Any] }
    v.tool("apps.list") { _ in ["apps": ["mail"]] as [String: Any] }
    v.tool("threads.get") { i in ["thread": ["id": i["thread"] ?? ""], "from": "mac"] as [String: Any] }
    v.tool("wink.server.call") { i in
        if !boxUp { return FakeError(code: "box_unreachable", message: "the box is not reachable") }
        let tool = (i["tool"] as? String) ?? "", input = (i["input"] as? [String: Any]) ?? [:]
        switch tool {
        case "agents.list": return [["name": "assistant", "kind": "assistant", "doing": "idle"]] as [Any]
        case "agents.ask": return ["ok": true, "thread": "t-box", "agent": input["agent"] ?? ""] as [String: Any]
        case "threads.get": return ["thread": ["id": input["thread"] ?? ""], "from": "box"] as [String: Any]
        case "memory.ask": return ["answer": "From the server.", "abstained": false] as [String: Any]
        default: return FakeError(code: "no_such_tool", message: "no tool \(tool).")
        }
    }
    return v
}

let boxLinkSuite = Suite("box link") { t in
    t.test("not linked: every call stays on this Mac, and the server's tools are not offered") {
        let v = pairedMac(linked: false); defer { v.stop() }
        let c = VyredClient(socket: v.socket)
        let r: VyredResult? = t.wait {
            _ = await c.refreshTools()
            await MainActor.run { }
            await c.box.refresh(c)
            return await c.call("agents.list", [:], presence: false)
        }
        t.eq(c.box.linked, false)
        t.ok(!c.has("agents.ask"), "no agents.ask here, and no server to lend it")
        if case .success(let d)? = r { t.eq((d as? [Any])?.count, 0, "the Mac's own, empty list") } else { t.ok(false, "agents.list answered") }
        t.eq(v.callsOf("wink.server.call").count, 0, "nothing went to the server")
    }

    t.test("linked: agents.list, agents.ask and memory.ask go to the server, and everything else stays here") {
        let v = pairedMac(); defer { v.stop() }
        let c = VyredClient(socket: v.socket)
        let got: (VyredResult, VyredResult, VyredResult, VyredResult)? = t.wait {
            _ = await c.refreshTools()
            await c.box.refresh(c)
            let list = await c.call("agents.list", [:], presence: false)
            let ask = await c.call("agents.ask", ["agent": "assistant", "text": "hi", "wait": false], presence: false)
            let mem = await c.call("memory.ask", ["question": "who is kit"], presence: false)
            let apps = await c.call("apps.list", [:], presence: false)
            return (list, ask, mem, apps)
        }
        t.eq(c.box.linked, true)
        t.eq(c.box.boxName, "kit")
        t.ok(c.has("agents.ask"), "agents.ask is offered, the server has it")
        if case .success(let d)? = got?.0 { t.eq(((d as? [[String: Any]])?.first)?["name"] as? String, "assistant", "the server's assistant is in the list") } else { t.ok(false, "agents.list") }
        if case .success(let d)? = got?.1 { t.eq((d as? [String: Any])?["thread"] as? String, "t-box") } else { t.ok(false, "agents.ask") }
        if case .success(let d)? = got?.2 { t.eq((d as? [String: Any])?["answer"] as? String, "From the server.") } else { t.ok(false, "memory.ask") }
        if case .success(let d)? = got?.3 { t.eq(((d as? [String: Any])?["apps"] as? [String]), ["mail"], "apps.list is this Mac's") } else { t.ok(false, "apps.list") }
        t.eq(v.callsOf("wink.server.call").compactMap { $0["tool"] as? String }, ["agents.list", "agents.ask", "memory.ask"])
        t.eq(v.callNames.filter { $0 == "agents.list" || $0 == "agents.ask" || $0 == "memory.ask" }.count, 0, "the Mac's own agents and memory were never asked")
    }

    t.test("a thread the server started is the server's: its calls go there, a Mac thread's stay here") {
        let v = pairedMac(); defer { v.stop() }
        let c = VyredClient(socket: v.socket)
        let got: (VyredResult, VyredResult)? = t.wait {
            _ = await c.refreshTools()
            await c.box.refresh(c)
            _ = await c.call("agents.ask", ["agent": "assistant", "text": "hi", "wait": false], presence: false)
            let boxs = await c.call("threads.get", ["thread": "t-box"], presence: false)
            let macs = await c.call("threads.get", ["thread": "mac-1"], presence: false)
            return (boxs, macs)
        }
        if case .success(let d)? = got?.0 { t.eq((d as? [String: Any])?["from"] as? String, "box") } else { t.ok(false, "the server's thread") }
        if case .success(let d)? = got?.1 { t.eq((d as? [String: Any])?["from"] as? String, "mac") } else { t.ok(false, "the Mac's thread") }
    }

    t.test("the server away: a plain message, nothing falls back to the Mac's empty answer") {
        let v = pairedMac(boxUp: false); defer { v.stop() }
        let c = VyredClient(socket: v.socket)
        let r: VyredResult? = t.wait {
            _ = await c.refreshTools()
            await c.box.refresh(c)
            return await c.call("agents.ask", ["agent": "assistant", "text": "hi", "wait": false], presence: false)
        }
        if case .failure(let code, let message)? = r {
            t.eq(code, "box_unreachable")
            t.ok(message.contains("Your server is not reachable"), message)
            t.ok(message.contains("Apps, files and your clipboard still work"), message)
            t.eq(Bridge.explain(code: code, message: message), message, "shown as it is")
        } else { t.ok(false, "a failure was expected") }
        t.eq(c.box.reachable, false)
        t.ok(c.box.said("There is no assistant on this Vyre yet.").contains("Your server is not reachable"), "the no-assistant words say the server is away instead")
        t.eq(c.box.said("plain"), "Your server is not reachable right now, so there is no assistant, memory or agent to ask. Apps, files and your clipboard still work here.")
        t.eq(v.callNames.filter { $0 == "agents.ask" }.count, 0, "the Mac's own agents.ask was never asked")
    }

    t.test("the server's events reach the same subscribers as the Mac's own, and a thread named in one is the server's") {
        let v = pairedMac(); defer { v.stop() }
        let c = VyredClient(socket: v.socket)
        let heard = HeardBox()
        MainActor.assumeIsolated {
            _ = c.on("thread.*") { e in heard.add("\(e.type):\(e.thread ?? "")") }
            _ = c.on("gate.*") { e in heard.add("\(e.type)") }
        }
        let _: Bool? = t.wait { _ = await c.refreshTools(); await c.box.refresh(c); return true }
        t.ok(MainActor.assumeIsolated { true } && (t.wait { await until { v.openBoxStreams == 3 } } ?? false), "three streams: thread, ask and memory")
        t.ok(v.boxStreamQueries.contains { $0.contains("type=thread.*") } && v.boxStreamQueries.contains { $0.contains("type=ask.*") } && v.boxStreamQueries.contains { $0.contains("type=memory.*") })
        v.emitBox("thread.text", thread: "t-9", ["text": "hello"])
        v.emitBox("gate.held", ["id": "x"])   // never followed: the Gate is this Mac's
        t.ok(t.wait { await until { heard.all.contains("thread.text:t-9") } } ?? false, "the server's thread.text arrives")
        t.ok(!heard.all.contains("gate.held"), "the server's Gate events are not followed")
        let r: VyredResult? = t.wait { await c.call("threads.get", ["thread": "t-9"], presence: false) }
        if case .success(let d)? = r { t.eq((d as? [String: Any])?["from"] as? String, "box", "t-9 is the server's now") } else { t.ok(false, "threads.get") }
    }

    t.test("unpaired later: the routing and the streams stop") {
        let v = pairedMac(); defer { v.stop() }
        let c = VyredClient(socket: v.socket)
        let _: Bool? = t.wait { _ = await c.refreshTools(); await c.box.refresh(c); return true }
        t.ok(t.wait { await until { v.openBoxStreams == 3 } } ?? false)
        v.tool("wink.server.home") { _ in ["role": "local", "linked": false] as [String: Any] }
        let _: Bool? = t.wait { await c.box.refresh(c); return true }
        t.eq(c.box.linked, false)
        t.ok(t.wait { await until { v.openBoxStreams == 0 } } ?? false, "the streams closed")
        t.ok(!c.has("agents.ask"))
    }

    t.test("sleep and wake: link.sleep and link.wake when the vyred has them, nothing when it does not") {
        let v = pairedMac(); defer { v.stop() }
        v.tool("link.sleep") { _ in ["ok": true, "linked": true] as [String: Any] }
        v.tool("link.wake") { _ in ["ok": true, "linked": true] as [String: Any] }
        let c = VyredClient(socket: v.socket)
        let _: Bool? = t.wait {
            _ = await c.refreshTools()
            await c.box.willSleep(c)
            await c.box.didWake(c)
            return true
        }
        t.eq(v.callNames.filter { $0 == "link.sleep" }.count, 1)
        t.eq(v.callNames.filter { $0 == "link.wake" }.count, 1)
        let old = FakeVyred(); old.start(); defer { old.stop() }
        let c2 = VyredClient(socket: old.socket)
        let _: Bool? = t.wait { _ = await c2.refreshTools(); await c2.box.willSleep(c2); await c2.box.didWake(c2); return true }
        t.eq(old.callNames.filter { $0.hasPrefix("link.s") || $0 == "link.wake" }.count, 0, "an older vyred is not called")
    }

    t.test("a reply with no words for a while says so, instead of sitting on \"starting\"") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("agents.ask") { _ in ["ok": true, "thread": "t-quiet"] as [String: Any] }
        let m = MainActor.assumeIsolated { () -> CapsuleModel in
            let m = CapsuleModel(home: vyScratch("quiet-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            m.replyPatience = 0.2; m.replyTick = 0.05
            return m
        }
        let _: Bool? = t.wait {
            _ = await m.vyred.refreshTools()
            _ = await m.send("are you configured now", to: VyreCandidate(kind: .agent, id: "kit", label: "kit"))
            return await until { m.line?.contains("Nothing has come back yet") == true }
        }
        t.ok(MainActor.assumeIsolated { m.line?.contains("Nothing has come back yet") == true }, "the plain line appeared")
    }

    t.test("memory that does not answer in time says so and points at the assistant; a paired Mac's memory.ask goes to the server, plain") {
        let v = pairedMac(); defer { v.stop() }
        v.tool("memory.ask") { _ in Thread.sleep(forTimeInterval: 1.5); return ["answer": "slow, on the Mac"] as [String: Any] }
        let c = VyredClient(socket: v.socket)
        let m = MainActor.assumeIsolated { () -> CapsuleModel in
            let m = CapsuleModel(home: vyScratch("iqslow-\(UUID().uuidString.prefix(6))"), vyred: c, providers: [])
            m.iqTimeout = 0.4
            return m
        }
        // Paired: the draft-streaming overload is routed to the server, so the Mac's slow memory is never asked.
        let routed: VyredResult? = t.wait {
            _ = await c.refreshTools(); await c.box.refresh(c)
            return await c.call("memory.ask", ["question": "q", "stream": true, "id": "x"], timeout: 5) { _, _ in }
        }
        if case .success(let d)? = routed { t.eq((d as? [String: Any])?["answer"] as? String, "From the server.") } else { t.ok(false, "routed") }
        t.eq(v.callNames.filter { $0 == "memory.ask" }.count, 0, "the Mac's own memory was not asked")
        t.ok(!(v.callsOf("wink.server.call").first { ($0["tool"] as? String) == "memory.ask" }?["input"] as? [String: Any] ?? [:]).keys.contains("stream"), "plain: no stream flag")
        // Not paired, memory slow: the plain words.
        let slow = FakeVyred(); slow.start(); defer { slow.stop() }
        slow.tool("memory.ask") { _ in Thread.sleep(forTimeInterval: 1.5); return ["answer": "late"] as [String: Any] }
        let m2 = MainActor.assumeIsolated { () -> CapsuleModel in
            let m = CapsuleModel(home: vyScratch("iqslow2-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: slow.socket), providers: [])
            m.iqTimeout = 0.4
            return m
        }
        let out: ActionOutcome?? = t.wait {
            _ = await m2.vyred.refreshTools()
            return await m2.askIQ("are you configured now")
        }
        if case .failed(let why)? = out ?? nil { t.ok(why.contains("Memory did not answer in time"), why) } else { t.ok(false, "a plain failure was expected: \(String(describing: out))") }
        t.eq(MainActor.assumeIsolated { m2.pending }, false, "no longer starting")
        _ = m
    }

    t.test("the Mac's IANA zone name goes to context.report, and nothing else about where it is (#58)") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("context.report") { _ in ["ok": true] as [String: Any] }
        let m = MainActor.assumeIsolated { CapsuleModel(home: vyScratch("tz-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: []) }
        let _: Bool? = t.wait { _ = await m.vyred.refreshTools(); await MainActor.run { m.reportZone() }; return await until { !v.callsOf("context.report").isEmpty } }
        let sent = v.callsOf("context.report").first ?? [:]
        t.eq(VJ.s(sent["surface"]), "capsule")
        t.eq(VJ.s(sent["tz"]), TimeZone.current.identifier)
        t.eq(Set(sent.keys), ["surface", "device", "tz"], "only the zone name, the surface and the device")
        t.eq(CapsuleModel.zoneName(TimeZone(identifier: "America/Los_Angeles")!), "America/Los_Angeles")
        let old = FakeVyred(); old.start(); defer { old.stop() }
        let m2 = MainActor.assumeIsolated { CapsuleModel(home: vyScratch("tz2-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: old.socket), providers: []) }
        let _: Bool? = t.wait { _ = await m2.vyred.refreshTools(); await MainActor.run { m2.reportZone() }; try? await Task.sleep(nanoseconds: 200_000_000); return true }
        t.eq(old.callNames.filter { $0 == "context.report" }.count, 0, "a vyred without context.report is not called")
    }
}

final class HeardBox: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [String] = []
    func add(_ s: String) { lock.lock(); list.append(s); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return list }
}
