// The words the person reads say Vyre and Lumen, never the internal names "vyred" and "Capsule".
// Code identifiers, file names and the CLI command (`vyre capsule`) keep their names; only string
// literal text is checked (not what is inside \( ) interpolation, and not comments).
import Foundation

// capsule-suite: userFacingWordsSuite
let userFacingWordsSuite = Suite("user-facing words") { t in
    /// Literals that are protocol or file names, not words a person reads.
    let allowed = ["vyred.sock", "vyred.pid", "Host: vyred", "vyred events", "Vyre-Capsule"]

    /// The text of every string literal in `src`, with its 1-based line, outside interpolation and comments.
    func literals(_ src: String) -> [(line: Int, text: String)] {
        let c = Array(src.unicodeScalars)
        var out: [(Int, String)] = []
        var i = 0, line = 1
        while i < c.count {
            let ch = c[i]
            if ch == "\n" { line += 1; i += 1; continue }
            if ch == "/" && i + 1 < c.count && c[i + 1] == "/" { while i < c.count && c[i] != "\n" { i += 1 }; continue }
            if ch == "/" && i + 1 < c.count && c[i + 1] == "*" {
                i += 2
                while i + 1 < c.count && !(c[i] == "*" && c[i + 1] == "/") { if c[i] == "\n" { line += 1 }; i += 1 }
                i += 2; continue
            }
            if ch == "\"" {
                let triple = i + 2 < c.count && c[i + 1] == "\"" && c[i + 2] == "\""
                i += triple ? 3 : 1
                var text = "", start = line
                while i < c.count {
                    if triple && c[i] == "\"" && i + 2 < c.count && c[i + 1] == "\"" && c[i + 2] == "\"" { i += 3; break }
                    if !triple && c[i] == "\"" { i += 1; break }
                    if c[i] == "\n" { if !triple { break }; line += 1; text += "\n"; i += 1; continue }
                    if c[i] == "\\" && i + 1 < c.count {
                        if c[i + 1] == "(" {
                            // Interpolation: skip to its closing paren, keeping nested strings out of the text.
                            var depth = 1; i += 2
                            while i < c.count && depth > 0 {
                                if c[i] == "(" { depth += 1 } else if c[i] == ")" { depth -= 1 }
                                else if c[i] == "\"" { i += 1; while i < c.count && c[i] != "\"" { i += c[i] == "\\" ? 2 : 1 }; }
                                else if c[i] == "\n" { line += 1 }
                                i += 1
                            }
                            text += " "; continue
                        }
                        i += 2; text += " "; continue
                    }
                    text.unicodeScalars.append(c[i]); i += 1
                }
                out.append((start, text))
                continue
            }
            i += 1
        }
        return out
    }

    /// The word is "server" (team/RULES.md): the paired server is never "the box" or "your box" to a person. ("in the box" is the text
    /// field, and stays.)
    let boxWords = ["your box", "the box's", "The box ", "Send to box", "No box", "Box \\", "Box direct", "Box via"]

    t.test("no string a person can read says vyred or Capsule") {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources")
        var files = 0
        var bad: [String] = []
        if let en = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) {
            for case let url as URL in en where url.pathExtension == "swift" {
                guard let src = try? String(contentsOf: url, encoding: .utf8) else { continue }
                files += 1
                for l in literals(src) where l.text.contains("vyred") || l.text.contains("Capsule") || boxWords.contains(where: { l.text.contains($0) }) {
                    if allowed.contains(where: { l.text.contains($0) }) { continue }
                    bad.append("\(url.lastPathComponent):\(l.line): \(l.text.prefix(80))")
                }
            }
        }
        t.ok(files > 50, "found the sources (\(files) files)")
        t.eq(bad, [], "user-facing strings with internal names (vyred, Capsule) or the old word for the server")
    }

    t.test("the checker itself sees a word in a literal, not in a comment or an interpolation") {
        let src = "let a = \"Open Capsule\"\n// \"vyred is not running\"\nlet b = \"x \\(vyred.isUp ? 1 : 2) y\"\nlet c = \"\"\"\nTalk to vyred\n\"\"\"\n"
        let found = literals(src).filter { $0.text.contains("vyred") || $0.text.contains("Capsule") }.map { $0.line }
        t.eq(found, [1, 4])
    }
}
