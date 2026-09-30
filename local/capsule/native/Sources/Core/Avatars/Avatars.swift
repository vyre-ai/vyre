// Avatars: who gets which identity mark, and its SVG, by the rules the Deck's deck/js/avatars.js
// follows (ADR 0043, "Seeds, by family"), so the Capsule draws the very tile the Deck does:
//
//   person     a true circle seeded from owner.fingerprint8 (system.info, base64url, 8 bytes);
//              byte 0 picks the look. At 96 pt and up it can wear its Vyre code ring. With no
//              fingerprint (a box from before owner.id) the look comes from the name, and there is
//              never a ring, since a ring must only encode the real fingerprint.
//   assistant  the creature, seeded from assistant.fingerprint8 as hex, else from its name
//   agent      a blob, seeded from the agent's name (agents_agents' primary key)
//   teammate   a character seeded from its teammate id ("<role>-<project>"), wearing its
//              project's colour as a badge
//   project    a tile seeded from the project's avatar_seed (its slug when it has none), through
//              projectBytes; a chat in no project draws the dashed draft of its own id
//
// Pure: no state, no AppKit. AvatarView draws what svg(_:size:ring:) returns.

import Foundation

public enum AvatarFamily: String, Sendable, CaseIterable {
    case person, assistant, agent, teammate, project
}

public enum AvatarKind: Hashable, Sendable {
    /// The person. `fingerprint8`: system.info's owner.fingerprint8. `name`: the owner's name (or
    /// the host), for the look when there is no fingerprint.
    case person(fingerprint8: String?, name: String?)
    /// The assistant. `fingerprint8`: system.info's assistant.fingerprint8.
    case assistant(fingerprint8: String?, name: String?)
    /// An agent by its name.
    case agent(String)
    /// A teammate by its teammate id; `projectSeed` is its project's avatar_seed (or slug).
    case teammate(String, projectSeed: String?)
    /// A project by its avatar_seed (or slug); `draft` for a chat in no project, by its chat id.
    case project(seed: String, draft: Bool)

    public var family: AvatarFamily {
        switch self {
        case .person: return .person
        case .assistant: return .assistant
        case .agent: return .agent
        case .teammate: return .teammate
        case .project: return .project
        }
    }
}

public enum Avatars {
    /// How many looks the person's circle has.
    public static let personOptions = AvatarSVG.userGradients.count
    /// At or above this size the person's circle may wear its Vyre code ring.
    public static let ringAt: Double = 96

    /// A fingerprint as system.info sends it: base64url, 11 characters, 8 bytes. Anything else is
    /// nil. Like atob, the last character's two spare bits are ignored.
    public static func fingerprintBytes(_ s: String?) -> [UInt8]? {
        guard let s, s.utf8.count == 11 else { return nil }
        var sextets: [UInt8] = []
        for c in s.utf8 {
            let v: UInt8
            switch c {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"): v = c - UInt8(ascii: "A")
            case UInt8(ascii: "a")...UInt8(ascii: "z"): v = c - UInt8(ascii: "a") + 26
            case UInt8(ascii: "0")...UInt8(ascii: "9"): v = c - UInt8(ascii: "0") + 52
            case UInt8(ascii: "-"): v = 62
            case UInt8(ascii: "_"): v = 63
            default: return nil
            }
            sextets.append(v)
        }
        // 66 bits: the first ten characters give 60, the last its top 4.
        let acc = sextets.dropLast().reduce(UInt64(0)) { $0 << 6 | UInt64($1) } << 4 | UInt64(sextets[10] >> 2)
        return (0..<8).map { UInt8(truncatingIfNeeded: acc >> UInt64(56 - $0 * 8)) }
    }

    /// A project seed as the 8 bytes its tile reads: two FNV-1a words over "vyre:project:v1:" + seed.
    public static func projectBytes(_ seed: String) -> [UInt8] {
        let s = "vyre:project:v1:" + seed
        let a = AvatarHash.fnv(s), b = AvatarHash.fnv(s, basis: 0x811c9dc5 ^ 0x5bd1e995)
        return [a, b].flatMap { w in [24, 16, 8, 0].map { UInt8(truncatingIfNeeded: w >> UInt32($0)) } }
    }

