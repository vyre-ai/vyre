// HotkeyReport: what the Capsule tells vyred about its hot keys (capsule.report), and when.
//
// Pure, so it has a test without an event tap. `next` returns the report to send, or nil when
// nothing changed since the last one. A send that failed (vyred not up yet) is forgotten, and
// `retry` sends it again once vyred is back, so `vyre doctor` never keeps a stale answer.

struct HotkeyReport {
    /// Why Control twice is off.
    enum Why: Equatable { case noPermission, tapFailed, tapDisabled }

    private(set) var last: (ok: Bool, message: String?)?
    private(set) var pending = false

    /// The report to send when (ok, message) differs from the last one sent; nil when unchanged.
    mutating func next(ok: Bool, message: String?) -> (Bool, String?)? {
        if let l = last, l.ok == ok, l.message == message { return nil }
        last = (ok, message)
        pending = false
        return (ok, message)
    }

    /// The send of (ok, message) failed: forget it, unless a newer report went out since.
    mutating func failed(ok: Bool, message: String?) {
        guard let l = last, l.ok == ok, l.message == message else { return }
        last = nil
        pending = true
    }

    /// vyred is back: the report to send again, if one failed; nil otherwise.
    mutating func retry(ok: Bool, message: String?) -> (Bool, String?)? {
        guard pending else { return nil }
        return next(ok: ok, message: message)
    }

    /// The plain words for a Control twice that is off. `chord` is the pretty-printed chord
    /// (for example "⌥Space"), or nil when none is registered.
    static func message(_ why: Why, chord: String?) -> String {
        let cause: String
        switch why {
        case .noPermission: cause = "Input Monitoring is off, so Control twice is off."
        case .tapFailed: cause = "macOS would not let Lumen listen for Control, so Control twice is off."
        case .tapDisabled: cause = "macOS turned off Lumen's Control listener and it could not be turned back on, so Control twice is off."
        }
        if let chord { return cause + " \(chord) still opens Lumen." }
        return cause + " No other hot key is set, so open Lumen from the menu bar."
    }
}
