// capsule-suite: hotkeyReportSuite
// capsule.report goes out once at start and then only on a change; a failed send goes again when
// vyred is back; the words say why Control twice is off and what still opens the Capsule.

let hotkeyReportSuite = Suite("hotkey report") { t in
    t.test("the first report always goes, an unchanged one does not") {
        var r = HotkeyReport()
        t.ok(r.next(ok: true, message: nil) != nil, "first report")
        t.ok(r.next(ok: true, message: nil) == nil, "unchanged")
        t.ok(r.next(ok: true, message: nil) == nil, "still unchanged")
    }

    t.test("a change in ok or in the message goes") {
        var r = HotkeyReport()
        _ = r.next(ok: true, message: nil)
        let off = r.next(ok: false, message: "a")
        t.eq(off?.0, false)
        t.eq(off?.1, "a")
        t.ok(r.next(ok: false, message: "a") == nil)
        t.eq(r.next(ok: false, message: "b")?.1, "b")
        t.eq(r.next(ok: true, message: nil)?.0, true)
    }

    t.test("a failed send goes again on retry, once") {
        var r = HotkeyReport()
        t.ok(r.retry(ok: false, message: "a") == nil, "nothing failed yet")
        _ = r.next(ok: false, message: "a")
        r.failed(ok: false, message: "a")
        t.ok(r.pending)
        t.eq(r.retry(ok: false, message: "a")?.1, "a")
        t.ok(r.retry(ok: false, message: "a") == nil, "sent, so not again")
        t.ok(r.next(ok: false, message: "a") == nil, "and not as a change either")
    }

    t.test("a stale failure does not undo a newer report") {
        var r = HotkeyReport()
        _ = r.next(ok: false, message: "a")
        _ = r.next(ok: true, message: nil)
        r.failed(ok: false, message: "a")
        t.ok(!r.pending)
        t.ok(r.next(ok: true, message: nil) == nil)
    }

    t.test("the words name the cause and the chord that still works") {
        let chord = MainActor.assumeIsolated { CapsuleApp.pretty("option+space") }
        t.eq(HotkeyReport.message(.noPermission, chord: chord),
             "Input Monitoring is off, so Control twice is off. ⌥Space still opens Lumen.")
        let none = HotkeyReport.message(.noPermission, chord: nil)
        t.ok(none.hasSuffix("No other hot key is set, so open Lumen from the menu bar."), none)
        t.ok(HotkeyReport.message(.tapDisabled, chord: "⌥Space").contains("could not be turned back on"))
        t.ok(HotkeyReport.message(.tapFailed, chord: "⌥Space").contains("would not let Lumen listen"))
    }
}
