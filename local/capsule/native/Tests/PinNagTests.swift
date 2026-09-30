// capsule-suite: pinNagSuite
// presence.capsule.pin without nagging (Host/CapsulePin.swift): Touch ID is asked only when vyred
// can pin this build (signed, not ad hoc), and a refusal is remembered for the process, so a
// reconnect never asks again. The proof is a fake that counts; vyred is a FakeVyred.

import Foundation

@MainActor private func pinner(_ v: FakeVyred, adhoc: Bool, approve: Bool = true, asked: @escaping () -> Void) -> CapsulePresence {
    let p = CapsulePresence(home: vyScratch("pin-nag-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), store: MemoryKeyStore())
    p.ownSignature = { CapsuleSignature(cdhash: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12", adhoc: adhoc) }
    p.pinProof = { _, _, _ in
        asked()
        return approve ? .success("capsule key=k1 ts=1 sig=x") : .failure(VyredFailure("Not approved. Nothing was done."))
    }
    return p
}

let pinNagSuite = Suite("pin without nagging") { t in
    t.test("an ad hoc build is never asked: no Touch ID, no call, on any number of reconnects") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        var calls = 0
        v.tool("presence.capsule.pin") { _ in calls += 1; return ["pinned": true] }
        let out: (Int, CapsulePresence.PinStep)? = t.wait {
            var asks = 0
            let p = await MainActor.run { pinner(v, adhoc: true) { asks += 1 } }
            for _ in 0..<3 { await p.pinSelf() }
            return (asks, await MainActor.run { p.pinStep() })
        }
        t.eq(out?.0, 0)
        t.eq(out?.1, .adhoc)
        t.eq(calls, 0)
    }

    t.test("vyred refuses a signed build once: remembered, so the next reconnect asks nothing") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        var calls = 0
        v.tool("presence.capsule.pin") { _ in calls += 1; return FakeError(code: "denied", message: "This Capsule is ad-hoc signed") }
        let out: (Int, CapsulePresence.PinStep)? = t.wait {
            var asks = 0
            let p = await MainActor.run { pinner(v, adhoc: false) { asks += 1 } }
            for _ in 0..<3 { await p.pinSelf() }
            return (asks, await MainActor.run { p.pinStep() })
        }
        t.eq(out?.0, 1, "one Touch ID, not one per reconnect")
        t.eq(out?.1, .refusedBefore)
        t.eq(calls, 1)
    }

    t.test("Not now is remembered too; a pinned build is asked once and never again") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        var calls = 0
        v.tool("presence.capsule.pin") { _ in calls += 1; return ["pinned": true] }
        let out: (Int, Int)? = t.wait {
            var declined = 0, pinned = 0
            let a = await MainActor.run { pinner(v, adhoc: false, approve: false) { declined += 1 } }
            await a.pinSelf(); await a.pinSelf()
            let b = await MainActor.run { pinner(v, adhoc: false) { pinned += 1 } }
            await b.pinSelf(); await b.pinSelf()
            return (declined, pinned)
        }
        t.eq(out?.0, 1, "declined: asked once")
        t.eq(out?.1, 1, "pinned: asked once")
        t.eq(calls, 1, "only the approved one reached vyred")
    }

    t.test("a call that fails for another reason (vyred down a moment) is tried again next time") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("presence.capsule.pin") { _ in FakeError(code: "internal", message: "busy") }
        let out: CapsulePresence.PinStep? = t.wait {
            let p = await MainActor.run { pinner(v, adhoc: false) {} }
            await p.pinSelf()
            return await MainActor.run { p.pinStep() }
        }
        t.eq(out, .ask("ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12"))
    }

    t.test("this test binary's own signature reads, and the linker's ad hoc signature says so") {
        let s = CapsulePresence.readOwnSignature()
        t.ok((s?.cdhash.count ?? 0) >= 40)
        t.eq(s?.adhoc, true, "swiftc signs a test binary ad hoc")
    }
}
