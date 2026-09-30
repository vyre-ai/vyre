// clip: the vault's clipboard helper (ADR 0006, decision 4). vyred starts it, writes one JSON
// line per request on stdin and reads one JSON line back per request on stdout.
//
//   {"op":"copy","text":"..."}      -> {"ok":true,"count":N}   the pasteboard's changeCount
//   {"op":"clear","ifCount":N}      -> {"ok":true,"cleared":B} clears only if nothing replaced it
//   {"op":"hash"}                   -> {"ok":true,"count":N,"sha256":"..."|null}
//   {"op":"release"}                -> {"ok":true}             frees a named pasteboard (tests)
//
// A copy is marked for this Mac only (no Universal Clipboard) and as concealed and transient, so
// clipboard managers that follow nspasteboard.org skip it. When stdin closes, whatever this helper
// copied is cleared if it is still there, so a crash of vyred still wipes it.
//
// `--pasteboard <name>` uses a private named pasteboard instead of the general one. Tests do,
// so they never touch the person's real clipboard.

import AppKit
import CryptoKit
import Foundation

var name: String? = nil
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    if a == "--pasteboard" { name = args.next() }
}

let pb = name.map { NSPasteboard(name: NSPasteboard.Name($0)) } ?? NSPasteboard.general
var mine: Int? = nil

func reply(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func clearIfMine() -> Bool {
    guard let c = mine, pb.changeCount == c else { return false }
    pb.clearContents()
    mine = nil
    return true
}

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let op = msg["op"] as? String else {
        reply(["ok": false, "error": "bad request"])
        continue
    }
    switch op {
    case "copy":
        guard let text = msg["text"] as? String else { reply(["ok": false, "error": "no text"]); continue }
        _ = pb.prepareForNewContents(with: .currentHostOnly)
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        item.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        if pb.writeObjects([item]) {
            mine = pb.changeCount
            reply(["ok": true, "count": pb.changeCount])
        } else {
            reply(["ok": false, "error": "the pasteboard refused the write"])
        }
    case "clear":
        if let want = msg["ifCount"] as? Int, pb.changeCount == want {
            pb.clearContents()
            if mine == want { mine = nil }
            reply(["ok": true, "cleared": true])
        } else {
            reply(["ok": true, "cleared": false])
        }
    case "hash":
        if let s = pb.string(forType: .string) {
            let d = SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
            reply(["ok": true, "count": pb.changeCount, "sha256": d])
        } else {
            reply(["ok": true, "count": pb.changeCount, "sha256": NSNull()])
        }
    case "release":
        if name != nil { pb.releaseGlobally() }
        reply(["ok": true])
    default:
        reply(["ok": false, "error": "unknown op"])
    }
}

_ = clearIfMine()
exit(0)
