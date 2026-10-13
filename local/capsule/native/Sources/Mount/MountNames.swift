// MountNames: how a Drive name becomes a name Finder shows, and back (the Mac half of Vyre in Finder; local/capsule/native-win/src/mount.rs is the Windows half and the same scheme).
//
// Finder shows ':' as '/' and APFS is case-insensitive, so ':' and control characters are written as %XX, a '%' that would read back as an escape becomes %25, and the Drive's own bookkeeping
// folders never show. Pure: the tests run it with no Mac services.

import Foundation

public enum MountNames {
    /// Top-level Drive folders that are the server's own bookkeeping.
    public static let hiddenTop: Set<String> = [".trash", ".upload"]
    /// The zero-byte file that keeps an empty folder in the Drive (which holds files, not folders). Never shown, never a file.
    public static let folderMarker = ".vyre-folder"
    static let nameMax = 255

    private static func hexVal(_ c: UInt8) -> UInt8? {
        switch c {
        case 48...57: return c - 48
        case 97...102: return c - 97 + 10
        case 65...70: return c - 65 + 10
        default: return nil
        }
    }

    private static func mustEscape(_ u: Unicode.Scalar) -> Bool { u == ":" || u.value < 0x20 || u.value == 0x7f }

    /// One Drive segment as a Finder name. nil for a name longer than a file name may be.
    public static func localSegment(_ seg: String) -> String? {
        if seg.isEmpty || seg.utf8.count > nameMax { return nil }
        let scalars = Array(seg.unicodeScalars)
        var out = ""
        for (i, u) in scalars.enumerated() {
            let hex1 = i + 1 < scalars.count && isHex(scalars[i + 1])
            let hex2 = i + 2 < scalars.count && isHex(scalars[i + 2])
            if mustEscape(u) || (u == "%" && hex1 && hex2) {
                out += String(format: "%%%02X", u.value)
            } else {
                out.unicodeScalars.append(u)
            }
        }
        return out.utf8.count > nameMax ? nil : out
    }

    private static func isHex(_ u: Unicode.Scalar) -> Bool { u.isASCII && hexVal(UInt8(u.value)) != nil }

    /// The Drive segment a Finder name stands for: %XX of an ASCII character is that character.
    public static func driveSegment(_ seg: String) -> String {
        let b = Array(seg.utf8)
        var out = [UInt8]()
        var i = 0
        while i < b.count {
            if b[i] == 37, i + 2 < b.count, let h = hexVal(b[i + 1]), let l = hexVal(b[i + 2]), h * 16 + l < 0x80 {
                out.append(h * 16 + l)
                i += 3
            } else {
                out.append(b[i])
                i += 1
            }
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// A name Finder hands us (a new file, a rename) as a Drive segment, or nil when the Drive would not take it.
    public static func driveName(forFinder name: String) -> String? {
        let s = driveSegment(name)
        if s.isEmpty || s == "." || s == ".." || s.contains("/") || s.contains("\\") { return nil }
        if s.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { return nil }
        if s.hasSuffix(".") || s.hasSuffix(" ") || s.hasPrefix(" ") { return nil }
        if hiddenTop.contains(s) { return nil }
        if s.precomposedStringWithCompatibilityMapping != s { return nil }
        return s
    }

    /// Files the system and its programs make beside a person's own: they stay on this Mac.
    public static func isTransient(_ name: String) -> Bool {
        let n = name.lowercased()
        return n == ".ds_store" || n.hasPrefix("._") || n == ".localized" || n == ".spotlight-v100" || n == ".trashes" || n == ".fseventsd"
            || n.hasPrefix("~$") || n.hasPrefix(".~lock.") || n.hasSuffix(".tmp") || n.hasSuffix(".crdownload") || n.hasSuffix(".partial")
            || n == "desktop.ini" || n == "thumbs.db" || n.hasPrefix(".sb-")
    }
}