    /// A project's colour (the hex a teammate's badge wears), from its seed.
    public static func projectColor(_ seed: String) -> String {
        AvatarSVG.projectColors[Int(projectBytes(seed)[0]) % AvatarSVG.projectColors.count]
    }

    /// A project's tile seed: its stored avatar_seed, else its slug (never its name).
    public static func projectSeed(slug: String, avatarSeed: String?) -> String {
        if let avatarSeed, !avatarSeed.isEmpty { return avatarSeed }
        return slug
    }

    /// The teammate id core/team gives a role in a project: "<role>-<project>", 31 UTF-16 units at
    /// most, without trailing dashes.
    public static func teammateId(role: String, project: String?) -> String {
        guard let project, !project.isEmpty else { return role }
        var units = Array("\(role)-\(project)".utf16.prefix(31))
        while units.last == UInt16(UInt8(ascii: "-")) { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }

    /// The SVG for one avatar, as the Deck's avatarSource draws it (dark theme). `px` is the
    /// drawing's own width and height: the Deck uses 120, or 40 and 24 for teammates.
    public static func source(_ family: AvatarFamily, seed: String, px: Int, fingerprint: [UInt8]? = nil,
                              ring: Bool = false, draft: Bool = false, color: String? = nil) -> String {
        switch family {
        case .person:
            let option = fingerprint.map { Int($0[0]) % personOptions } ?? Int(AvatarHash.fnv(seed) % UInt32(personOptions))
            if ring, let fp = fingerprint { return AvatarSVG.ring(fp: fp, option: option, size: px) }
            return AvatarSVG.person(option: option, size: px)
        case .assistant: return AvatarSVG.creature(seed: seed, size: px)
        case .agent: return AvatarSVG.blob(seed: seed, size: px)
        case .teammate: return AvatarSVG.character(seed: seed, size: px, projectColor: color)
        case .project: return AvatarSVG.project(bytes: projectBytes(seed), draft: draft, size: px)
        }
    }

    /// Whether this kind at this size draws the Vyre code ring: a person with a real fingerprint,
    /// asked for, at ringAt and up.
    public static func wearsRing(_ kind: AvatarKind, size: Double, ring: Bool) -> Bool {
        guard ring, size >= ringAt, case .person(let fp, _) = kind else { return false }
        return fingerprintBytes(fp) != nil
    }

    /// The SVG the Deck's avatar() puts in its span for this kind at this size.
    public static func svg(_ kind: AvatarKind, size: Double, ring: Bool = false) -> String {
        let wears = wearsRing(kind, size: size, ring: ring)
        switch kind {
        case .person(let fp, let name):
            let seed = "vyre:person:fallback:" + (name.flatMap { $0.isEmpty ? nil : $0 } ?? "you")
            return source(.person, seed: seed, px: 120, fingerprint: fingerprintBytes(fp), ring: wears)
        case .assistant(let fp, let name):
            let seed = fingerprintBytes(fp).map { $0.map { String(format: "%02x", $0) }.joined() }
                ?? "vyre:assistant:fallback:" + (name.flatMap { $0.isEmpty ? nil : $0 } ?? "vyre")
            return source(.assistant, seed: seed, px: 120)
        case .agent(let name):
            return source(.agent, seed: name, px: 120)
        case .teammate(let id, let project):
            let color = project.flatMap { $0.isEmpty ? nil : projectColor($0) }
            return source(.teammate, seed: id, px: size >= 32 ? 40 : 24, color: color)
        case .project(let seed, let draft):
            return source(.project, seed: seed, px: 120, draft: draft)
        }
    }

    /// A cache key for a drawing: what changes its SVG, and nothing else.
    public static func key(_ kind: AvatarKind, size: Double, ring: Bool) -> String {
        let band = kind.family == .teammate ? (size >= 32 ? "l" : "s") : ""
        return "\(kind)|\(band)|\(wearsRing(kind, size: size, ring: ring) ? "r" : "")"
    }
}
