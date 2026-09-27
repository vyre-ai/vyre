// Credentials: a module's missing key, added in the panel, never through a terminal detour.
//
// A module that needs a key (voice's Deepgram key, and any other through vault's needs) asks the
// host (CapsuleHost.askCredential). The panel shows "Add your Deepgram key" with a secure field
// per field the need has; ⏎ saves, Esc leaves it. Saving is the person's act, so it goes as the
// person (Touch ID in the panel when presence is asked):
//   - vault.connect {module, need, fields} where vyred has it (ADR 0028 decision 9: one call
//     stores, grants and records the connection), with its fields and help from vault.need;
//   - else vault.put then vault.grant {name, module}, the same pair `vyre voice key` makes.
// The typed value lives only in the field and the one call, and is cleared either way.

import Foundation
import SwiftUI

@MainActor final class CredentialAsk: ObservableObject, Identifiable {
    @Published var need: CredentialNeed
    @Published var values: [String: String] = [:]
    @Published var saving = false
    @Published var error: String?
    let saved: @MainActor () -> Void
    init(_ need: CredentialNeed, saved: @escaping @MainActor () -> Void) { self.need = need; self.saved = saved }

    var ready: Bool { need.fields.allSatisfy { !(values[$0.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }
}

extension CapsuleModel {
    /// Show the row for a module's need. Its field list and help come from vault.need when vyred
    /// has it; the need as the module gave it otherwise.
    func askCredential(_ need: CredentialNeed, saved: @escaping @MainActor () -> Void) {
        let a = CredentialAsk(need, saved: saved)
        credentialAsk = a
        line = nil
        guard vyred.has("vault.need") else { return }
        Task { @MainActor [vyred] in
            let r = await vyred.call("vault.need", ["module": need.module, "need": need.need], presence: false)
            guard self.credentialAsk === a, let d = Self.needData(r.data, need: need.need) else { return }
            a.need = Self.merge(need, d)
        }
    }

    /// The one need in a vault.need answer: the object itself, or the one named in its list.
    nonisolated static func needData(_ data: Any?, need: String) -> [String: Any]? {
        guard let d = data as? [String: Any] else { return nil }
        if let list = d["needs"] as? [[String: Any]] { return list.first { VJ.s($0["id"]) == need || VJ.s($0["need"]) == need } }
        return d
    }

    /// vault.need's label, help and fields over what the module said.
    nonisolated static func merge(_ n: CredentialNeed, _ d: [String: Any]) -> CredentialNeed {
        var out = n
        if let l = VJ.nonEmpty(d["label"]) { out.label = l }
        if let h = VJ.nonEmpty(d["help"]) { out.help = h }
        let how = d["how"] as? [String: Any]
        if let fs = (how?["fields"] ?? d["fields"]) as? [[String: Any]], !fs.isEmpty {
            out.fields = fs.map { CredentialNeed.Field(name: VJ.nonEmpty($0["name"]) ?? "value", label: VJ.nonEmpty($0["label"]) ?? "Key", secret: $0["secret"] as? Bool ?? true) }
        }
        return out
    }

    /// ⏎ on the row: save it through the vault as the person, then tell the module.
    func saveCredential() async {
        guard let a = credentialAsk, a.ready, !a.saving else { return }
        a.saving = true; a.error = nil
        let n = a.need
        var fields: [String: Any] = [:]
        for f in n.fields { fields[f.name] = (a.values[f.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        a.values = [:]
        let summary = "Save your \(n.label) in the vault for \(n.module)"
        var why: String?
        var note: String?
        if vyred.has("vault.connect") {
            let r = await vyred.call("vault.connect", ["module": n.module, "need": n.need, "fields": fields, "label": n.label], presence: true, summary: summary)
            why = Bridge.explain(r)
            let d = (r.data as? [String: Any]) ?? [:]
            // An OAuth need stores nothing here: vault names the next call (the sign-in).
            if why == nil, let next = d["next"] as? [String: Any], let tool = VJ.nonEmpty(next["tool"]) {
                why = Bridge.explain(await vyred.call(tool, (next["input"] as? [String: Any]) ?? [:], presence: true, summary: "Connect \(n.label)"))
            }
            if why == nil, VJ.s((d["grant"] as? [String: Any])?["status"]) == "pending" {
                note = "Saved. Waiting for approval before \(n.module) can use it."
            }
        } else if let item = n.item {
            let put = await vyred.call("vault.put", ["name": item, "kind": "api-key", "fields": fields, "description": "\(n.label) for \(n.module)"], presence: true, summary: summary)
            why = Bridge.explain(put)
            if why == nil {
                let g = await vyred.call("vault.grant", ["name": item, "module": n.module], presence: true, summary: "Let \(n.module) use your \(n.label)")
                why = Bridge.explain(g)
                if why == nil, VJ.s(((g.data as? [String: Any])?["grant"] as? [String: Any])?["status"]) == "pending" {
                    note = "Saved. The vault holds the grant for your approval before \(n.module) can use it."
                }
            }
        } else {
            why = "This vyred cannot save keys from the Capsule yet (no vault.connect)."
        }
        fields = [:]
        a.saving = false
        guard credentialAsk === a else { return }
        if let why { a.error = why; return }
        credentialAsk = nil
        if let note { line = note } else { flash("Saved your \(n.label) in the vault.") }
        if note == nil { a.saved() }
    }

    /// Esc on the row: nothing is saved.
    func cancelCredential() {
        guard let a = credentialAsk else { return }
        a.values = [:]
        credentialAsk = nil
        line = "Not saved. \(a.need.label.prefix(1).uppercased() + a.need.label.dropFirst()) is still missing."
    }
}
