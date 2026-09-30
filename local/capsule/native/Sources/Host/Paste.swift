// Paste: Return puts the row's text into the app you were in, instead of only copying it.
//
// The first time, macOS is asked for Accessibility (once, and never again if it is refused); until
// it is granted, Return copies and says so. After that Return pastes: the text is put on the
// pasteboard, the Capsule steps aside, the app in front is brought back, and Command-V is sent.
// A setting switches Return back to Copy ("Make Return copy" in the box). Copy is always one key
// away in Command-K, and paste stays there when Return copies.
//
// Only the rows that are text you meant to put somewhere paste: clipboard history, snippets and
// emoji. Answers to a sum, a colour, a time or a rate copy, as they always did.

import AppKit
import Foundation

enum PasteMode: String { case paste, copy }

enum Paster {
    /// Where the setting and the "asked already" note live: <home>/capsule/prefs.json. Set at launch.
    nonisolated(unsafe) static var prefsPath: String?
    /// Test seams. The defaults are the real thing.
    nonisolated(unsafe) static var trusted: () -> Bool = { AXIsProcessTrusted() }
    nonisolated(unsafe) static var promptAccessibility: () -> Void = {
        guard dialogsAllowed() else { return }
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }
    /// The app in front right now (a fake in tests).
    nonisolated(unsafe) static var frontPid: () -> Int32? = { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    nonisolated(unsafe) static var post: () -> Void = {
        let src = CGEventSource(stateID: .combinedSessionState)
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: down) // V
            e?.flags = .maskCommand
            e?.post(tap: .cgAnnotatedSessionEventTap)
        }
    }
    /// How long the front app gets to take focus back before the key is sent.
    nonisolated(unsafe) static var settle: UInt64 = 90_000_000

    static let copiedNote = "Copied. Press \u{2318}V to paste."
    static let needAccess = "Copied. Allow Lumen under Privacy & Security, Accessibility, and Return will paste."

    // MARK: the setting

    private static func prefs() -> [String: Any] {
        guard let p = prefsPath, let d = FileManager.default.contents(atPath: p),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
        return o
    }

    private static func save(_ o: [String: Any]) {
        guard let p = prefsPath, let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
        try? FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try? d.write(to: URL(fileURLWithPath: p), options: .atomic)
    }

    /// A yes-or-no note kept beside the setting (the first-launch moment has been shown).
    static func flag(_ key: String) -> Bool { prefs()[key] as? Bool ?? false }
    static func setFlag(_ key: String) { var o = prefs(); o[key] = true; save(o) }

    static var mode: PasteMode { PasteMode(rawValue: prefs()["enter"] as? String ?? "") ?? .paste }

    static func setMode(_ m: PasteMode) { var o = prefs(); o["enter"] = m.rawValue; save(o) }

    private static var askedAccess: Bool { prefs()["askedAccessibility"] as? Bool ?? false }

    /// Is Accessibility on. When it is not, macOS is asked once (never twice: a person who said no
    /// is not asked again) and this says false. Shared by paste and window moves.
    static func accessibilityOn() -> Bool {
        if trusted() { return true }
        if !askedAccess {
            var o = prefs(); o["askedAccessibility"] = true; save(o)
            promptAccessibility()
        }
        return false
    }

    // MARK: the actions

    /// [Paste, Copy] or [Copy, Paste], by the setting; the first is Return. `write` puts the text
    /// on the pasteboard and says why not, or nil.
    static func actions(noun: String = "text", write: @escaping @Sendable () async -> String?) -> [ResultAction] {
        let paste = ResultAction(id: "paste", title: "Paste \(noun)", symbol: "arrow.down.doc", needsFrontApp: true) { _, ctx in
            if let why = await write() { return .failed(why) }
            guard ctx.frontIsBack else { return .close(copiedNote) }
            if !accessibilityOn() { return .close(needAccess) }
            try? await Task.sleep(nanoseconds: settle)
            // The app could have changed in that moment: paste only into the one the person was in.
            if let want = ctx.query.front?.pid, frontPid() != want { return .close(copiedNote) }
            post()
            return .close(nil)
        }
        let copy = ResultAction(id: "copy", title: "Copy \(noun)", symbol: "doc.on.clipboard", shortcut: KeyShortcut("return", command: true)) { _, _ in
            if let why = await write() { return .failed(why) }
            return .close(copiedNote)
        }
        return mode == .paste ? [paste, copy] : [copy, paste]
    }

    /// Text on the general pasteboard, marked as the Capsule's own so the history does not take it back.
    static func actions(text: String, noun: String = "text") -> [ResultAction] {
        actions(noun: noun) {
            await MainActor.run {
                CapsuleModel.replyBoard.clearContents()
                let ok = CapsuleModel.replyBoard.setString(text, forType: .string)
                CapsuleModel.replyBoard.setData(Data(), forType: ClipRead.ownType)
                return ok ? nil : "The pasteboard refused it."
            }
        }
    }

    /// The row that flips the setting, found by typing "paste" or "copy".
    static func settingRow(_ q: Query) -> ResultItem? {
        let now = mode
        let title = now == .paste ? "Make Return copy instead of paste" : "Make Return paste into the app in front"
        let s = Match.score(q.normalized, "return paste copy", synonyms: ["paste setting", "enter paste", "paste or copy", "paste", "copy setting"])
        guard q.normalized.count >= 4, s >= 0.6 else { return nil }
        return ResultItem(id: "pref:paste", kind: "pref", title: title,
                          subtitle: now == .paste ? "Now Return pastes text rows" : "Now Return copies text rows",
                          icon: .symbol("arrow.down.doc"), section: .commands, score: s,
                          actions: [ResultAction(id: "toggle", title: "Change", symbol: "arrow.left.arrow.right") { _, _ in
                              let next: PasteMode = now == .paste ? .copy : .paste
                              setMode(next)
                              return .said(next == .paste ? "Return now pastes." : "Return now copies.")
                          }])
    }
}
