// AvatarSVG: the five identity families of ADR 0043 as SVG source, a line-for-line port of the
// Deck's locked renderers at native-core a1d8ac72 (web/vendor/vyrecode: identity.js's userAvatar,
// creature.js, characters.js's blob and character, project.js, vyrecode2.js's renderCode2 with the
// ticksSunburst style, and payload.js/rs.js for the ring's codeword). Dark theme only: the
// Capsule is always dark.
//
// The output is the Deck's markup byte for byte, whitespace included, so every template below
// keeps the JS template literal's own line breaks and indentation. Change nothing here without
// the same change landing in web/vendor/vyrecode first; Tests/AvatarTests.swift holds vectors
// printed by the JS and fails on any drift.

import Foundation

enum AvatarSVG {
    static let ink = "#141311"
    static let lightInk = "#F1EEE6"

    private static func n(_ x: Double) -> String { JSNumber.string(x) }
    private static func open(_ size: Int, _ box: Int = 120) -> String {
        #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \#(box) \#(box)" width="\#(size)" height="\#(size)">"#
    }

    // ---- palettes (identity.js, dark) --------------------------------------------------------

    static let userGradients = [("#F7C9A6", "#EE9B6B"), ("#F6E0A6", "#EFC15E"), ("#F3B3C4", "#E6789A"), ("#A9E0C9", "#5FBE95")]
    static let skinTones = ["#FBE0C6", "#F1C79B", "#E0AC7C", "#C98A57", "#A8683D", "#7D4C2C", "#5C3620", "#3E2417"]
    static let projectColors = ["#A34F3E", "#DA932F", "#2FDA4B", "#2FDA93", "#2FDADA", "#2F93DA", "#B620AA", "#BC2F6A"]
    static let backdrops = ["#111110", "#1A1917", "#221F1C"]
    static let rim = (color: lightInk, opacity: 0.55)
    static let contrastFloor = 3.0

    /// featureInkFor: dark ink wherever it clears the floor against this colour, else light.
    static func featureInk(_ hex: String) -> String {
        AvatarColour.contrast(hex, ink) >= contrastFloor ? ink : lightInk
    }
    /// needsRim(hex, "dark"): the colour fails the floor against some dark backdrop.
    static func needsRim(_ hex: String) -> Bool {
        backdrops.contains { AvatarColour.contrast(hex, $0) < contrastFloor }
    }

    // ---- person (identity.js userAvatar) -----------------------------------------------------

    static func person(option: Int, size: Int) -> String {
        let (c1, c2) = userGradients[option % userGradients.count]
        let gid = "ug\(option)"
        let face = option % 2 == 0
            ? #"<path d="M44 54 Q48 50 52 54" stroke="\#(ink)" stroke-width="3" fill="none" stroke-linecap="round"/>"#
                + "\n       " + #"<path d="M68 54 Q72 50 76 54" stroke="\#(ink)" stroke-width="3" fill="none" stroke-linecap="round"/>"#
                + "\n       " + #"<path d="M50 68 Q60 76 70 68" stroke="\#(ink)" stroke-width="3.5" fill="none" stroke-linecap="round"/>"#
            : #"<circle cx="48" cy="54" r="4" fill="\#(ink)"/><circle cx="72" cy="54" r="4" fill="\#(ink)"/>"#
                + "\n       " + #"<path d="M50 68 Q60 74 70 68" stroke="\#(ink)" stroke-width="3.5" fill="none" stroke-linecap="round"/>"#
        return open(size)
            + "\n    " + #"<defs><radialGradient id="\#(gid)" cx="35%" cy="30%" r="80%">"#
            + "\n      " + #"<stop offset="0%" stop-color="\#(c1)"/><stop offset="100%" stop-color="\#(c2)"/>"#
            + "\n    </radialGradient></defs>"
            + "\n    " + #"<circle cx="60" cy="60" r="58" fill="url(#\#(gid))"/>"#
            + "\n    " + face
            + "\n  </svg>"
    }

    // ---- assistant (creature.js) -------------------------------------------------------------

    static let creaturePastels = ["#F6B8C8", "#B8D9F0", "#C9E8B8", "#F0D48A", "#F0C9A0", "#8AD9C4", "#F0A88A"]

