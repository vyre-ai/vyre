// capsule-suite: loosenedSuite
// settings.loosened: a guard an agent changed because the person asked, shown with fixed words and an Undo.

import Foundation

let loosenedSuite = Suite("settings loosened") { t in
    t.test("the event shows '<label> changed, as you asked.' under the empty box; Undo calls settings.undo with the change and clears it") {
        let v = FakeVyred(name: "loosened")
        v.tool("settings.undo") { _ in ["ok": true] }
        t.ok(v.start()); defer { v.stop() }
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let m = CapsuleModel(home: vyScratch("loosened-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            m.isShown = { true }
            m.noticeLoosened(["change": "chg_1", "key": "claude.autoApprove", "label": "Auto-approve edits", "by": "mcp:agent:kit"])
            var out = [m.loosened?.words ?? "-", "shown \(m.loosenedShown)"]
            m.text = "typing"
            out.append("while typing \(m.loosenedShown)")
            m.text = ""
            await m.undoLoosened()
            out.append("undo asked \(v.callsOf("settings.undo").map { $0["change"] as? String ?? "-" })")
            out.append("after \(m.loosened == nil)")
            return out
        }
        t.eq(r, ["Auto-approve edits changed, as you asked.", "shown true", "while typing false", "undo asked [\"chg_1\"]", "after true"])
    }

    t.test("an event with no change id shows nothing; a missing label falls back to the key") {
        MainActor.assumeIsolated {
            let v = FakeVyred(name: "loosened2")
            let m = CapsuleModel(home: vyScratch("loosened2-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            m.isShown = { true }
            m.noticeLoosened(["label": "x"])
            t.ok(m.loosened == nil)
            m.noticeLoosened(["change": "c", "key": "claude.autoApprove"])
            t.eq(m.loosened?.words, "claude.autoApprove changed, as you asked.")
        }
    }
}
