// capsule-suite: oneYesSuite
// The one yes (ADR 0004, one-yes 0.3.1): a call vyred holds for the person's yes answers presence_required with the moment and the exact request. The Capsule asks a card (approvals.ask), Touch ID on
// this Mac gives it (approvals.local-yes, vyred's own dialog), or, with no screen of its own, the card waits for the owner's phone (approvals.status); then the call goes again with the approved card
// (x-vyre-approval). There is no device-key header and no 30-minute session any more.

import Foundation

/// vyred's side: `tool` answers presence_required (with the moment and request) until it is called with the approved card.
private func holds(_ v: FakeVyred, _ tool: String, moment: String = "outward", fields: [String: Any] = [:]) {
    v.tool(tool) { _ in ["state": "done"] }
    v.headerHook = { name, h in
        guard name == tool, h["x-vyre-approval"] == nil else { return (nil, [:]) }
        return (FakeError(code: "presence_required", message: "\(tool) needs your yes", extra: ["moment": moment, "request": ["op": tool, "fields": fields]]), [:])
    }
    v.tool("approvals.ask") { _ in ["id": "ap_1", "line": "The words on the card"] }
}

let oneYesSuite = Suite("one yes") { t in
    t.test("a held send asks a card for exactly the request, Touch ID gives the yes, and the call goes with the approved card") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        holds(v, "gate.approve", fields: ["id": "h1"])
        v.tool("approvals.local-yes") { _ in ["answered": "approved"] }
        let c = VyredClient(socket: v.socket)
        let r = t.wait { await c.call("gate.approve", ["id": "h1"], presence: true, summary: "Approve Menu v2") }
        t.eq(r?.error, nil)
        let ask = v.callsOf("approvals.ask").first
        t.eq(VJ.s(ask?["moment"]), "outward")
        t.eq(VJ.s((ask?["request"] as? [String: Any])?["op"]), "gate.approve")
        t.eq(ask?["reuse"] == nil, true, "a send asks for no reuse window")
        t.eq(v.toolHeaders.last { $0.tool == "gate.approve" }?.headers["x-vyre-approval"], "ap_1")
        t.eq(v.callsOf("gate.approve").count, 1, "the refused try never reached the tool")
        t.eq(v.toolHeaders.contains { $0.headers["x-vyre-presence"] != nil || $0.headers["x-vyre-presence-keep"] != nil }, false, "no device-key header")
    }

    t.test("a reveal asks for the five-minute reuse") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        holds(v, "vault.reveal", moment: "vault", fields: ["name": "mail-token"])
        v.tool("approvals.local-yes") { _ in ["answered": "approved"] }
        let c = VyredClient(socket: v.socket)
        _ = t.wait { await c.call("vault.reveal", ["name": "mail-token"], presence: true, summary: nil) }
        t.eq(v.callsOf("approvals.ask").first?["reuse"] as? Bool, true)
    }

    t.test("a vyred with no screen of its own leaves the card for the phone; the call goes when the phone has answered") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        holds(v, "gate.approve", fields: ["id": "h2"])
        v.tool("approvals.local-yes") { _ in FakeError(code: "presence_required", message: "approve it in Vyre on your phone") }
        let lock = NSLock(); var polls = 0
        v.tool("approvals.status") { _ in lock.lock(); polls += 1; let n = polls; lock.unlock(); return ["state": n < 3 ? "waiting" : "approved", "approval": "ap_1"] }
        let c = VyredClient(socket: v.socket)
        c.yesPollNanos = 1_000_000
        let r = t.wait { await c.call("gate.approve", ["id": "h2"], presence: true, summary: nil) }
        t.eq(r?.error, nil)
        t.eq(v.callsOf("approvals.status").count, 3)
        t.eq(v.toolHeaders.last { $0.tool == "gate.approve" }?.headers["x-vyre-approval"], "ap_1")
    }

    t.test("refused on the phone: nothing goes and the words say so") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        holds(v, "gate.approve", fields: ["id": "h3"])
        v.tool("approvals.local-yes") { _ in FakeError(code: "presence_required", message: "phone") }
        v.tool("approvals.status") { _ in ["state": "refused"] }
        let c = VyredClient(socket: v.socket)
        c.yesPollNanos = 1_000_000
        let r = t.wait { await c.call("gate.approve", ["id": "h3"], presence: true, summary: nil) }
        t.eq(r?.errorCode, "presence")
        t.eq(r?.error, "That was not approved. Nothing was done.")
        t.eq(v.callsOf("gate.approve").count, 0)
    }

    t.test("a refusal that names no moment is not a yes to give: it comes back as it is and no card is asked") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("agents.create") { _ in FakeError(code: "presence_required", message: "the person's own action") }
        let c = VyredClient(socket: v.socket)
        let r = t.wait { await c.call("agents.create", ["name": "kit"], presence: true, summary: nil) }
        t.eq(r?.errorCode, "presence_required")
        t.eq(v.callsOf("approvals.ask").count, 0)
    }

    t.test("nobody answers in time") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        holds(v, "gate.approve", fields: ["id": "h4"])
        v.tool("approvals.local-yes") { _ in FakeError(code: "presence_required", message: "phone") }
        v.tool("approvals.status") { _ in ["state": "waiting"] }
        let c = VyredClient(socket: v.socket)
        c.yesPollNanos = 1_000_000; c.yesWaitMs = 30
        let r = t.wait { await c.call("gate.approve", ["id": "h4"], presence: true, summary: nil) }
        t.eq(r?.errorCode, "presence")
        t.eq(r?.error, "Nobody approved it in time. Ask again.")
    }
}
