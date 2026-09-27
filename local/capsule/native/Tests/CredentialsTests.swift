// capsule-suite: credentialsSuite
// A module's missing key is added in the panel (Host/Credentials.swift): the row, vault.need's
// fields, saving through vault.connect or vault.put + vault.grant as the person, Esc, and the
// value never kept. FakeVyred stands in for vyred; no real vault, no real key.

import AppKit
import Foundation

/// Presence proven at once, and each proof's words kept: saving a key is the person's act.
final class CredProofs: @unchecked Sendable {
    private let lock = NSLock()
    private var said: [String] = []
    var summaries: [String] { lock.lock(); defer { lock.unlock() }; return said }
    var maker: @Sendable (String, [String: Any], String?) async -> Result<String, VyredFailure> {
        { [self] _, _, summary in lock.lock(); said.append(summary ?? ""); lock.unlock(); return .success("capsule key=k1 ts=1 nonce=n sig=s") }
    }
}

@MainActor private func credModel(_ v: FakeVyred, _ p: CredProofs = CredProofs()) -> CapsuleModel {
    let c = VyredClient(socket: v.socket)
    c.presenceProof = p.maker
    let m = CapsuleModel(home: vyScratch("cred-\(UUID().uuidString.prefix(6))"), vyred: c, providers: [])
    m.willShow(front: nil)
    return m
}

private func until(_ cond: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<150 { if await MainActor.run(body: cond) { return true }; try? await Task.sleep(nanoseconds: 20_000_000) }
    return false
}

private let deepgram = CredentialNeed(module: "voice", need: "deepgram", label: "Deepgram key", fields: [.init(name: "value", label: "Deepgram API key")], item: "voice-deepgram-key")

let credentialsSuite = Suite("credentials") { t in
    t.test("no vault.connect: vault.put then vault.grant as the person, then the module is told") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("vault.put") { _ in ["stored": true] }
        v.tool("vault.grant") { _ in ["grant": ["status": "granted"]] }
        let r: [String]? = t.wait {
            let proofs = CredProofs()
            let m = await MainActor.run { credModel(v, proofs) }
            _ = await until { m.vyred.isUp && m.vyred.has("vault.grant") }
            let saved = await MainActor.run { () -> Box in
                let b = Box()
                m.askCredential(deepgram) { b.hit = true }
                m.credentialAsk?.values["value"] = "dg-test-000"
                return b
            }
            let open = await MainActor.run { "\(CapsuleLayout.isOpen(m)) \(CapsuleLayout.footerHints(m).map(\.title))" }
            await m.saveCredential()
            let put = v.callsOf("vault.put").first, grant = v.callsOf("vault.grant").first
            return await MainActor.run {
                [open, VJ.s(put?["name"]), VJ.s((put?["fields"] as? [String: Any])?["value"]), VJ.s(grant?["module"]),
                 "\(saved.hit) \(m.credentialAsk == nil)", m.line ?? m.credentialAsk?.error ?? "", proofs.summaries.first ?? "no proof"]
            }
        }
        t.eq(r, ["true [\"Save in the vault\", \"Cancel\"]", "voice-deepgram-key", "dg-test-000", "voice", "true true", "Saved your Deepgram key in the vault.", "Save your Deepgram key in the vault for voice"])
    }

    t.test("vault.connect when vyred has it, with vault.need's fields; a failure stays on the row and clears the value") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        v.tool("vault.need") { _ in ["label": "Deepgram key", "help": "From console.deepgram.com", "how": ["kind": "field", "fields": [["name": "api_key", "label": "API key", "secret": true]]]] }
        let lock = NSLock(); var n = 0
        v.tool("vault.connect") { _ in lock.lock(); n += 1; let k = n; lock.unlock(); if k == 1 { return FakeError(code: "vault_locked", message: "the vault is locked") }; return ["connected": true] }
        let r: [String]? = t.wait {
            let m = await MainActor.run { credModel(v) }
            _ = await until { m.vyred.isUp && m.vyred.has("vault.connect") }
            await MainActor.run { m.askCredential(deepgram) {} }
            _ = await until { m.credentialAsk?.need.fields.first?.name == "api_key" }
            await MainActor.run { m.credentialAsk?.values["api_key"] = "dg-test-111" }
            await m.saveCredential()
            let first = await MainActor.run { [m.credentialAsk == nil ? "gone" : "still asked", m.credentialAsk?.values["api_key"] ?? "cleared"] }
            await MainActor.run { m.credentialAsk?.values["api_key"] = "dg-test-222" }
            await m.saveCredential()
            let c = v.callsOf("vault.connect")
            return first + [VJ.s(c.last?["module"]), VJ.s(c.last?["need"]), VJ.s((c.last?["fields"] as? [String: Any])?["api_key"]),
                            "\(v.callsOf("vault.put").count)", await MainActor.run { m.credentialAsk == nil ? "saved" : "open" }]
        }
        t.eq(r, ["still asked", "cleared", "voice", "deepgram", "dg-test-222", "0", "saved"])
    }

    t.test("Esc leaves it: nothing saved, and the panel says the key is still missing") {
        let v = FakeVyred(); v.start(); defer { v.stop() }
        let r: [String]? = t.wait {
            let m = await MainActor.run { credModel(v) }
            _ = await until { m.vyred.isUp }
            return await MainActor.run {
                m.askCredential(deepgram) {}
                m.credentialAsk?.values["value"] = "dg-test-333"
                let pc = PanelController(model: m)
                _ = pc.key(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!)
                return [m.credentialAsk == nil ? "gone" : "open", m.line ?? ""]
            }
        }
        t.eq(r, ["gone", "Not saved. Deepgram key is still missing."])
        t.eq(v.callsOf("vault.put").count + v.callsOf("vault.connect").count, 0)
    }
}

final class Box: @unchecked Sendable { var hit = false }
