// VoiceCommands: the three command words chat's tap-to-talk recognises at the very end of a
// settled phrase (deck/chat/composer.js's VOICE_COMMANDS) -- ported here so the Capsule's own
// talk chord understands the same "send it", "new line" and "scratch that". Pure and static, so
// it is tested with no mic, no stream and no host.

import Foundation

enum VoiceCommandKind: Equatable { case send, newLine, scratch }

enum VoiceCommands {
    private static let patterns: [(VoiceCommandKind, NSRegularExpression)] = [
        (.send, unsafe("\\s*\\bsend it\\b\\.?\\s*$")),
        (.newLine, unsafe("\\s*\\bnew line\\b\\.?\\s*$")),
        (.scratch, unsafe("\\s*\\bscratch that\\b\\.?\\s*$")),
    ]
    /// Three fixed, hand-checked patterns, never user input, so a force-try never fails at runtime.
    private static func unsafe(_ pattern: String) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    /// A command word (and any whitespace/punctuation before it) at the very end of `text`, or
    /// nil -- checked only against a settled phrase (Talker's `.heard(_, final: true)`), never a
    /// live partial, so a still-changing guess never fires one early.
    static func match(_ text: String) -> (kind: VoiceCommandKind, index: String.Index)? {
        let ns = text as NSString
        let whole = NSRange(location: 0, length: ns.length)
        for (kind, re) in patterns {
            guard let m = re.firstMatch(in: text, range: whole), let r = Range(m.range, in: text) else { continue }
            return (kind, r.lowerBound)
        }
        return nil
    }
}
