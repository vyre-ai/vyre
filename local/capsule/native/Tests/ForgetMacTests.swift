// capsule-suite: forgetMacSuite
// Forgetting this Mac's identity (Host/ForgetMac.swift): the alert names the servers this Mac stops reaching, cleaned and cut short, and the yes takes the identity key and the relay key together.

import Foundation

let forgetMacSuite = Suite("forget mac") { t in
    t.test("the alert names the servers this Mac stops reaching, and says the same as before when there are none") {
        let none = ForgetMac.words(servers: [])
        t.ok(none.hasPrefix("This Mac will no longer be able to sign in to your name."))
        t.eq(ForgetMac.words(servers: ["testbox"]), "This Mac will no longer reach testbox. " + none)
        t.eq(ForgetMac.words(servers: ["testbox", "Harlow Legal"]), "This Mac will no longer reach testbox, Harlow Legal. " + none)
        t.ok(ForgetMac.words(servers: ["a", "b", "c", "d", "e", "f", "g"]).hasPrefix("This Mac will no longer reach a, b, c, d, e and 2 more. "))
    }

    t.test("the names the page sends are only shown: strings only, no control or direction marks, cut at 40, empty ones dropped") {
        t.eq(ForgetMac.serverNames(nil), [])
        t.eq(ForgetMac.serverNames("testbox"), [])
        t.eq(ForgetMac.serverNames(["test\nbox", 7, "  ", "a\u{202E}b", String(repeating: "x", count: 50)] as [Any]), ["testbox", "ab", String(repeating: "x", count: 40) + "..."])
    }

    t.test("the yes takes the identity key and the relay key together") {
        let id = MacIdentity(store: MemorySeedStore())
        let relay = MacRelayKey(store: MemoryEnclaveStore())
        _ = id.publicKey(create: true)
        _ = relay.publicKey(create: true)
        ForgetMac.forget(identity: id, relayKey: relay)
        t.ok(!id.has)
        t.eq(relay.publicKey(create: false), nil)
    }

    t.test("the page's bridge passes the servers to the forget and carries the relay key's own forget") {
        MainActor.assumeIsolated {
            for piece in ["call(\"identity.forget\", { servers:", "relay.forget"] { t.ok(VyreAppWindow.bridgeSource.contains(piece), piece) }
        }
    }
}
