// capsule-suite: presenceSessionSuite
// The presence session (ADR 0004, the no-nag rule): one proof in the panel, sent with
// x-vyre-presence-keep, opens a session vyred returns in x-vyre-presence-session; later calls to
// a sessionable tool ride it without asking. It lives in memory only, is forgotten when vyred
// refuses it, when it is about to end, and when the Mac locks or sleeps. A held send refused for
// want of presence asks once, with words the person can read.

import Foundation

/// A proof maker that counts its calls and keeps the words it was asked to show.
private final class Proofs: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var asked: [(tool: String, summary: String?)] = []
    var answer: Result<String, VyredFailure> = .success("capsule key=k1 ts=1 nonce=n sig=s")
    var maker: @Sendable (String, [String: Any], String?) async -> Result<String, VyredFailure> {
        { [self] tool, _, summary in lock.lock(); asked.append((tool, summary)); let a = answer; lock.unlock(); return a }
    }
    var count: Int { lock.lock(); defer { lock.unlock() }; return asked.count }
}

/// vyred's side: a capsule proof with keep opens session s1; that session is good until revoked.
private func sessionVyred(_ v: FakeVyred, expires: Double = 4_000_000_000_000) -> () -> Void {
    let lock = NSLock()
    var live = true
    v.headerHook = { tool, h in
        let p = h["x-vyre-presence"] ?? ""
        guard ["gate.approve", "vault.reveal", "vault.fill"].contains(tool) else { return (nil, [:]) }
        if p.hasPrefix("session ") {
            lock.lock(); defer { lock.unlock() }
            return live && p == "session id=s1 secret=x1" ? (nil, [:]) : (FakeError(code: "presence_required", message: "no such session, or it ended"), [:])
        }
        guard p.hasPrefix("capsule ") else { return (FakeError(code: "presence_required", message: "needs presence"), [:]) }
        return (nil, h["x-vyre-presence-keep"] == "1" ? ["x-vyre-presence-session": "session id=s1 secret=x1 expires=\(Int(expires))"] : [:])
    }
    return { lock.lock(); live = false; lock.unlock() }
}

