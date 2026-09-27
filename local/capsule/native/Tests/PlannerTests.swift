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

    t.test("a ring with a key is shown and dropped by its key; planner.ringing gives the cursor") {
        let r: [String]? = t.wait {
            await MainActor.run {
                let p = PlannerBanners(vyred: VyredClient(socket: vyScratch("planner") + "/none.sock"))
                var log: [String] = []
                p.show = { f in log.append("show \(f.id)") }
                p.drop = { id in log.append("drop \(id)") }
                let since = p.absorbRinging(["ringing": [["firing": "f1", "key": "planner-i1-1800000000", "kind": "alarm", "title": "Wake"]], "last_event": 42])
                let old = p.absorbRinging([["firing": "f2", "kind": "timer", "title": "Tea"]])
                p.event(VyredEvent(id: 2, type: "planner.acked", source: "box", thread: nil, project: nil, at: 0,
                                   payload: ["firing": "f1", "key": "planner-i1-1800000000", "action": "done"]))
                p.stop()
                return [since, old] + log
            }
        }
        t.eq(r, ["42", "latest", "show planner-i1-1800000000", "show f2", "drop planner-i1-1800000000", "drop f1"])
    }

    t.test("the next 48 hours are scheduled here by key; past ones are left out; a key the box drops goes") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        var round = 0
        v.tool("planner.upcoming") { i in
            round += 1
            let rows: [[String: Any]] = round == 1
                ? [["key": "planner-a-2000", "kind": "timer", "title": "Tea", "at": 2_000_000, "loud": true],
                   ["key": "planner-b-500", "kind": "reminder", "title": "Past", "at": 500_000],
                   ["key": "planner-c-3000", "kind": "reminder", "title": "Call Northwind Bakery", "due": 3000]]
                : [["key": "planner-c-3000", "kind": "reminder", "title": "Call Northwind Bakery", "due": 3000]]
            return ["entries": rows, "last_event": 9, "hours": VJ.int(i["hours"]) ?? 0]
        }
        let r: [String]? = t.wait {
            let p = await MainActor.run { () -> PlannerBanners in
                let p = PlannerBanners(vyred: VyredClient(socket: v.socket)); p.now = { 1_000_000 }; return p
            }
            _ = await p.vyred.refreshTools()
            var got: [String] = []
            await MainActor.run { p.scheduled = { es in got.append(es.map { "\($0.key)@\(Int($0.at))" }.joined(separator: ",")) } }
            await p.refresh()
            let first = await MainActor.run { p.pendingKeys.sorted() }
            await p.refresh()
            let second = await MainActor.run { p.pendingKeys.sorted() }
            return got + first + ["|"] + second
        }
        t.eq(r, ["planner-a-2000@2000000,planner-c-3000@3000000", "planner-c-3000@3000000",
                 "planner-a-2000", "planner-c-3000", "|", "planner-c-3000"])
        t.eq(VJ.int(v.callsOf("planner.upcoming").first?["hours"]), 48)
    }

    t.test("a local ring answered with the box away is kept and sent by key once it is back") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        var away = true
        v.tool("planner.done") { _ in away ? FakeError(code: "box_unreachable", message: "the box is not reachable") as Any : ["ok": true] as Any }
        v.tool("planner.snooze") { _ in ["ok": true] }
        let r: [String]? = t.wait {
            let p = await MainActor.run { PlannerBanners(vyred: VyredClient(socket: v.socket)) }
            _ = await p.vyred.refreshTools()
            let said = await p.act("done", firing: "planner-a-2000", key: "planner-a-2000")
            let held = await MainActor.run { p.unsent.map(\.key) }
            away = false
            await p.flush()
            let after = await MainActor.run { p.unsent.count }
            _ = await p.act("snooze", firing: "f9")
            return [said ?? "quiet"] + held + ["\(after)"]
        }
        t.eq(r, ["quiet", "planner-a-2000", "0"])
        t.eq(v.callsOf("planner.done").map { VJ.s($0["key"]) }, ["planner-a-2000", "planner-a-2000"])
        t.eq(VJ.s(v.callsOf("planner.snooze").first?["firing"]), "f9")
        t.eq(VJ.int(v.callsOf("planner.snooze").first?["minutes"]), 9)
    }
}