    /// A soft closed outline through `pts`: quadratic curves between midpoints, as both the
    /// creature and the blob draw it.
    private static func outline(_ pts: [(Double, Double)]) -> String {
        var d = "M \(n(pts[0].0)),\(n(pts[0].1)) "
        for i in 0..<pts.count {
            let (x0, y0) = pts[i], (x1, y1) = pts[(i + 1) % pts.count]
            d += "Q \(n(x0)),\(n(y0)) \(n((x0 + x1) / 2)),\(n((y0 + y1) / 2)) "
        }
        return d + "Z"
    }

    static func creature(seed: String, size: Int) -> String {
        var rnd = AvatarRandom("creature:" + seed)
        let color = rnd.pick(creaturePastels)
        let cx = 60.0, cy = 68.0, bodyR = 38.0
        var pts: [(Double, Double)] = []
        for i in 0..<8 {
            let a = AvatarTrig.at(AvatarTrig.creature[i])
            let r = bodyR * (0.94 + rnd.next() * 0.12)
            pts.append((cx + a.cos * r, cy + a.sin * r * 1.05))
        }
        let d = outline(pts)
        let ears = #"<circle cx="\#(n(cx - 18))" cy="\#(n(cy - bodyR - 2))" r="7" fill="\#(color)"/>"#
            + "\n    " + #"<circle cx="\#(n(cx + 18))" cy="\#(n(cy - bodyR - 2))" r="7" fill="\#(color)"/>"#
        let ts: Double = rnd.next() > 0.5 ? 1 : -1
        let tail = #"<path d="M \#(n(cx + ts * (bodyR - 4))) \#(n(cy + 14)) Q \#(n(cx + ts * (bodyR + 18))) \#(n(cy + 20)) \#(n(cx + ts * (bodyR + 10))) \#(n(cy + 2))""#
            + "\n    " + #"stroke="\#(color)" stroke-width="7" fill="none" stroke-linecap="round"/>"#
        let halo = #"<circle cx="\#(n(cx))" cy="\#(n(cy))" r="\#(n(bodyR + 14))" fill="\#(color)" opacity="0.18"/>"#
        let ex = 12.0, ey = 4.0
        let sparkleSide: Double = rnd.next() > 0.5 ? -1 : 1
        let eyes = #"<circle cx="\#(n(cx - ex))" cy="\#(n(cy - ey))" r="5" fill="\#(ink)"/>"#
            + "\n    " + #"<circle cx="\#(n(cx + ex))" cy="\#(n(cy - ey))" r="5" fill="\#(ink)"/>"#
            + "\n    " + #"<circle cx="\#(n(cx + sparkleSide * ex - 1.5))" cy="\#(n(cy - ey - 1.5))" r="1.4" fill="\#(lightInk)"/>"#
        let mouth = rnd.next() > 0.5
            ? #"<path d="M \#(n(cx - 7)) \#(n(cy + 12)) Q \#(n(cx)) \#(n(cy + 17)) \#(n(cx + 7)) \#(n(cy + 12))" stroke="\#(ink)" stroke-width="2.6" fill="none" stroke-linecap="round"/>"#
            : ""
        return open(size) + "\n    " + halo + tail + ears + #"<path d="\#(d)" fill="\#(color)"/>"# + eyes + mouth + "\n  </svg>"
    }

    // ---- agent (characters.js blob) ----------------------------------------------------------

    static let pastels = ["#F4B8A0", "#F6D186", "#9FD8C8", "#D98E52", "#E8A6C7", "#D9C9A8", "#F0A8A8", "#A8D9C0"]
    static let hairColors = ["#5A4632", "#8A5A3B", "#2B2320", "#C79A5B", "#7A4A2E", "#3A3733"]

