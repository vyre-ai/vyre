// ForgetMac: what forgetting this Mac's identity takes with it, and the words the shell's own alert says first. Forgetting the identity also lets go of every server this Mac reaches: the page releases
// its pairings, and the shell drops the relay key those pairings were made with (MacRelayKey.swift), so no server knows this Mac afterwards. The alert names those servers, so the person sees what goes
// before saying yes. The names come from the page and are only shown, never acted on: they are cleaned of control characters and cut short, and at most five are listed.

import Foundation

enum ForgetMac {
    static let title = "Forget this Mac's key?"

    /// The server names the page sent, as the alert shows them: strings only, no control characters, at most 40 characters each, empty ones dropped.
    static func serverNames(_ raw: Any?) -> [String] {
        guard let list = raw as? [Any] else { return [] }
        return list.compactMap { $0 as? String }.map { s -> String in
            let t = String(s.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f && !(0x2028...0x202e).contains($0.value) && !(0x2066...0x2069).contains($0.value) }.map(Character.init)).trimmingCharacters(in: .whitespaces)
            return t.count > 40 ? String(t.prefix(40)) + "..." : t
        }.filter { !$0.isEmpty }
    }

    /// The alert's text: who this Mac stops reaching, then what is lost and how to get back in.
    static func words(servers: [String]) -> String {
        let after = "This Mac will no longer be able to sign in to your name. You can get back in with your recovery code or another device."
        guard !servers.isEmpty else { return after }
        let shown = servers.prefix(5).joined(separator: ", ") + (servers.count > 5 ? " and \(servers.count - 5) more" : "")
        return "This Mac will no longer reach \(shown). " + after
    }

    /// The forgetting itself, after the yes: the identity key, then the relay key every pairing used.
    static func forget(identity: MacIdentity, relayKey: MacRelayKey?) {
        identity.forget()
        relayKey?.forget()
    }
}
