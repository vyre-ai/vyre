// capsule-suite: windowsSuite
// Window layouts: the geometry, the coordinate flip, and moving a window through a fake accessibility
// layer. No real window is touched.

import AppKit
import Foundation

private final class FakeWindows: WindowAccess {
    var screens: [CGRect]
    var win: (id: String, frame: CGRect)?
    var set: [CGRect] = []
    var refuse = false
    init(screens: [CGRect], win: (id: String, frame: CGRect)?) { self.screens = screens; self.win = win }
    func focused(pid: Int32) -> (id: String, frame: CGRect)? { win }
    func setFrame(_ frame: CGRect, pid: Int32) -> Bool { if refuse { return false }; set.append(frame); win?.frame = frame; return true }
}

// A main display 1600x900 with a 24-point menu bar and a Dock of 60 at the bottom, and a second
// display to its right, 1200x800.
private let MAIN = CGRect(x: 0, y: 60, width: 1600, height: 816)
private let SIDE = CGRect(x: 1600, y: 100, width: 1200, height: 800)
private let FRONT = FrontApp(bundle: "com.example.notes", pid: 7, name: "Notes")

@MainActor private func run(_ p: WindowsProvider, _ l: WindowLayout, front: FrontApp? = FRONT) -> ActionOutcome {
    p.apply(l, front: front)
}

