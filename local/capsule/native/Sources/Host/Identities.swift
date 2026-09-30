// Identities: who the person and the assistant are, from system.info, for their marks
// (Sources/Core/Avatars, ADR 0043). Read once per Capsule show beside the models; an older vyred
// without owner or assistant fingerprints leaves them nil, and the marks draw their no-fingerprint
// look. Nothing here is a secret: fingerprint8 is the public 8-byte id the Vyre code encodes.

import Foundation

public struct Identities: Equatable, Sendable {
    public var ownerFP: String?
    public var ownerName: String?
    public var assistantFP: String?
    public var assistantName: String?

    public init(ownerFP: String? = nil, ownerName: String? = nil, assistantFP: String? = nil, assistantName: String? = nil) {
        self.ownerFP = ownerFP; self.ownerName = ownerName; self.assistantFP = assistantFP; self.assistantName = assistantName
    }

    /// system.info's data: owner {name, fingerprint8} and assistant {name, fingerprint8}, any missing.
    public static func from(_ d: [String: Any]) -> Identities {
        let o = d["owner"] as? [String: Any], a = d["assistant"] as? [String: Any]
        return Identities(ownerFP: VJ.nonEmpty(o?["fingerprint8"]), ownerName: VJ.nonEmpty(o?["name"]),
                          assistantFP: VJ.nonEmpty(a?["fingerprint8"]), assistantName: VJ.nonEmpty(a?["name"]))
    }

    /// The person's circle.
    public var person: AvatarKind { .person(fingerprint8: ownerFP, name: ownerName) }
    /// The assistant's creature; `name` is the fallback seed when there is no fingerprint.
    public func assistant(_ name: String? = nil) -> AvatarKind { .assistant(fingerprint8: assistantFP, name: assistantName ?? name) }
}

extension CapsuleModel {
    /// Reads system.info and keeps who is who. The published value changes only when the answer
    /// does, so an unchanged owner redraws nothing. A vyred without the tool, or an error, keeps
    /// what was known.
    func loadIdentities() async {
        guard vyred.has("system.info") else { return }
        let r = await vyred.call("system.info", [:], presence: false)
        guard r.error == nil, let d = r.data as? [String: Any] else { return }
        let next = Identities.from(d)
        if next != identities { identities = next }
    }

    /// The mark beside who answers: an agent's blob when the answer comes from an agent other
    /// than the assistant, else the assistant's creature (Vyre IQ, a quick or deeper answer, a
    /// session's).
    public var replyAvatar: AvatarKind {
        if reply?.queued == nil, let c = target, c.kind == .agent, c.id != catalog.assistant?.name, c.id != identities.assistantName {
            return .agent(c.id)
        }
        return identities.assistant(assistantName)
    }
}
