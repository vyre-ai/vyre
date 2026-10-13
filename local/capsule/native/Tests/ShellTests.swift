// capsule-suite: shellSuite
// The Mac app is a thin shell: Lumen is off, the app opens one window (the shared web app), and the menu bar item is Open Vyre and Quit.

import AppKit

let shellSuite = Suite("thin shell") { t in
    t.test("Lumen is off unless the one flag says on") {
        t.ok(!Shell.lumenEnabled(env: [:]), "off by default")
        t.ok(!Shell.lumenEnabled(env: ["VYRE_LUMEN": "0"]))
        t.ok(!Shell.lumenEnabled(env: ["VYRE_LUMEN": ""]))
        t.ok(Shell.lumenEnabled(env: ["VYRE_LUMEN": "1"]))
    }

    t.test("the window is the no-local-vyred kind whenever no local vyred answers, on launch, on reopen and for Open Vyre alike") {
        t.ok(Shell.opensBoxless(vyredUp: false))
        t.ok(!Shell.opensBoxless(vyredUp: true))
    }

    t.test("the menu bar item has two commands, and its words are Vyre's, not Lumen's") {
        t.eq(Shell.menuTitles, ["Open Vyre", "Quit Vyre"])
        t.ok(!Shell.menuTitles.joined().contains("Lumen"))
    }

    t.test("the window and the web view start on the brand background, so nothing white shows while the page loads") {
        t.eq(Shell.brandBackgroundHex, "#0E0D0C")
        let c = Shell.brandBackground.usingColorSpace(.sRGB)!
        t.ok(abs(c.redComponent - 14.0 / 255) < 0.002 && abs(c.greenComponent - 13.0 / 255) < 0.002 && abs(c.blueComponent - 12.0 / 255) < 0.002)
    }

    t.test("the splash is the bundled piece when there is one, else the brand mark on the brand background") {
        let dir = vyScratch("splash-\(UUID().uuidString.prefix(6))")
        t.eq(Shell.splash(resources: dir), .brandMark)
        t.eq(Shell.splash(resources: nil), .brandMark)
        FileManager.default.createFile(atPath: dir + "/splash.html", contents: Data("<html></html>".utf8))
        t.eq(Shell.splash(resources: dir), .page(dir + "/splash.html"))
        try? FileManager.default.createDirectory(atPath: dir + "/app", withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: dir + "/app/splash.html", contents: Data("<html></html>".utf8))
        t.eq(Shell.splash(resources: dir), .page(dir + "/app/splash.html"), "the web build's own copy wins")
    }

    t.test("the splash fades once, when the page has loaded, and never before the splash has shown for a moment") {
        t.ok(Shell.fadeAfterMs(shownForMs: 0, loaded: false) == nil, "not loaded: no fade")
        t.ok((Shell.fadeAfterMs(shownForMs: 0, loaded: true) ?? 0) > 0, "loaded at once: wait a moment so it is not a flicker")
        t.eq(Shell.fadeAfterMs(shownForMs: 5000, loaded: true), 0)
    }
}