    static func blob(seed: String, size: Int) -> String {
        var rnd = AvatarRandom("blob:" + seed)
        let color = rnd.pick(pastels)
        let cx = 60.0, cy = 66.0, baseR = 42.0
        var pts: [(Double, Double)] = []
        for i in 0..<10 {
            let a = AvatarTrig.at(AvatarTrig.blob[i])
            let r = baseR * (0.86 + rnd.next() * 0.28)
            pts.append((cx + a.cos * r, cy + a.sin * r))
        }
        let d = outline(pts)
        let eyeStyle = rnd.pick(["round", "round", "sleepy", "wide"])
        let ex = 12 + rnd.next() * 4, ey: Double = eyeStyle == "sleepy" ? 2 : 5
        let antenna = rnd.chance(0.6)
            ? #"<line x1="60" y1="\#(n(cy - baseR - 2))" x2="60" y2="\#(n(cy - baseR - 14))" stroke="\#(color)" stroke-width="4" stroke-linecap="round"/>"#
                + "\n    " + #"<circle cx="60" cy="\#(n(cy - baseR - 16))" r="5" fill="\#(color)"/>"#
            : ""
        let er = eyeStyle == "wide" ? "4.5" : "3.5"
        let eyes = eyeStyle == "sleepy"
            ? #"<line x1="\#(n(cx - ex))" y1="\#(n(cy))" x2="\#(n(cx - ex + 6))" y2="\#(n(cy))" stroke="\#(ink)" stroke-width="3" stroke-linecap="round"/>"#
                + "\n       " + #"<line x1="\#(n(cx + ex - 6))" y1="\#(n(cy))" x2="\#(n(cx + ex))" y2="\#(n(cy))" stroke="\#(ink)" stroke-width="3" stroke-linecap="round"/>"#
            : #"<circle cx="\#(n(cx - ex))" cy="\#(n(cy - ey))" r="\#(er)" fill="\#(ink)"/>"#
                + "\n       " + #"<circle cx="\#(n(cx + ex))" cy="\#(n(cy - ey))" r="\#(er)" fill="\#(ink)"/>"#
        return open(size) + antenna + #"<path d="\#(d)" fill="\#(color)"/>"# + eyes + "</svg>"
    }

    // ---- teammate (characters.js character) --------------------------------------------------

    static let roles: Set<String> = ["design", "reviewer", "docs", "research", "qa"]

    /// The part of the seed before its first "-" or ":", when it names a known role.
    static func role(_ seed: String) -> String? {
        let k = String(String.UnicodeScalarView(seed.unicodeScalars.prefix { $0 != "-" && $0 != ":" })).lowercased()
        return roles.contains(k) ? k : nil
    }

    private static func face(_ rnd: inout AvatarRandom, _ ink: String) -> String {
        let style = rnd.pick(["smile", "smile", "neutral", "wink"])
        if style == "neutral" {
            return #"<circle cx="49" cy="48" r="3.5" fill="\#(ink)"/><circle cx="71" cy="48" r="3.5" fill="\#(ink)"/>"#
                + "\n    " + #"<line x1="52" y1="62" x2="68" y2="62" stroke="\#(ink)" stroke-width="3" stroke-linecap="round"/>"#
        }
        if style == "wink" {
            return #"<path d="M45 48 Q49 44 53 48" stroke="\#(ink)" stroke-width="3" fill="none" stroke-linecap="round"/>"#
                + "\n    " + #"<path d="M67 48 Q71 44 75 48" stroke="\#(ink)" stroke-width="3" fill="none" stroke-linecap="round"/>"#
                + "\n    " + #"<path d="M50 60 Q60 67 70 60" stroke="\#(ink)" stroke-width="3" fill="none" stroke-linecap="round"/>"#
        }
        return #"<circle cx="49" cy="48" r="3.5" fill="\#(ink)"/><circle cx="71" cy="48" r="3.5" fill="\#(ink)"/>"#
            + "\n    " + #"<path d="M50 60 Q60 66 70 60" stroke="\#(ink)" stroke-width="3" fill="none" stroke-linecap="round"/>"#
    }

