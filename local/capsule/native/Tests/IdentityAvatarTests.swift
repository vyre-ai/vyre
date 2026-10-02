// capsule-suite: identitySuite
// Who is who, and their marks where the Capsule shows people and answers: system.info read once
// per show (and a vyred without fingerprints falling back to the no-fingerprint look), the mark
// beside who answers, the session panel's marks, and the popover's account row and a reply,
// drawn off screen. Set VYRE_CAPSULE_SNAP to a folder to keep the pictures. Synthetic ids only.

import AppKit
import Combine
import SwiftUI

@MainActor private func whoModel(_ v: FakeVyred) -> CapsuleModel {
    CapsuleModel(home: vyScratch("who-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<250 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

private let alexInfo: [String: Any] = [
    "owner": ["name": "alex", "fingerprint8": "69KF_EuRYLs"],
    "assistant": ["name": "juno", "fingerprint8": "DTCMNH7pqXE"],
]

/// A view drawn off screen (no window), its PNG kept when VYRE_CAPSULE_SNAP names a folder.
@MainActor private func draw<V: View>(_ view: V, _ size: NSSize?, _ name: String) -> NSBitmapImageRep? {
    let host = NSHostingView(rootView: view)
    host.appearance = NSAppearance(named: .darkAqua)
    host.frame = NSRect(origin: .zero, size: size ?? host.fittingSize)
    host.layoutSubtreeIfNeeded()
    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
    host.cacheDisplay(in: host.bounds, to: rep)
    if let dir = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SNAP"], let png = rep.representation(using: .png, properties: [:]) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }
    return rep
}

let identitySuite = Suite("identities") { t in
    t.test("system.info's owner and assistant; any part missing is nil") {
        let who = Identities.from(alexInfo)
        t.eq(who, Identities(ownerFP: "69KF_EuRYLs", ownerName: "alex", assistantFP: "DTCMNH7pqXE", assistantName: "juno"))
        t.eq(who.person, .person(fingerprint8: "69KF_EuRYLs", name: "alex"))
        t.eq(who.assistant("Vyre"), .assistant(fingerprint8: "DTCMNH7pqXE", name: "juno"))
        // An older vyred: names only, or nothing.
        let old = Identities.from(["owner": ["name": "alex"], "assistant": ["name": ""]])
        t.eq(old, Identities(ownerName: "alex"))
        t.eq(old.assistant("juno"), .assistant(fingerprint8: nil, name: "juno"), "no fingerprint: seeded from the name")
        t.eq(Identities.from([:]), Identities())
    }

    t.test("willShow reads system.info once per show, and an unchanged owner changes nothing") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("system.info") { _ in alexInfo }
        let m = MainActor.assumeIsolated { whoModel(v) }
        let changes = ResultBox<Int>(); changes.value = 0
        let sink = MainActor.assumeIsolated { m.$identities.dropFirst().sink { _ in changes.value! += 1 } }
        defer { sink.cancel() }
        MainActor.assumeIsolated { m.willShow(front: nil) }
        let loaded = t.wait { await until { m.identities.ownerFP == "69KF_EuRYLs" } }
        t.ok(loaded == true, "identities loaded on open")
        MainActor.assumeIsolated { m.didHide(); m.willShow(front: nil) }
        _ = t.wait { await until { v.callsOf("system.info").count == 2 } }
        _ = t.wait { try? await Task.sleep(nanoseconds: 80_000_000) }
        t.eq(v.callsOf("system.info").count, 2, "one read per show")
        t.eq(changes.value, 1, "the second, identical answer published nothing")
        MainActor.assumeIsolated {
            t.eq(m.identities.assistantName, "juno")
            m.didHide()
        }
    }

    t.test("a vyred without system.info, or an error, keeps the no-fingerprint look") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let m = MainActor.assumeIsolated { whoModel(v) }
        _ = t.wait { _ = await m.vyred.refreshTools(); await m.loadIdentities() }
        MainActor.assumeIsolated {
            t.eq(m.identities, Identities())
            t.eq(m.replyAvatar, .assistant(fingerprint8: nil, name: "Vyre"))
        }
        v.tool("system.info") { _ in FakeError(code: "internal", message: "no") }
        _ = t.wait { _ = await m.vyred.refreshTools(); await m.loadIdentities() }
        MainActor.assumeIsolated { t.eq(m.identities, Identities()) }
    }

    t.test("who answers: an agent's blob, else the assistant's creature") {
        MainActor.assumeIsolated {
            let m = snapModel([])
            m.identities = Identities.from(alexInfo)
            m.catalog = VyreCatalog(agents: [VyreAgent(name: "juno", kind: "assistant"), VyreAgent(name: "kit", kind: "agent")], projects: [], threads: [])
            t.eq(m.replyAvatar, .assistant(fingerprint8: "DTCMNH7pqXE", name: "juno"), "no target: Vyre IQ, the assistant")
            m.target = VyreCandidate(kind: .agent, id: "kit", label: "kit")
            t.eq(m.replyAvatar, .agent("kit"))
            m.target = VyreCandidate(kind: .agent, id: "juno", label: "juno")
            t.eq(m.replyAvatar, .assistant(fingerprint8: "DTCMNH7pqXE", name: "juno"), "the assistant picked by name is still its creature")
            m.target = VyreCandidate(kind: .thread, id: "t1", label: "Northwind menu")
            t.eq(m.replyAvatar, .assistant(fingerprint8: "DTCMNH7pqXE", name: "juno"))
            t.eq(DirectView.mark("kit", who: m.identities, assistant: "juno"), .agent("kit"))
            t.eq(DirectView.mark("juno", who: m.identities, assistant: "juno"), .assistant(fingerprint8: "DTCMNH7pqXE", name: "juno"))
        }
    }

    t.test("the session panel: the thread's agent's blob, else the creature; the person on the user's lines") {
        let s = PanelSession.load(agents: [["name": "juno", "kind": "assistant", "thread": "t1"]],
                                  threads: [["id": "t2", "name": "Harlow intake", "agent": "kit"], ["id": "t3", "name": "Northwind menu"]])
        t.eq(s.map(\.runBy), [nil, "kit", nil])
        let link = FakeLink { tool, _ in tool == "system.info" ? .success(alexInfo) : .failure(code: "no_such_tool", message: tool) }
        let r = t.wait { @MainActor () -> [String] in
            let p = SessionPanelModel(vyred: link)
            p.start()
            for _ in 0..<100 where p.identities.ownerFP == nil { try? await Task.sleep(nanoseconds: 10_000_000) }
            var out: [String] = []
            for x in s { p.shown = x; out.append("\(p.replyLabel) \(p.replyAvatar)") }
            p.stop()
            return out
        }
        t.eq(r?[0], "juno \(AvatarKind.assistant(fingerprint8: "DTCMNH7pqXE", name: "juno"))")
        t.eq(r?[1], "kit \(AvatarKind.agent("kit"))", "a thread an agent runs is labelled and marked as that agent")
        t.eq(r?[2], "juno \(AvatarKind.assistant(fingerprint8: "DTCMNH7pqXE", name: "juno"))")
    }

    t.test("the popover's account row and a reply row draw with their marks, off screen") {
        let ok: [Bool] = MainActor.assumeIsolated {
            var out: [Bool] = []
            let who = Identities.from(alexInfo)
            // The marks themselves, as the rows host them: painted, not blank.
            let mark = draw(AvatarView(who.person, size: 24), NSSize(width: 24, height: 24), "who-0-mark")
            out.append((mark?.colorAt(x: mark!.pixelsWide / 2, y: mark!.pixelsHigh / 2)?.alphaComponent ?? 0) > 0.99)
            let h = Health(vyred: VyredClient(socket: vyScratch("who") + "/none.sock"))
            h.set(up: true)
            let pop = draw(MenuBarPopover(health: h, identities: who, hotkeys: "⌥Space", canTurnOnControl: false, open: {}, turnOnControl: {}, quit: {}), nil, "who-1-popover")
            out.append((pop?.pixelsWide ?? 0) > 0)
            let m = snapModel([])
            m.identities = who
            m.asked = "what is on the Northwind Bakery menu"
            var r = VyState.reply("q1"); r.model = "haiku"; r.finished = true; r.ok = true
            r.order = ["m"]; r.text = ["m": "Rye, sourdough and a seeded spelt loaf, from the menu you wrote on Tuesday."]
            m.reply = r
            m.askedMemory = MemoryAnswer(text: m.asked!, answer: "Rye and sourdough.", answerKind: .said, confidence: 0.7,
                                         sources: [MemorySource(kind: .quote, role: "user", session: "a1", seq: 4, name: "Northwind menu",
                                                                quote: "The menu is rye and sourdough.", age: "1 day")])
            m.memoryExpanded = true
            let reply = draw(CapsuleView(model: m, focus: FocusTicket(), snapshot: true), NSSize(width: Theme.width, height: CapsuleLayout.panelHeight(m)), "who-2-reply")
            out.append((reply?.pixelsWide ?? 0) > 0)
            let p = SessionPanelModel(vyred: FakeLink { _, _ in .failure(code: "no", message: "no") })
            p.identities = who; p.assistantName = "juno"
            p.shown = PanelSession(id: "agent:juno", label: "juno", kind: .assistant("juno"), thread: "t1")
            var dm = VyState.dm("juno", thread: "t1", limit: 60)
            dm.messages = [DmMessage(id: "1", role: .user, text: "what is on the menu", at: 1, surface: nil, done: nil),
                           DmMessage(id: "2", role: .agent, text: "Rye and sourdough.", at: 2, surface: nil, done: true)]
            p.dm = dm
            let side = draw(SessionPanelView(model: p, close: {}), NSSize(width: 360, height: 300), "who-3-session")
            out.append((side?.pixelsWide ?? 0) > 0)
            return out
        }
        t.eq(ok, [true, true, true, true])
    }
}