let presenceSessionSuite = Suite("presence session") { t in
    t.test("the session header parses to what x-vyre-presence takes, and nothing else does") {
        let s = VyredClient.parseSession("session id=ab12 secret=Zz-9_ expires=1800000000000")
        t.eq(s?.header, "session id=ab12 secret=Zz-9_")
        t.eq(s?.id, "ab12")
        t.eq(s?.expires, 1_800_000_000_000)
        t.ok(VyredClient.parseSession(nil) == nil)
        t.ok(VyredClient.parseSession("capsule key=k ts=1") == nil)
        t.ok(VyredClient.parseSession("session id=ab12 expires=1") == nil, "no secret, no session")
    }

    t.test("one proof with keep opens the session; the next approve rides it without asking") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        _ = sessionVyred(v)
        v.tool("gate.approve") { _ in ["state": "approved"] }
        let c = VyredClient(socket: v.socket)
        let p = Proofs(); c.presenceProof = p.maker
        let first = t.wait { await c.call("gate.approve", ["id": "h1"], presence: true, summary: "Approve Menu v2 to dana@harlowlegal.com") }
        t.eq(first?.error, nil)
        t.eq(p.count, 1)
        t.eq(p.asked.first?.summary, "Approve Menu v2 to dana@harlowlegal.com")
        t.eq(v.toolHeaders.first?.headers["x-vyre-presence-keep"], "1")
        t.ok(c.presenceCovered, "covered once vyred returned a session")
        let second = t.wait { await c.call("gate.approve", ["id": "h2"], presence: true, summary: "Approve the invoice") }
        t.eq(second?.error, nil)
        t.eq(p.count, 1, "no second Touch ID")
        t.eq(v.toolHeaders.last?.headers["x-vyre-presence"], "session id=s1 secret=x1")
    }

    t.test("a tool that needs its own proof never sends keep and never rides the session") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        _ = sessionVyred(v)
        v.tool("gate.approve") { _ in ["state": "approved"] }
        v.tool("vault.fill") { _ in ["filled": true] }
        let c = VyredClient(socket: v.socket)
        let p = Proofs(); c.presenceProof = p.maker
        _ = t.wait { await c.call("gate.approve", ["id": "h1"], presence: true, summary: nil) }
        _ = t.wait { await c.call("vault.fill", ["item": "v1"], presence: true, summary: "Fill the Harlow login") }
        t.eq(p.count, 2)
        let fill = v.toolHeaders.last { $0.tool == "vault.fill" }?.headers
        t.eq(fill?["x-vyre-presence-keep"], nil)
        t.ok(fill?["x-vyre-presence"]?.hasPrefix("capsule ") == true)
    }

    t.test("a session vyred no longer knows is forgotten and the person is asked again") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let revoke = sessionVyred(v)
        v.tool("gate.approve") { _ in ["state": "approved"] }
        let c = VyredClient(socket: v.socket)
        let p = Proofs(); c.presenceProof = p.maker
        _ = t.wait { await c.call("gate.approve", ["id": "h1"], presence: true, summary: nil) }
        revoke()
        let r = t.wait { await c.call("gate.approve", ["id": "h2"], presence: true, summary: nil) }
        t.eq(r?.error, nil)
        t.eq(p.count, 2)
        t.eq(v.callsOf("gate.approve").count, 2, "the refused session call never reached the tool")
    }

    t.test("a session about to end is not used; dropping it asks again and closes it on vyred") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        _ = sessionVyred(v, expires: 1_000_000 + 30_000)
        v.tool("gate.approve") { _ in ["state": "approved"] }
        v.tool("presence.session.close") { _ in ["closed": true] }
        let c = VyredClient(socket: v.socket)
        c.now = { 1_000_000 }
        let p = Proofs(); c.presenceProof = p.maker
        _ = t.wait { await c.call("gate.approve", ["id": "h1"], presence: true, summary: nil) }
        _ = t.wait { await c.call("gate.approve", ["id": "h2"], presence: true, summary: nil) }
        t.eq(p.count, 2, "30 s left is inside the minute's margin")

        let w = FakeVyred(); w.start(); defer { w.stop() }
        _ = sessionVyred(w)
        w.tool("gate.approve") { _ in ["state": "approved"] }
        w.tool("presence.session.close") { _ in ["closed": true] }
        let d = VyredClient(socket: w.socket)
        let q = Proofs(); d.presenceProof = q.maker
        _ = t.wait { await d.call("gate.approve", ["id": "h1"], presence: true, summary: nil) }
        d.dropPresenceSession()
        t.ok(!d.presenceCovered)
        _ = t.wait { () async -> Bool in
            for _ in 0..<100 where w.callsOf("presence.session.close").isEmpty { try? await Task.sleep(nanoseconds: 10_000_000) }
            return true
        }
        t.eq(VJ.s(w.callsOf("presence.session.close").first?["session"]), "s1")
        _ = t.wait { await d.call("gate.approve", ["id": "h2"], presence: true, summary: nil) }
        t.eq(q.count, 2)
    }

    t.test("cancelled in the panel: nothing is sent and the words say so") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        _ = sessionVyred(v)
        v.tool("gate.approve") { _ in ["state": "approved"] }
        let c = VyredClient(socket: v.socket)
        let p = Proofs(); p.answer = .failure(VyredFailure("Not approved. Nothing was done.")); c.presenceProof = p.maker
        let r = t.wait { await c.call("gate.approve", ["id": "h1"], presence: true, summary: nil) }
        t.eq(r?.errorCode, "presence")
        t.eq(r?.error, "Not approved. Nothing was done.")
        t.eq(v.callsOf("gate.approve").count, 0)
        t.eq(Bridge.presenceRefused(code: "presence", message: "Not approved. Nothing was done.", lesson: false, yes: true, id: "h1"),
             "Not approved. Nothing was done. It is still held.")
    }
}