    private static func hair(_ rnd: inout AvatarRandom, _ c: String) -> String {
        switch rnd.pick(["bald", "tuft", "curly", "sidePart", "ponytail", "afro", "buzz"]) {
        case "buzz": return #"<path d="M32 44 A28 28 0 0 1 88 44 L88 38 A28 28 0 0 0 32 38 Z" fill="\#(c)"/>"#
        case "tuft": return #"<path d="M42 30 Q60 10 78 30 Q60 20 42 30 Z" fill="\#(c)"/>"#
        case "curly":
            return #"<circle cx="38" cy="34" r="9" fill="\#(c)"/><circle cx="52" cy="24" r="10" fill="\#(c)"/>"#
                + "\n      " + #"<circle cx="68" cy="24" r="10" fill="\#(c)"/><circle cx="82" cy="34" r="9" fill="\#(c)"/>"#
        case "sidePart": return #"<path d="M30 40 Q34 12 62 14 Q88 14 90 40 L90 30 Q86 20 60 20 Q36 20 30 30 Z" fill="\#(c)"/>"#
        case "ponytail":
            return #"<path d="M32 38 Q34 14 60 14 Q86 14 88 38 L88 32 Q84 20 60 20 Q36 20 32 32 Z" fill="\#(c)"/>"#
                + "\n      " + #"<ellipse cx="92" cy="46" rx="7" ry="11" fill="\#(c)"/>"#
        case "afro": return #"<path d="M24 48 Q20 4 60 4 Q100 4 96 48 Q96 26 60 22 Q24 26 24 48 Z" fill="\#(c)"/>"#
        default: return ""
        }
    }

    private static func headwear(_ rnd: inout AvatarRandom, _ c: String, forced: String? = nil) -> String {
        switch forced ?? rnd.pick(["none", "none", "cap", "beanie", "headband", "bow"]) {
        case "cap": return #"<path d="M36 34 Q60 14 84 34 L84 40 L36 40 Z" fill="\#(c)"/><rect x="34" y="38" width="52" height="6" rx="3" fill="\#(c)"/>"#
        case "beanie":
            return #"<path d="M30 38 Q30 8 60 8 Q90 8 90 38 L90 40 L30 40 Z" fill="\#(c)"/><rect x="30" y="34" width="60" height="8" rx="4" fill="\#(c)" opacity="0.7"/>"#
                + "\n      " + #"<circle cx="60" cy="10" r="4" fill="\#(c)"/>"#
        case "headband": return #"<rect x="30" y="34" width="60" height="7" rx="3.5" fill="\#(c)"/>"#
        case "bow": return #"<circle cx="80" cy="24" r="4" fill="\#(c)"/><path d="M80 24 L70 18 L70 30 Z" fill="\#(c)"/><path d="M80 24 L90 18 L90 30 Z" fill="\#(c)"/>"#
        case "beret": return #"<ellipse cx="58" cy="22" rx="26" ry="16" fill="\#(c)"/><circle cx="82" cy="16" r="4" fill="\#(c)"/>"#
        default: return ""
        }
    }

    private static func glasses(_ rnd: inout AvatarRandom, _ c: String, forced: String? = nil) -> String {
        let style = forced ?? rnd.pick(["none", "none", "round", "square"])
        let bridge = "\n    " + #"<line x1="57" y1="48" x2="63" y2="48" stroke="\#(c)" stroke-width="2.5"/>"#
        if style == "round" {
            return #"<circle cx="49" cy="48" r="8" fill="none" stroke="\#(c)" stroke-width="2.5"/>"#
                + "\n    " + #"<circle cx="71" cy="48" r="8" fill="none" stroke="\#(c)" stroke-width="2.5"/>"# + bridge
        }
        if style == "square" {
            return #"<rect x="41" y="41" width="16" height="14" rx="3" fill="none" stroke="\#(c)" stroke-width="2.5"/>"#
                + "\n    " + #"<rect x="63" y="41" width="16" height="14" rx="3" fill="none" stroke="\#(c)" stroke-width="2.5"/>"# + bridge
        }
        return ""
    }

