// capsule-suite: plannerSuite
// Planner banners (ADR 0025): one per firing, replaced by a later ring, dropped by an ack from
// anywhere; "Missed" when it fell due offline; Done and Snooze call the planner through vyred, or
// through link.call when this vyred does not carry it. No Notification Center: hooks.

import Foundation

let plannerSuite = Suite("planner") { t in
    t.test("fired shows, a later ring replaces, acked drops, missed says so") {
        let r: [String]? = t.wait {
            await MainActor.run {
                let p = PlannerBanners(vyred: VyredClient(socket: vyScratch("planner") + "/none.sock"))
                var shown: [String: String] = [:], log: [String] = []
                p.show = { f in shown[f.firing] = "\(f.heading): \(f.body) (ring \(f.ring))"; log.append("show \(f.firing)") }
                p.drop = { id in shown[id] = nil; log.append("drop \(id)") }
                func ev(_ type: String, _ payload: [String: Any]) -> VyredEvent { VyredEvent(id: 1, type: type, source: "box", thread: nil, project: nil, at: 0, payload: payload) }
                p.event(ev("planner.fired", ["firing": "f1", "item": "i1", "kind": "timer", "title": "Tea", "ring": 1, "missed": false, "actions": ["done", "snooze"]]))
                p.event(ev("planner.fired", ["firing": "f1", "item": "i1", "kind": "timer", "title": "Tea", "ring": 2]))
                p.event(ev("planner.fired", ["firing": "f2", "item": "i2", "kind": "reminder", "title": "Call Northwind Bakery", "missed": true]))
                let both = shown.keys.sorted().map { "\($0) \(shown[$0]!)" }
                p.event(ev("planner.acked", ["firing": "f1", "action": "done", "by": "phone"]))
                return both + shown.keys.sorted() + log
            }
        }
        t.eq(r, ["f1 Timer: Tea (ring 2)", "f2 Missed: Reminder: Call Northwind Bakery (ring 1)", "f2",
                 "show f1", "show f1", "show f2", "drop f1"])
    }

    t.test("Done and Snooze reach the planner, through link.call when vyred does not carry it") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("link.call") { i in ["result": ["ok": true], "tool": VJ.s(i["tool"])] }
        let r: [String]? = t.wait {
            let p = await MainActor.run { PlannerBanners(vyred: VyredClient(socket: v.socket)) }
            _ = await p.vyred.refreshTools()
            let a = await p.act("done", firing: "f1")
            let b = await p.act("snooze", firing: "f2")
            return [a ?? "ok", b ?? "ok"] + v.callsOf("link.call").map { "\(VJ.s($0["tool"])) \(VJ.s(($0["input"] as? [String: Any])?["firing"]))" }
        }
        t.eq(r, ["ok", "ok", "planner.done f1", "planner.snooze f2"])
    }
}