let windowsSuite = Suite("windows") { t in
    t.test("halves, quarters and thirds fill the visible frame exactly") {
        let v = CGRect(x: 0, y: 60, width: 1600, height: 816)
        t.eq(WindowLayout.leftHalf.frame(in: v), CGRect(x: 0, y: 60, width: 800, height: 816))
        t.eq(WindowLayout.rightHalf.frame(in: v), CGRect(x: 800, y: 60, width: 800, height: 816))
        t.eq(WindowLayout.topHalf.frame(in: v), CGRect(x: 0, y: 468, width: 1600, height: 408), "top is the larger y in AppKit")
        t.eq(WindowLayout.bottomHalf.frame(in: v), CGRect(x: 0, y: 60, width: 1600, height: 408))
        t.eq(WindowLayout.topRight.frame(in: v), CGRect(x: 800, y: 468, width: 800, height: 408))
        t.eq(WindowLayout.bottomLeft.frame(in: v), CGRect(x: 0, y: 60, width: 800, height: 408))
        t.eq(WindowLayout.maximize.frame(in: v), v)
        // Thirds tile with no gap and no overlap, even when the width does not divide.
        let odd = CGRect(x: 10, y: 0, width: 1000, height: 600)
        let thirds = [WindowLayout.leftThird, .centerThird, .rightThird].compactMap { $0.frame(in: odd) }
        t.eq(thirds.map(\.minX), [10, 343, 677]); t.eq(thirds.last?.maxX, odd.maxX)
        t.eq(WindowLayout.leftTwoThirds.frame(in: odd)?.width, 667)
        t.eq(WindowLayout.rightTwoThirds.frame(in: odd)?.maxX, odd.maxX)
        t.eq(WindowLayout.almostMaximize.frame(in: v), CGRect(x: 80, y: 101, width: 1440, height: 734))
        t.ok(WindowLayout.nextDisplay.frame(in: v) == nil && WindowLayout.restore.frame(in: v) == nil)
    }

    t.test("center keeps the size, and shrinks a window bigger than the screen") {
        let v = CGRect(x: 0, y: 60, width: 1600, height: 816)
        t.eq(WindowLayout.center.frame(in: v, current: CGRect(x: 5, y: 5, width: 600, height: 400)), CGRect(x: 500, y: 268, width: 600, height: 400))
        t.eq(WindowLayout.center.frame(in: v, current: CGRect(x: 0, y: 0, width: 3000, height: 2000)), v)
        t.ok(WindowLayout.center.frame(in: v) == nil)
    }

    t.test("the accessibility flip is its own inverse and puts the top at the top") {
        let r = CGRect(x: 100, y: 60, width: 800, height: 816)      // the left half of the screen above
        let ax = WindowLayout.flip(r, primaryHeight: 900)
        t.eq(ax, CGRect(x: 100, y: 24, width: 800, height: 816), "24 down from the top: the menu bar")
        t.eq(WindowLayout.flip(ax, primaryHeight: 900), r)
    }

    t.test("a window belongs to the screen it mostly sits on; one on no screen goes to the nearest") {
        let s = [MAIN, SIDE]
        t.eq(WindowLayout.screenIndex(of: CGRect(x: 1500, y: 200, width: 400, height: 300), in: s), 1, "300 of 400 points are on the side display")
        t.eq(WindowLayout.screenIndex(of: CGRect(x: 100, y: 100, width: 400, height: 300), in: s), 0)
        t.eq(WindowLayout.screenIndex(of: CGRect(x: 5000, y: 100, width: 400, height: 300), in: s), 1)
        t.eq(WindowLayout.screenIndex(of: .zero, in: []), nil)
    }

    t.test("moving to another display keeps the place and size in proportion, inside it") {
        let w = CGRect(x: 800, y: 60 + 408, width: 800, height: 408)      // top right quarter of MAIN
        let m = WindowLayout.move(w, from: MAIN, to: SIDE)
        t.eq(m.width, 600); t.eq(m.height, 400)
        t.ok(SIDE.contains(m), "\(m)")
        t.eq(m.maxX, SIDE.maxX); t.eq(m.maxY, SIDE.maxY)
        // A window bigger than the target is fitted, not left hanging out.
        let big = WindowLayout.move(CGRect(x: 0, y: 60, width: 1600, height: 816), from: MAIN, to: CGRect(x: 0, y: 0, width: 800, height: 500))
        t.eq(big.size, CGSize(width: 800, height: 500))
    }

    t.test("rows: 'left half', 'snap left', 'max' and 'next screen' find their layouts; other words find none") {
        let p = WindowsProvider(access: FakeWindows(screens: [MAIN], win: nil))
        func top(_ s: String) -> String? { p.resultsNow(for: Query(s)).first?.title }
        t.eq(top("left half"), "Left Half"); t.eq(top("snap left"), "Left Half"); t.eq(top("max"), "Maximize")
        t.eq(top("next screen"), "Next Display"); t.eq(top("top right"), "Top Right"); t.eq(top("restore"), "Restore")
        t.eq(p.resultsNow(for: Query("quarterly budget")).count, 0)
        t.eq(p.resultsNow(for: Query("le")).count, 0, "two letters find no layout")
        t.ok(p.resultsNow(for: Query("left")).count <= 4)
        t.eq(p.resultsNow(for: Query("left half")).first?.section, .windows)
    }

    t.test("Return moves the front window to the layout on its own screen, and the Notes window ends up there") {
        MainActor.assumeIsolated {
            let f = FakeWindows(screens: [MAIN, SIDE], win: ("7:1", CGRect(x: 1700, y: 200, width: 500, height: 400)))
            let p = WindowsProvider(access: f); p.allowed = { true }
            t.eq(run(p, .rightHalf), .close(nil))
            t.eq(f.set, [CGRect(x: 2200, y: 100, width: 600, height: 800)], "the right half of the SIDE display")
        }
    }

    t.test("restore puts it back; with nothing to restore it says so") {
        MainActor.assumeIsolated {
            let start = CGRect(x: 100, y: 100, width: 500, height: 400)
            let f = FakeWindows(screens: [MAIN], win: ("7:1", start))
            let p = WindowsProvider(access: f); p.allowed = { true }
            t.eq(run(p, .restore), .failed("Nothing to restore: the Capsule has not moved this window."))
            _ = run(p, .maximize)
            t.eq(f.win?.frame, MAIN)
            t.eq(run(p, .restore), .close(nil))
            t.eq(f.win?.frame, start)
        }
    }

    t.test("next display cycles; with one display it says so") {
        MainActor.assumeIsolated {
            let f = FakeWindows(screens: [MAIN, SIDE], win: ("7:1", CGRect(x: 0, y: 60, width: 800, height: 816)))
            let p = WindowsProvider(access: f); p.allowed = { true }
            t.eq(run(p, .nextDisplay), .close(nil))
            t.ok(SIDE.contains(f.win!.frame), "\(f.win!.frame)")
            t.eq(run(p, .nextDisplay), .close(nil))
            t.ok(MAIN.contains(f.win!.frame))
            t.eq(run(p, .previousDisplay), .close(nil))
            t.ok(SIDE.contains(f.win!.frame))
            let one = WindowsProvider(access: FakeWindows(screens: [MAIN], win: ("7:1", MAIN))); one.allowed = { true }
            t.eq(run(one, .nextDisplay), .failed("There is only one display."))
        }
    }

    t.test("failures are said in words: no app, no Accessibility, no window, a window that will not move") {
        MainActor.assumeIsolated {
            let f = FakeWindows(screens: [MAIN], win: ("7:1", MAIN))
            let p = WindowsProvider(access: f)
            p.allowed = { true }
            t.eq(run(p, .leftHalf, front: nil), .failed("There is no app in front to move."))
            p.allowed = { false }
            t.eq(run(p, .leftHalf), .failed("Allow Vyre under Privacy & Security, Accessibility, to move windows."))
            t.eq(f.set.count, 0)
            p.allowed = { true }
            f.win = nil
            t.eq(run(p, .leftHalf), .failed("Notes has no window to move."))
            f.win = ("7:1", MAIN); f.refuse = true
            t.eq(run(p, .leftHalf), .failed("Notes would not let its window move."))
        }
    }
}