    private static func earrings(_ rnd: inout AvatarRandom, _ c: String) -> String {
        let style = rnd.pick(["none", "none", "stud", "hoop"])
        if style == "stud" { return #"<circle cx="32" cy="54" r="2.5" fill="\#(c)"/><circle cx="88" cy="54" r="2.5" fill="\#(c)"/>"# }
        if style == "hoop" {
            return #"<circle cx="32" cy="56" r="4" fill="none" stroke="\#(c)" stroke-width="2"/>"#
                + "\n    " + #"<circle cx="88" cy="56" r="4" fill="none" stroke="\#(c)" stroke-width="2"/>"#
        }
        return ""
    }

    private static func roleBadge(_ role: String, _ c: String) -> String {
        let bg = #"<circle cx="94" cy="94" r="16" fill="\#(c)"/>"#
        switch role {
        case "design":
            return bg + #"<line x1="88" y1="100" x2="100" y2="88" stroke="\#(ink)" stroke-width="2.5" stroke-linecap="round"/>"#
                + "\n      " + #"<path d="M97 91 L100 88 L102 90 L99 93 Z" fill="\#(ink)"/>"#
        case "docs":
            return bg + #"<rect x="87" y="87" width="10" height="13" rx="1.5" fill="none" stroke="\#(ink)" stroke-width="2"/>"#
                + "\n      " + #"<line x1="90" y1="90" x2="94" y2="90" stroke="\#(ink)" stroke-width="1.5"/><line x1="90" y1="93" x2="94" y2="93" stroke="\#(ink)" stroke-width="1.5"/>"#
        case "research":
            return bg + #"<circle cx="92" cy="91" r="5" fill="none" stroke="\#(ink)" stroke-width="2.2"/>"#
                + "\n      " + #"<line x1="96" y1="95" x2="100" y2="99" stroke="\#(ink)" stroke-width="2.2" stroke-linecap="round"/>"#
        case "qa":
            return bg + #"<path d="M88 94 L92 98 L100 89" stroke="\#(ink)" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>"#
        default: return ""
        }
    }

    /// project.js's teammateProjectBadge: the project's colour as a dot, top-left.
    static func projectBadge(_ color: String?) -> String {
        guard let color, !color.isEmpty else { return "" }
        let ring = needsRim(color)
            ? #"<circle cx="20" cy="20" r="8.5" fill="none" stroke="\#(rim.color)" stroke-opacity="\#(n(rim.opacity))" stroke-width="2.5"/>"#
            : ""
        return #"<circle cx="20" cy="20" r="7" fill="\#(color)"/>"# + ring
    }

    /// A teammate's character. `size` is 40 or 24 as the Deck draws it: below 32 the badges drop.
    static func character(seed: String, size: Int, projectColor: String?) -> String {
        var rnd = AvatarRandom("char:" + seed)
        let bodyColor = rnd.pick(pastels)
        let headColor = rnd.pick(skinTones)
        let hairColor = rnd.pick(hairColors)
        let ink = featureInk(headColor)
        let rimmed = needsRim(headColor)
        let role = Self.role(seed)
        let wearsBeret = role == "design" && rnd.chance(0.5)
        let hw: String
        if wearsBeret { let c = rnd.pick(hairColors); hw = headwear(&rnd, c, forced: "beret") } else { let c = rnd.pick(hairColors); hw = headwear(&rnd, c) }
        let gl: String
        if role == "reviewer" { let s = rnd.pick(["round", "square"]); gl = glasses(&rnd, ink, forced: s) } else { gl = glasses(&rnd, ink) }
        let hairEl = wearsBeret ? "" : hair(&rnd, hairColor)
        let showBadge = size >= 32
        let badge = !showBadge ? "" : role == "design" ? (wearsBeret ? "" : roleBadge("design", bodyColor)) : role.map { roleBadge($0, bodyColor) } ?? ""
        let rimRing = rimmed
            ? #"<circle cx="60" cy="50" r="28.5" fill="none" stroke="\#(rim.color)" stroke-opacity="\#(n(rim.opacity))" stroke-width="3"/>"#
            : ""
        let ear = earrings(&rnd, hairColor)
        let fc = face(&rnd, ink)
        return open(size)
            + "\n    " + #"<rect x="30" y="58" width="60" height="46" rx="20" fill="\#(bodyColor)"/>"#
            + "\n    " + ear
            + "\n    " + #"<circle cx="60" cy="50" r="30" fill="\#(headColor)"/>"#
            + "\n    " + rimRing
            + "\n    " + hairEl
            + "\n    " + fc
            + "\n    " + gl
            + "\n    " + hw
            + "\n    " + badge
            + "\n    " + (showBadge ? projectBadge(projectColor) : "")
            + "\n  </svg>"
    }

    // ---- project (project.js projectTile) ----------------------------------------------------

    static let marks = ["square", "triangle", "diamond", "cross", "bars", "grid"]

    private static func markGlyph(_ mark: String, _ c: String) -> String {
        switch mark {
        case "square": return #"<rect x="44" y="44" width="32" height="32" rx="6" fill="\#(c)"/>"#
        case "triangle": return #"<path d="M60 40 L82 78 L38 78 Z" fill="\#(c)"/>"#
        case "diamond": return #"<path d="M60 36 L84 60 L60 84 L36 60 Z" fill="\#(c)"/>"#
        case "cross":
            return #"<rect x="50" y="34" width="20" height="52" rx="6" fill="\#(c)"/>"#
                + "\n      " + #"<rect x="34" y="50" width="52" height="20" rx="6" fill="\#(c)"/>"#
        case "bars":
            return #"<rect x="36" y="42" width="48" height="12" rx="6" fill="\#(c)"/>"#
                + "\n      " + #"<rect x="36" y="66" width="48" height="12" rx="6" fill="\#(c)"/>"#
        case "grid":
            return #"<circle cx="46" cy="46" r="8" fill="\#(c)"/><circle cx="74" cy="46" r="8" fill="\#(c)"/>"#
                + "\n      " + #"<circle cx="46" cy="74" r="8" fill="\#(c)"/><circle cx="74" cy="74" r="8" fill="\#(c)"/>"#
        default: return ""
        }
    }

    /// A project tile from its 8 seed bytes: byte 0 the colour, byte 1 the mark. A draft is a
    /// dashed outline in the same colour and mark.
    static func project(bytes: [UInt8], draft: Bool, size: Int) -> String {
        let color = projectColors[Int(bytes[0]) % projectColors.count]
        let mark = marks[Int(bytes[1]) % marks.count]
        let r = 30.0
        let rimmed = needsRim(color)
        if draft {
            let halo = rimmed
                ? #"<rect x="4" y="4" width="112" height="112" rx="\#(n(r))" fill="none" stroke="\#(rim.color)""#
                    + "\n          " + #"stroke-opacity="\#(n(rim.opacity))" stroke-width="5"/>"#
                : ""
            let markStroke = rimmed ? #" stroke="\#(rim.color)" stroke-opacity="\#(n(rim.opacity))" stroke-width="1.5""# : ""
            let markSvg = markGlyph(mark, color).replacingOccurrences(of: "/>", with: markStroke + "/>")
            return open(size)
                + "\n      " + halo
                + "\n      " + #"<rect x="4" y="4" width="112" height="112" rx="\#(n(r))" fill="none" stroke="\#(color)""#
                + "\n        " + #"stroke-width="5" stroke-dasharray="14 9"/>"#
                + "\n      " + markSvg
                + "\n    </svg>"
        }
        let rimRing = rimmed
            ? #"<rect x="4.5" y="4.5" width="111" height="111" rx="\#(n(r - 0.5))" fill="none" stroke="\#(rim.color)""#
                + "\n        " + #"stroke-opacity="\#(n(rim.opacity))" stroke-width="3"/>"#
            : ""
        return open(size)
            + "\n    " + #"<rect x="2" y="2" width="116" height="116" rx="\#(n(r))" fill="\#(color)"/>"#
            + "\n    " + rimRing
            + "\n    " + markGlyph(mark, featureInk(color))
            + "\n  </svg>"
    }

    // ---- the Vyre code ring (vyrecode2.js renderCode2, ticksSunburst, dark) --------------------

    static let center = 300.0
    static let faceD = 360.0
    static let perRing = 36
    static let ringR = [188.0, 222.0]

    /// The 72 two-bit levels the ring draws for a fingerprint: its codeword's bits, in pairs.
    static func levels(_ fp: [UInt8]) -> [Int] {
        let bits = AvatarCodeword.build(fp).flatMap { b in (0..<8).reversed().map { Int(b >> UInt8($0)) & 1 } }
        return stride(from: 0, to: bits.count, by: 2).map { bits[$0] << 1 | bits[$0 + 1] }
    }

    static func ring(fp: [UInt8], option: Int, size: Int) -> String {
        let warm = userGradients[option % userGradients.count].0
        let ground = "#0E0D0C", tint = AvatarColour.mix(warm, "#161513", 0.92)
        let mark = AvatarColour.mix(warm, "#F1EEE6", 0.4), markDeep = warm
        var marks = ""
        for (i, level) in levels(fp).enumerated() {
            let a = AvatarTrig.at(AvatarTrig.ring[i % perRing])
            let r = ringR[i / perRing]
            let x = center + a.cos * r, y = center + a.sin * r
            let len = Double(6 + level * 6)
            let x2 = x + a.cos * len, y2 = y + a.sin * len
            let fill = level >= 2 ? markDeep : mark
            marks += #"<line x1="\#(n(x))" y1="\#(n(y))" x2="\#(n(x2))" y2="\#(n(y2))" stroke="\#(fill)" stroke-width="6" stroke-linecap="round" opacity="\#(level == 0 ? "0.85" : "1")"/>"#
        }
        let m = AvatarTrig.at(AvatarTrig.marker)
        let dots = (0..<3).map { k -> String in
            let rr = ringR[1] + Double(8 + k * 6)
            return #"<circle cx="\#(n(center + m.cos * rr))" cy="\#(n(center + m.sin * rr))" r="\#(2 + k)" fill="\#(markDeep)"/>"#
        }.joined()
        // The face drawn at FACE_D, its own <svg> wrapper stripped and scaled from its 120 viewBox.
        var face = person(option: option, size: Int(faceD))
        if let end = face.firstIndex(of: ">") { face.removeSubrange(face.startIndex...end) }
        face = face.replacingOccurrences(of: "</svg>", with: "")
        let faceWrapped = #"<g transform="translate(\#(n(center - faceD / 2)), \#(n(center - faceD / 2))) scale(\#(n(faceD / 120)))">"# + face + "</g>"
        return open(size, 600)
            + "\n    " + #"<rect width="600" height="600" fill="\#(ground)"/>"#
            + "\n    " + #"<circle cx="300" cy="300" r="\#(n(ringR[1] + 40))" fill="\#(tint)"/>"#
            + "\n    " + marks
            + "\n    " + dots
            + "\n    " + faceWrapped
            + "\n  </svg>"
    }
}

/// payload.js's codeword: the 8 fingerprint bytes, a CRC-8, and 9 Reed-Solomon parity bytes over
/// GF(256) with the 0x11D polynomial (rs.js's encode), 18 bytes.
enum AvatarCodeword {
    private static let tables: (exp: [Int], log: [Int]) = {
        var exp = [Int](repeating: 0, count: 512), log = [Int](repeating: 0, count: 256)
        var x = 1
        for i in 0..<255 {
            exp[i] = x; log[x] = i
            x <<= 1
            if x & 0x100 != 0 { x ^= 0x11D }
        }
        for i in 255..<512 { exp[i] = exp[i - 255] }
        return (exp, log)
    }()

    private static func gmul(_ a: Int, _ b: Int) -> Int {
        a == 0 || b == 0 ? 0 : tables.exp[tables.log[a] + tables.log[b]]
    }

    static func crc8(_ bytes: [UInt8]) -> UInt8 {
        var crc = 0
        for b in bytes {
            crc ^= Int(b)
            for _ in 0..<8 { crc = crc & 0x80 != 0 ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF }
        }
        return UInt8(crc)
    }

    static func build(_ id8: [UInt8], parity: Int = 9) -> [UInt8] {
        let data = id8.map(Int.init) + [Int(crc8(id8))]
        var gen = [1]
        for i in 0..<parity {
            var next = [Int](repeating: 0, count: gen.count + 1)
            for j in 0..<gen.count {
                next[j] ^= gen[j]
                next[j + 1] ^= gmul(gen[j], tables.exp[i])
            }
            gen = next
        }
        var msg = data + [Int](repeating: 0, count: parity)
        for i in 0..<data.count {
            let coef = msg[i]
            if coef == 0 { continue }
            for j in 0..<gen.count { msg[i + j] ^= gmul(gen[j], coef) }
        }
        return (data + msg[data.count...]).map { UInt8($0) }
    }
}
